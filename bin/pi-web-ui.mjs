#!/usr/bin/env node
/**
 * pi-web-ui CLI.
 *
 *   pi-web-ui                              启动生产服务器（前台，Ctrl+C 停止）
 *   pi-web-ui --port 9000 --cwd /path      同上，覆盖端口 / 工作目录 / 数据目录
 *   pi-web-ui --version | --help
 *   pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
 *   pi-web-ui server uninstall [选项]       卸载系统服务
 *   pi-web-ui server start|stop|restart|status [选项]
 *
 * 系统服务：
 *   - macOS   → launchd 用户代理，label 默认 com.xingshuyin.pi-web-ui
 *              （--name 自定义时 com.<name>.server），无需 sudo
 *   - Linux   → systemd 单元 <name>.service（/etc/systemd/system/，自动 sudo）
 *   - Windows → 计划任务（Task Scheduler / schtasks，登录后自启，无需管理员），
 *              包装脚本与任务 XML 生成在 %APPDATA%\pi-web-ui\
 *
 * 环境变量（前台与系统服务均适用）：PORT / PI_WEB_CWD / PI_WEB_DATA_DIR /
 * PI_CODING_AGENT_DIR。
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** <pkg>/dist/server/index.js — the actual server entry. */
const SERVER_ENTRY = join(BIN_DIR, "..", "dist", "server", "index.js");
const NODE = process.execPath;
let pkg = { version: "0.0.0" };
try {
	pkg = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8"));
} catch {
	// version is best-effort — the server itself doesn't need it
}

const HELP = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

用法:
  pi-web-ui                               启动服务器（前台，Ctrl+C 停止）
  pi-web-ui --port 9000 --cwd /path       启动并指定端口 / 工作目录 / 数据目录
  pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
  pi-web-ui server uninstall [选项]       卸载系统服务
  pi-web-ui server start|stop|restart|status [选项]
  pi-web-ui --version / --help

server 选项:
  --port <n>        端口（默认 8787，或 $PORT）
  --cwd <dir>       工作目录（默认 $PI_WEB_CWD 或当前目录）
  --data-dir <dir>  会话数据目录（默认 <cwd>/.pi-web）
  --name <name>     服务名（默认 pi-web-ui；macOS 的 launchd label
                    为 com.xingshuyin.pi-web-ui，自定义名时为 com.<name>.server）
  --print           只打印将生成的配置文件，不实际安装

平台: macOS → launchd 用户代理 · Linux → systemd · Windows → 计划任务（schtasks）
      （Windows 任务登录后自启、无需管理员；stop 停止，uninstall 移除）

环境变量（前台与系统服务均适用）:
  PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_CODING_AGENT_DIR
`;

function fail(msg) {
	console.error(`✖ ${msg}`);
	process.exit(1);
}

/** Run a command, inheriting stdio; exits on failure unless ignoreError. */
function run(cmd, args, { ignoreError = false, silent = false } = {}) {
	const res = spawnSync(cmd, args, {
		stdio: silent ? ["inherit", "ignore", "ignore"] : "inherit",
	});
	if (!ignoreError && res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

/** Parse --flag value / --flag=value options; returns { opts, positionals }. */
function parseFlags(argv) {
	const opts = {
		port: undefined,
		cwd: undefined,
		dataDir: undefined,
		name: undefined,
		print: false,
		help: false,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			fail(`缺少选项 ${flag} 的值`);
		};
		switch (key) {
			case "--port":
				opts.port = take("--port");
				break;
			case "--cwd":
				opts.cwd = take("--cwd");
				break;
			case "--data-dir":
				opts.dataDir = take("--data-dir");
				break;
			case "--name":
				opts.name = take("--name");
				break;
			case "--print":
				opts.print = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) fail(`未知选项: ${key}`);
				positionals.push(a);
		}
	}
	return { opts, positionals };
}

// ---------------------------------------------------------------------------
// 前台启动
// ---------------------------------------------------------------------------

async function startForeground(opts) {
	if (opts.port) process.env.PORT = opts.port;
	if (opts.cwd) process.env.PI_WEB_CWD = resolve(opts.cwd);
	if (opts.dataDir) process.env.PI_WEB_DATA_DIR = resolve(opts.dataDir);
	await import(pathToFileURL(SERVER_ENTRY).href);
}

// ---------------------------------------------------------------------------
// 系统服务管理
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";

function uid() {
	try {
		return userInfo().uid;
	} catch {
		return process.getuid?.() ?? 501;
	}
}

/** launchd label / systemd unit name / Windows task name for a service name. */
function serviceLabel(name) {
	if (isMac) {
		return name === "pi-web-ui"
			? "com.xingshuyin.pi-web-ui"
			: `com.${name}.server`;
	}
	return name;
}

function launchAgentPlist(name) {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${serviceLabel(name)}.plist`,
	);
}

function systemdUnitPath(name) {
	return `/etc/systemd/system/${name}.service`;
}

/** Windows: per-user config dir (%APPDATA%\pi-web-ui) holding the .cmd wrapper + task XML. */
function winServiceDir() {
	return join(
		process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
		"pi-web-ui",
	);
}

function winCmdPath(name) {
	return join(winServiceDir(), `${name}.cmd`);
}

function winTaskXmlPath(name) {
	return join(winServiceDir(), `${name}.xml`);
}

function winLogPath() {
	return join(homedir(), "pi-web-ui.log");
}

/** True when a scheduled task with this name exists (schtasks exits 0). */
function winTaskExists(name) {
	return (
		spawnSync("schtasks", ["/Query", "/TN", name], { stdio: "ignore" })
			.status === 0
	);
}

/** Build the .cmd wrapper the scheduled task runs (set env → cd → launch node → log). */
function buildWinCmd(cwd, env, logPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `set "${k}=${v}"`)
		.join("\r\n");
	return [
		"@echo off",
		"rem Generated by: pi-web-ui server install (rerun to change)",
		sets,
		`cd /d "${cwd}"`,
		`"${NODE}" "${SERVER_ENTRY}" >> "${logPath}" 2>&1`,
		"",
	].join("\r\n");
}

/**
 * Build the Task Scheduler XML for a user task: LogonTrigger (starts at logon,
 * like a launchd agent — no admin needed), InteractiveToken, auto-restart on
 * failure. The task runs the .cmd wrapper via cmd.exe.
 */
function buildWinTaskXml(cmdPath, cwd) {
	const cmdExe = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"cmd.exe",
	);
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pi-web-ui — web chat for the pi coding agent (auto-start at logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(cmdExe)}</Command>
      <Arguments>/c ""${esc(cmdPath)}""</Arguments>
      <WorkingDirectory>${esc(cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function esc(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Build the launchd plist XML. */
function buildPlist(label, cwd, env) {
	const entries = Object.entries(env)
		.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by: pi-web-ui server install (do not edit by hand — rerun to change) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(SERVER_ENTRY)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${esc(cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/pi-web-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pi-web-ui.err</string>
</dict>
</plist>
`;
}

/** Build the systemd unit file. */
function buildUnit(cwd, env) {
	const envLines = Object.entries(env)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");
	return `# Generated by: pi-web-ui server install (do not edit by hand — rerun to change)
[Unit]
Description=pi-web-ui — web chat for the pi coding agent
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? userInfo().username}
WorkingDirectory=${cwd}
${envLines}
ExecStart=${JSON.stringify(NODE)} ${JSON.stringify(SERVER_ENTRY)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** If not root on Linux, re-exec the same server command through sudo. */
function ensureRootForSystemctl() {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	// process.argv = [node, <bin>, "server", <action>, ...rest] — forward
	// everything after "server" so flags like --port/--cwd survive.
	const res = spawnSync(
		"sudo",
		[NODE, fileURLToPath(import.meta.url), "server", ...process.argv.slice(3)],
		{ stdio: "inherit" },
	);
	process.exit(res.status ?? 1);
}

/** Shared option normalization for install. */
function serviceOptions(opts) {
	const name = opts.name ?? "pi-web-ui";
	const port = String(opts.port ?? process.env.PORT ?? "8787");
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		fail(`无效端口: ${port}`);
	}
	const cwd = resolve(opts.cwd ?? process.env.PI_WEB_CWD ?? process.cwd());
	if (!existsSync(cwd)) fail(`工作目录不存在: ${cwd}`);
	let dataDir;
	if (opts.dataDir) {
		dataDir = resolve(opts.dataDir);
	} else if (process.env.PI_WEB_DATA_DIR) {
		dataDir = resolve(process.env.PI_WEB_DATA_DIR);
	}
	return { name, port, cwd, dataDir };
}

function serviceEnv(port, cwd, dataDir) {
	const env = {
		PORT: port,
		PI_WEB_CWD: cwd,
	};
	// Interactive Windows tasks inherit the user's PATH; only systemd/launchd
	// run with a minimal environment that needs an explicit PATH.
	if (!isWin) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	if (dataDir) env.PI_WEB_DATA_DIR = dataDir;
	return env;
}

function installLaunchd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	const content = buildPlist(label, cwd, serviceEnv(port, cwd, dataDir));
	if (opts.print) {
		console.log(`# ${plist}\n${content}`);
		return;
	}
	// Unload any existing instance (ignore "not loaded"), then (re)install.
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, content);
	run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
	console.log(`✅ 已安装并启动 launchd 服务 ${label}`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err`);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
}

function installSystemd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const content = buildUnit(cwd, serviceEnv(port, cwd, dataDir));
	const unitPath = systemdUnitPath(name);
	if (opts.print) {
		console.log(`# ${unitPath}\n${content}`);
		return;
	}
	ensureRootForSystemctl();
	writeFileSync(unitPath, content);
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["enable", "--now", `${name}.service`]);
	console.log(`✅ 已安装并启动 systemd 服务 ${name}.service`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : journalctl -u ${name}.service -f`);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
}

function uninstallLaunchd(opts) {
	const name = opts.name ?? "pi-web-ui";
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	if (existsSync(plist)) rmSync(plist);
	console.log(`🗑  已卸载 ${label}（plist 已删除，不再开机自启）`);
}

function uninstallSystemd(opts) {
	const name = opts.name ?? "pi-web-ui";
	ensureRootForSystemctl();
	run("systemctl", ["disable", "--now", `${name}.service`], {
		ignoreError: true,
	});
	const unitPath = systemdUnitPath(name);
	if (existsSync(unitPath)) rmSync(unitPath);
	run("systemctl", ["daemon-reload"]);
	console.log(`🗑  已卸载 ${name}.service（不再开机自启）`);
}

function installWindows(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir);
	const cmdPath = winCmdPath(name);
	const xmlPath = winTaskXmlPath(name);
	const cmd = buildWinCmd(cwd, env, winLogPath());
	const xml = buildWinTaskXml(cmdPath, cwd);
	if (opts.print) {
		console.log(`# ${cmdPath}\n${cmd}`);
		console.log(`# ${xmlPath}\n${xml}`);
		return;
	}
	mkdirSync(dirname(cmdPath), { recursive: true });
	writeFileSync(cmdPath, cmd);
	// schtasks /Create /XML requires a UTF-16 file (with BOM).
	writeFileSync(xmlPath, "\uFEFF" + xml, "utf16le");
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	run("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"]);
	run("schtasks", ["/Run", "/TN", name], { ignoreError: true });
	console.log(`✅ 已安装并启动计划任务 ${name}`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : ${winLogPath()}`);
	console.log(
		`   说明 : 登录后自启（与 launchd 用户代理一致）；stop 停止，uninstall 移除`,
	);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
}

function uninstallWindows(opts) {
	const name = opts.name ?? "pi-web-ui";
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], { ignoreError: true });
	}
	for (const f of [winCmdPath(name), winTaskXmlPath(name)]) {
		if (existsSync(f)) rmSync(f);
	}
	console.log(`🗑  已卸载 ${name}（计划任务已删除，不再自启）`);
}

function controlService(action, opts) {
	const name = opts.name ?? "pi-web-ui";

	if (isMac) {
		const label = serviceLabel(name);
		const target = `gui/${uid()}/${label}`;
		const loaded = () =>
			spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status ===
			0;

		if (action === "status") {
			if (loaded()) {
				const res = spawnSync("launchctl", ["print", target], {
					encoding: "utf8",
				});
				const state = (res.stdout.match(/state = (\w+)/) ?? [])[1] ?? "loaded";
				console.log(`${label}: ${state}（已加载，开机自启中）`);
			} else {
				console.log(`${label}: 未安装（运行 pi-web-ui server install 安装）`);
			}
			return;
		}

		if (action === "start") {
			if (loaded()) {
				run("launchctl", ["kickstart", target]);
			} else {
				const plist = launchAgentPlist(name);
				if (!existsSync(plist)) {
					fail(`找不到 ${plist}，请先运行 pi-web-ui server install`);
				}
				run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
			}
			console.log(`✅ 已启动 ${label}`);
			return;
		}

		if (action === "restart") {
			if (!loaded()) fail(`${label} 未加载，请先 pi-web-ui server start`);
			run("launchctl", ["kickstart", "-k", target]);
			console.log(`✅ 已重启 ${label}`);
			return;
		}

		if (action === "stop") {
			run("launchctl", ["bootout", target], {
				ignoreError: true,
				silent: true,
			});
			console.log(`⏹  已停止 ${label}（已卸载，不再开机自启；start 恢复）`);
			return;
		}

		fail(`未知操作: ${action}`);
	}

	if (isLinux) {
		ensureRootForSystemctl();
		if (action === "status") {
			run("systemctl", ["status", `${name}.service`, "--no-pager"]);
			return;
		}
		run("systemctl", [action, `${name}.service`]);
		console.log(`✅ ${action} ${name}.service`);
		return;
	}

	if (isWin) {
		const exists = winTaskExists(name);

		if (action === "status") {
			if (!exists) {
				console.log(`${name}: 未安装（运行 pi-web-ui server install 安装）`);
				return;
			}
			// Get-ScheduledTask outputs English state enums — locale-independent,
			// unlike `schtasks /Query` tables on localized Windows.
			const ps = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$t=Get-ScheduledTask -TaskName '" +
						name +
						"' -ErrorAction SilentlyContinue;" +
						"if(!$t){'NOT_INSTALLED';exit}" +
						"$i=$t|Get-ScheduledTaskInfo;" +
						"'State: '+$t.State;" +
						"'LastRunTime: '+$i.LastRunTime;" +
						"'LastTaskResult: '+$i.LastTaskResult",
				],
				{ encoding: "utf8" },
			);
			if (ps.status !== 0 || (ps.stdout ?? "").includes("NOT_INSTALLED")) {
				console.log(`${name}: 未安装（运行 pi-web-ui server install 安装）`);
				return;
			}
			console.log(`${name}: 计划任务\n${(ps.stdout ?? "").trim()}`);
			return;
		}

		if (action === "start") {
			if (!exists) fail(`${name} 不存在，请先运行 pi-web-ui server install`);
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ 已启动 ${name}`);
			return;
		}

		if (action === "restart") {
			if (!exists) fail(`${name} 不存在，请先运行 pi-web-ui server install`);
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ 已重启 ${name}`);
			return;
		}

		if (action === "stop") {
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			console.log(`⏹  已停止 ${name}（自启保留；uninstall 移除）`);
			return;
		}

		fail(`未知操作: ${action}`);
	}

	fail(
		`不支持的系统服务平台: ${process.platform}（仅 macOS / Linux / Windows）`,
	);
}

async function serverCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) {
		console.log(HELP);
		console.log("--- 当前服务状态 ---");
		controlService("status", opts);
		return;
	}
	const action = positionals[0];
	if (positionals.length > 1)
		fail(`多余的参数: ${positionals.slice(1).join(" ")}`);
	switch (action) {
		case "install": {
			if (isMac) {
				installLaunchd(opts);
			} else if (isLinux) {
				installSystemd(opts);
			} else if (isWin) {
				installWindows(opts);
			} else {
				fail(`不支持的系统服务平台: ${process.platform}`);
			}
			break;
		}
		case "uninstall": {
			if (isMac) {
				uninstallLaunchd(opts);
			} else if (isLinux) {
				uninstallSystemd(opts);
			} else if (isWin) {
				uninstallWindows(opts);
			} else {
				fail(`不支持的系统服务平台: ${process.platform}`);
			}
			break;
		}
		case "start":
		case "stop":
		case "restart":
		case "status":
			controlService(action, opts);
			break;
		default:
			fail(
				`未知操作: ${action}（install / uninstall / start / stop / restart / status）`,
			);
	}
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await startForeground({});
		return;
	}
	const first = argv[0];
	if (first === "--version" || first === "-v") {
		console.log(pkg.version);
		return;
	}
	if (first === "--help" || first === "-h") {
		console.log(HELP);
		return;
	}
	if (first === "server") {
		await serverCmd(argv.slice(1));
		return;
	}
	// One-shot server with optional --port/--cwd/--data-dir overrides.
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length > 0)
		fail(`未知命令: ${positionals[0]}（--help 查看用法）`);
	await startForeground(opts);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
