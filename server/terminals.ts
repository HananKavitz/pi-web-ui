/**
 * TerminalManager — per-client PTY sessions (node-pty) bridged over the
 * WebSocket protocol, plus the user command list persisted in
 * `<workspaceRoot>/.pi/commands.json`.
 *
 * Each browser client gets its own manager; terminals are shared across that
 * client's tabs (they broadcast through the session's emit). When the last
 * socket for a client detaches, all its PTYs are killed so no orphaned
 * processes survive a closed tab / dropped connection.
 *
 * Commands file format:
 *   { "commands": [ { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" } ] }
 * `${pwd}` inside cwd/command resolves to the agent session's current working
 * directory (the same directory the agent operates in — see set_cwd).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { CommandDef, ServerMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// .pi/commands.json
// ---------------------------------------------------------------------------

export interface CommandsFile {
	commands: CommandDef[];
}

/** Location of the command list for a project: <workspaceRoot>/.pi/commands.json */
export function commandsFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".pi", "commands.json");
}

/** Expand ${pwd} (and ~) in a cwd/command string against the session's cwd. */
export function expandPwd(input: string, pwd: string): string {
	let out = input.replace(/\$\{pwd\}/g, pwd);
	if (out === "~") return homedir();
	if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	return out;
}

/** Resolve a command's directory: default to the session cwd, expand ${pwd}/~, resolve relative paths. */
export function resolveCommandCwd(
	cwd: string | undefined,
	pwd: string,
): string {
	if (!cwd || cwd.trim() === "") return pwd;
	const expanded = expandPwd(cwd.trim(), pwd);
	return isAbsolute(expanded) ? expanded : resolve(pwd, expanded);
}

/** Read the command list; missing file → empty list; malformed → empty list + warning text. */
export async function loadCommands(
	workspaceRoot: string,
): Promise<{ commands: CommandDef[]; path: string; warning?: string }> {
	const path = commandsFilePath(workspaceRoot);
	const { commands, warning } = await readCommandsFile(path);
	return { commands, path, warning };
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `读取命令文件失败：${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { commands: [], warning: `命令文件不是有效 JSON：${path}` };
	}
	if (Array.isArray(parsed)) {
		// Tolerate a bare array: [{name, command, cwd}]
		return {
			commands: parsed
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) {
		return {
			commands: obj.commands
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	return { commands: [], warning: `命令文件格式不正确：${path}` };
}

/** Persist the command list, creating .pi/ if needed. */
export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
): Promise<{ path: string; error?: string }> {
	const path = commandsFilePath(workspaceRoot);
	try {
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
		return { path };
	} catch (err) {
		return { path, error: `保存命令文件失败：${(err as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

interface TermEntry {
	id: string;
	pty: IPty;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	exited: boolean;
}

const isWindows = process.platform === "win32";
/**
 * Interactive shell for PTYs. Windows has no $SHELL: use Git Bash if the user
 * has it, otherwise the console host from $COMSPEC (always set → cmd.exe).
 * POSIX uses the user's login shell, falling back to bash.
 */
const SHELL = isWindows
	? process.env.SHELL || process.env.COMSPEC || "powershell.exe"
	: process.env.SHELL || "bash";
/** `-i` is POSIX-only; cmd.exe / powershell.exe start interactively on their own. */
const SHELL_ARGS: string[] = isWindows ? [] : ["-i"];

/**
 * Owns one or more PTYs for a client. All output is forwarded as
 * `terminal_output` messages through the provided emit (broadcast to every
 * socket of the client). Returns false from create/runCommand when the spawn
 * failed (an error notice + terminal_exit are emitted instead).
 */
export class TerminalManager {
	private terms = new Map<string, TermEntry>();
	private seq = 0;

	constructor(private emit: (msg: ServerMessage) => void) {}

	/** Start a plain interactive shell in the given directory. */
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
	): void {
		if (this.terms.has(id)) return;
		this.spawnShell(id, cwd || fallbackCwd, cols, rows, `终端 ${++this.seq}`);
	}

	/**
	 * Start a shell in the command's directory and run the command in it.
	 *
	 * If a terminal with this id already exists it is RESTARTED in place: the
	 * running process is killed and a fresh shell runs the command again in the
	 * same terminal (used when re-running a command by clicking its entry).
	 */
	runCommand(
		id: string,
		def: CommandDef,
		cols: number,
		rows: number,
		pwd: string,
	): void {
		const dir = resolveCommandCwd(def.cwd, pwd);
		const command = expandPwd(def.command.trim(), pwd);
		const title = def.name || command || `终端 ${++this.seq}`;

		const existing = this.terms.get(id);
		if (existing) {
			// Re-run in place: interrupt the current process (kill the PTY's
			// process group) and start a fresh shell with the same id. Keep the
			// last known size so the replacement matches the xterm's dimensions.
			if (!existing.exited) {
				existing.exited = true;
				try {
					existing.pty.kill();
				} catch {
					// already dead
				}
			}
			cols = existing.cols || cols;
			rows = existing.rows || rows;
			this.terms.delete(id);
		}

		const ok = this.spawnShell(id, dir, cols, rows, title);
		if (!ok) return;
		// Clear the previous run's output, then show a banner and run the command
		// (the PTY input buffer holds it until the shell is ready).
		this.writeOut(id, "\x1b[2J\x1b[3J\x1b[H");
		this.writeOut(
			id,
			`\x1b[90m> ${command}\x1b[0m  \x1b[90m(${dir})\x1b[0m\r\n`,
		);
		if (command) this.input(id, command + "\r");
	}

	/** Spawn the user's shell as a PTY. Returns false when the spawn failed. */
	private spawnShell(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
	): boolean {
		let abs = cwd;
		if (!abs) abs = homedir();
		else if (!isAbsolute(abs)) abs = resolve(abs);
		if (!existsSync(abs)) {
			this.fail(id, `目录不存在：${abs}`);
			return false;
		}
		let pty: IPty;
		try {
			pty = spawn(SHELL, SHELL_ARGS, {
				name: "xterm-256color",
				cols: Math.max(2, Math.floor(cols) || 80),
				rows: Math.max(2, Math.floor(rows) || 24),
				cwd: abs,
				env: { ...process.env, TERM: "xterm-256color" },
			});
		} catch (err) {
			this.fail(id, `启动终端失败：${(err as Error).message}`);
			return false;
		}
		const entry: TermEntry = {
			id,
			pty,
			title,
			cwd: abs,
			cols: Math.max(2, Math.floor(cols) || 80),
			rows: Math.max(2, Math.floor(rows) || 24),
			exited: false,
		};
		this.terms.set(id, entry);
		// The closures capture `entry`: after a restart the map points at the
		// replacement, so a late event from the OLD pty must be ignored.
		pty.onData((data) => {
			if (this.terms.get(id) !== entry) return;
			this.writeOut(id, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry) return;
			this.exit(id, exitCode);
		});
		return true;
	}

	private writeOut(id: string, data: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	/** Emit a terminal failure (bad cwd, spawn error) and mark the terminal dead. */
	private fail(id: string, text: string): void {
		this.emit({ type: "notice", level: "error", text });
		this.emit({
			type: "terminal_output",
			terminalId: id,
			data: `\x1b[91m${text}\x1b[0m\r\n`,
		});
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}

	private exit(id: string, exitCode: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.exited = true;
		this.writeOut(
			id,
			`\r\n\x1b[90m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`,
		);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode });
	}

	input(id: string, data: string): void {
		const entry = this.terms.get(id);
		if (entry && !entry.exited) entry.pty.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		try {
			entry.pty.resize(
				Math.max(2, Math.floor(cols) || 80),
				Math.max(2, Math.floor(rows) || 24),
			);
			// Remember the size so an in-place restart spawns at the same dims.
			entry.cols = Math.max(2, Math.floor(cols) || 80);
			entry.rows = Math.max(2, Math.floor(rows) || 24);
		} catch {
			// PTY already gone — nothing to do.
		}
	}

	/** Kill one terminal (tab closed). The exit event is emitted by node-pty. */
	kill(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.exited = true;
		try {
			entry.pty.kill();
		} catch {
			// already dead
		}
		this.terms.delete(id);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}

	/** Kill every terminal of this client (disconnect / dispose). */
	killAll(): void {
		for (const entry of this.terms.values()) {
			if (entry.exited) continue;
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
		}
		this.terms.clear();
	}
}
