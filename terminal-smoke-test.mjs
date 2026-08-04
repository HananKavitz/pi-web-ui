/* Smoke test: boots the real (compiled) server and exercises the terminal +
 * commands protocol over WebSocket (no browser needed).
 * Run:  npm run build:server && node terminal-smoke-test.mjs */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 20000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-term-"));
process.env.PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(
	process.execPath,
	[join(new URL(".", import.meta.url).pathname, "dist", "server", "index.js")],
	{
		cwd: new URL(".", import.meta.url).pathname,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true, // own process group so we can kill the whole tree
	},
);
server.on("error", (e) => console.error("[srv spawn error]", e));
server.on("exit", (code) => console.error(`[srv exited early: ${code}]`));
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

const outputs = new Map(); // terminalId -> accumulated text
const exits = new Map(); // terminalId -> exitCode
let commandsReply = null;
let sessionsReply = null; // sessions list
const notices = []; // notice texts from the server

async function main() {
	await waitServer();
	console.log("server up");

	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const open = new Promise((res, rej) => {
		ws.on("open", res);
		ws.on("error", rej);
	});
	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.type === "terminal_output") {
			outputs.set(
				msg.terminalId,
				(outputs.get(msg.terminalId) ?? "") + msg.data,
			);
		}
		if (msg.type === "terminal_exit") exits.set(msg.terminalId, msg.exitCode);
		if (msg.type === "commands") commandsReply = msg;
		if (msg.type === "sessions") sessionsReply = msg.sessions;
		if (msg.type === "notice") notices.push(msg.text);
	});
	const send = (m) => ws.send(JSON.stringify(m));

	await open;
	console.log("ws connected");

	send({ type: "hello", clientId: "smoke-test-client" });

	await new Promise((res, rej) => {
		const timer = setTimeout(
			() => rej(new Error("timed out waiting for ready")),
			30000,
		);
		ws.on("message", (d) => {
			try {
				if (JSON.parse(d.toString()).type === "ready") {
					clearTimeout(timer);
					res();
				}
			} catch {
				/* ignore */
			}
		});
	});
	console.log("ready received");

	// -- commands: list (fresh dir -> empty), save, list again -----------------
	send({ type: "list_commands" });
	await sleep(400);
	check(
		"list_commands returns empty list",
		commandsReply?.commands?.length === 0,
	);
	check(
		"commands path is <cwd>/.pi/commands.json",
		commandsReply?.path === join(workdir, ".pi", "commands.json"),
	);

	send({
		type: "save_commands",
		commands: [
			{ name: "dev", command: "echo DEV && ls", cwd: "${pwd}" },
			{ name: "pwd-test", command: "pwd", cwd: "${pwd}/sub" },
		],
	});
	await sleep(400);
	check("save_commands persisted", commandsReply?.commands?.length === 2);
	const { readFileSync, existsSync } = await import("node:fs");
	check(
		"commands.json written on disk",
		existsSync(join(workdir, ".pi", "commands.json")),
	);
	let onDisk = null;
	try {
		onDisk = JSON.parse(
			readFileSync(join(workdir, ".pi", "commands.json"), "utf8"),
		);
	} catch {
		onDisk = null;
	}
	check(
		"disk format is {commands:[...]}",
		onDisk !== null &&
			Array.isArray(onDisk.commands) &&
			onDisk.commands[0].name === "dev",
	);

	// -- folder attachment: a directory is accepted (not skipped as a non-file) --
	// Full end-to-end (the <folder path> card in the transcript) requires a real
	// model turn; here we verify the server takes the folder branch instead of
	// the old "跳过非文件附件" skip path, and that no path error is emitted.
	{
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(workdir, "subdir"), { recursive: true });
		send({
			type: "prompt",
			text: "list this folder",
			attachments: [{ path: "subdir", mode: "reference" }],
		});
		await sleep(1500);
		check(
			"folder not skipped as a non-file attachment",
			!notices.some(
				(t) => t.includes("跳过非文件附件") && t.includes("subdir"),
			),
		);
		check(
			"no attachment error for the folder",
			!notices.some(
				(t) => t.includes("附件") && t.includes("subdir") && t.includes("失败"),
			),
		);
	}

	// -- TUI sessions: conversations from the pi CLI must appear in the list --
	// The CLI stores sessions in <agentDir>/sessions/--<cwd-sanitized>--; fabricate
	// one there and check list_sessions merges it in with source "tui".
	{
		const { homedir } = await import("node:os");
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const safePath = `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const tuiDir = join(homedir(), ".pi", "agent", "sessions", safePath);
		const tuiFile = join(
			tuiDir,
			"2026-08-04T00-00-00-000Z_tui-smoke-test.jsonl",
		);
		mkdirSync(tuiDir, { recursive: true });
		writeFileSync(
			tuiFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "tui-smoke-test",
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd: workdir,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "TUI 会话标题" }],
						timestamp: 1722700801000,
					},
				}),
			].join("\n") + "\n",
		);
		// Clean up the fabricated session on exit (best effort).
		process.on("exit", () => {
			try {
				rmSync(tuiFile, { force: true });
				rmSync(tuiDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});
		send({ type: "list_sessions" });
		await sleep(1000);
		check(
			"TUI session appears in the conversation list",
			sessionsReply?.some(
				(s) =>
					s.path === tuiFile &&
					s.source === "tui" &&
					s.firstMessage === "TUI 会话标题",
			) ?? false,
		);
	}

	// -- plain terminal --------------------------------------------------------
	const t1 = "t-1";
	send({
		type: "terminal_create",
		terminalId: t1,
		cwd: workdir,
		cols: 80,
		rows: 24,
	});
	await sleep(600);
	check("shell produced output", (outputs.get(t1) ?? "").length > 0);
	send({ type: "terminal_input", terminalId: t1, data: "echo WS_ECHO_OK\r" });
	await sleep(800);
	check(
		"input echoes through PTY",
		(outputs.get(t1) ?? "").includes("WS_ECHO_OK"),
	);

	send({ type: "terminal_resize", terminalId: t1, cols: 100, rows: 40 });
	await sleep(200);

	// -- run_command with ${pwd} ----------------------------------------------
	const t2 = "t-2";
	send({
		type: "run_command",
		terminalId: t2,
		command: { name: "dev", command: "echo WS_CMD_OK", cwd: "${pwd}" },
		cols: 80,
		rows: 24,
	});
	await sleep(1200);
	check(
		"run_command banner shown",
		(outputs.get(t2) ?? "").includes("WS_CMD_OK"),
	);

	// ${pwd} resolves to session cwd (= workspace root here)
	send({ type: "terminal_input", terminalId: t2, data: "pwd\r" });
	await sleep(600);
	check(
		"${pwd} resolved to session cwd",
		(outputs.get(t2) ?? "").includes(workdir),
	);

	// -- re-run: run_command on an existing terminal restarts it in place ------
	send({
		type: "run_command",
		terminalId: t2,
		command: { name: "dev", command: "echo WS_CMD_RERUN", cwd: "${pwd}" },
		cols: 80,
		rows: 24,
	});
	await sleep(1200);
	const t2out = outputs.get(t2) ?? "";
	check("re-run banner appears", t2out.includes("> echo WS_CMD_RERUN"));
	check("re-run executed", t2out.includes("WS_CMD_RERUN"));
	// The replacement shell must accept input (a live PTY, not the killed one).
	send({
		type: "terminal_input",
		terminalId: t2,
		data: "echo WS_AFTER_RERUN\r",
	});
	await sleep(600);
	check(
		"restarted shell accepts input",
		(outputs.get(t2) ?? "").includes("WS_AFTER_RERUN"),
	);

	// -- kill / exit -----------------------------------------------------------
	send({ type: "terminal_kill", terminalId: t1 });
	await sleep(400);
	check("terminal_kill emits exit", exits.has(t1));

	send({ type: "terminal_input", terminalId: t2, data: "exit\r" });
	await sleep(600);
	check("shell exit emits terminal_exit", exits.has(t2));

	// unknown terminal input must not crash
	send({ type: "terminal_input", terminalId: "nope", data: "x" });
	send({ type: "terminal_resize", terminalId: "nope", cols: 10, rows: 10 });
	await sleep(200);
	check("server still alive after bogus messages", true);

	ws.close();
	await sleep(300);
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

process.on("unhandledRejection", (err) => {
	console.error("UNHANDLED REJECTION:", err);
	process.exitCode = 1;
});

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exitCode = 1;
	process.exit(1);
});

// Ensure the spawned server dies even on early crashes.
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* already gone */
	}
});
