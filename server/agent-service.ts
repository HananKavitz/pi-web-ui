/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime with a private session directory, so multiple users /
 * tabs never share a transcript file.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	CommandDef,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiProviderConfig,
	UiState,
} from "./protocol.js";
import {
	serializeMessage,
	serializeStreamingMessage,
	type AgentMessage,
} from "./serialize.js";
import {
	loadCommands,
	saveCommandsFile,
	TerminalManager,
} from "./terminals.js";

const SNAPSHOT_INTERVAL_MS = 60;
const WIDGET_REFRESH_MS = 2000;
const WIDGET_WIDTH = 80;

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

/** Mock theme: TUI color functions degrade to identity so widget text survives. */
const mockTheme = new Proxy(
	{
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
		dim: (text: string) => text,
	},
	{
		get(target, prop) {
			if (prop in target)
				return (target as Record<string, unknown>)[prop as string];
			// Unknown theme methods → no-op passthrough.
			return (_arg: unknown, text?: unknown) =>
				text !== undefined ? text : "";
		},
	},
) as unknown as Theme;

/** Mock TUI: any method call is a safe no-op. */
const mockTui = new Proxy(
	{
		requestRender: () => {},
		render: () => {},
	},
	{
		get(target, prop) {
			if (prop in target)
				return (target as Record<string, unknown>)[prop as string];
			return () => {};
		},
	},
);

interface WidgetEntry {
	/** Renders the widget to plain text lines, or undefined when empty. */
	render: (width: number) => string[] | undefined;
	/** Whether the widget can be disposed. */
	dispose?: () => void;
}

/**
 * Implements the subset of ExtensionUIContext that makes sense for a web UI.
 * TUI-only affordances (select/confirm/input dialogs, terminal input, custom
 * footer) are inert: dialogs resolve to cancellation instead of blocking.
 */
export class WebUIContext {
	readonly theme = mockTheme;
	private widgets = new Map<string, WidgetEntry>();
	private lastLines = new Map<string, string[]>();
	private emit: (msg: ServerMessage) => void;

	constructor(emit: (msg: ServerMessage) => void) {
		this.emit = emit;
	}

	// -- widgets -------------------------------------------------------------

	/** Matches ExtensionUIContext's overloaded setWidget exactly. */
	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		void options;
		if (content === undefined) {
			this.widgets.delete(key);
			this.lastLines.delete(key);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp:
				| { render?: (w: number) => string[] | undefined; dispose?: () => void }
				| undefined;
			try {
				// Mock TUI/theme: extensions only read a handful of theme helpers;
				// everything else is a no-op, so the widget renders to plain text.
				comp = content(mockTui as never, mockTheme as never) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.set(key, {
				render: (w) => comp?.render?.(w),
				dispose: comp?.dispose,
			});
		} else {
			this.widgets.set(key, { render: () => content });
		}
		this.push();
	};

	/** Re-render all widgets and push when content changed (polled + on demand). */
	refresh(): void {
		let changed = false;
		for (const [key, w] of this.widgets) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(key);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(key, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private push(): void {
		const widgets = this.snapshot();
		this.emit({ type: "widgets", widgets });
	}

	/** Render all widgets to their current text lines (without emitting). */
	snapshot(): { key: string; lines: string[] }[] {
		return [...this.widgets.entries()].map(([key, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			this.lastLines.set(key, lines ?? []);
			return { key, lines: lines ?? [] };
		});
	}

	// -- notifications --------------------------------------------------------

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.emit({ type: "notice", level: type ?? "info", text: message });
	}

	// -- footer status (pi-lens "LSP Inactive", pi-cache-optimizer cache stats) --

	private statuses = new Map<string, string>();

	setStatus(key: string, text: string | undefined): void {
		if (text === undefined || text === "") {
			this.statuses.delete(key);
		} else {
			this.statuses.set(key, text);
		}
		this.pushStatuses();
	}

	private pushStatuses(): void {
		this.emit({
			type: "statuses",
			statuses: [...this.statuses.entries()].map(([k, v]) => ({
				key: k,
				text: v,
			})),
		});
	}

	/** Current footer status entries (for replay on socket attach). */
	statusSnapshot(): { key: string; text: string | undefined }[] {
		return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
	}

	// -- dialogs (select/confirm/input bridged to the browser) ---------------

	private dialogSeq = 0;
	private pendingDialogs = new Map<
		number,
		(value: string | boolean | null) => void
	>();

	select = (title: string, options: string[]): Promise<string | undefined> =>
		this.openDialog("select", title, [options]) as Promise<string | undefined>;
	confirm = (title: string, message: string): Promise<boolean> =>
		this.openDialog("confirm", title, [message]) as Promise<boolean>;
	input = (title: string, placeholder?: string): Promise<string | undefined> =>
		this.openDialog("input", title, [placeholder ?? ""]) as Promise<
			string | undefined
		>;

	private openDialog(
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
	): Promise<string | boolean | null> {
		return new Promise((resolve) => {
			const id = ++this.dialogSeq;
			this.pendingDialogs.set(id, resolve);
			this.emit({ type: "dialog", id, kind, title, args });
		});
	}

	/** Resolve a pending dialog with the user's choice (called from the client). */
	resolveDialog(id: number, value: string | boolean | null): void {
		const resolve = this.pendingDialogs.get(id);
		if (resolve) {
			this.pendingDialogs.delete(id);
			resolve(value);
			this.emit({ type: "dialog_closed", id });
		}
	}

	// -- inert TUI-only affordances ------------------------------------------

	onTerminalInput = (): (() => void) => () => {};
	setWorkingMessage = (): void => {};
	setWorkingVisible = (): void => {};
	setWorkingIndicator = (): void => {};
	setHiddenThinkingLabel = (): void => {};
	setFooter = (): void => {};
	setHeader = (): void => {};
	setTitle = (): void => {};
	custom = <T>(_factory: unknown, _done?: unknown): Promise<T> =>
		new Promise<T>(() => {});
	pasteToEditor = (): void => {};
	setEditorText = (): void => {};
	getEditorText = (): string => "";
	editor = async (): Promise<string | undefined> => undefined;
	addAutocompleteProvider = (): void => {};
	setEditorComponent = (): void => {};
	getEditorComponent = (): undefined => undefined;
	getAllThemes = (): { name: string; path: string | undefined }[] => [];
	getTheme = (): undefined => undefined;
	setTheme = (): { success: boolean; error?: string } => ({ success: false });
	getToolsExpanded = (): boolean => false;
	setToolsExpanded = (): void => {};

	/** Dispose all widgets (extension reload / session teardown). */
	dispose(): void {
		for (const w of this.widgets.values()) {
			try {
				w.dispose?.();
			} catch {
				// best effort
			}
		}
		this.widgets.clear();
		this.lastLines.clear();
		// Cancel any pending dialogs.
		for (const [id, resolve] of this.pendingDialogs) {
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
		this.pendingDialogs.clear();
	}
}

/** Sanitize a clientId (UUID) for use as a directory name. */
function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "anon";
}

const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
]);

function countLines(buf: Buffer): number {
	let lines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 10 /* \n */) lines++;
	}
	return lines + (buf.length > 0 ? 1 : 0);
}

function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)
		?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) =>
				(c as { type?: string; text?: string })?.type === "text"
					? (c as { text: string }).text
					: "",
			)
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

export class ClientSession {
	readonly clientId: string;
	cwd: string;
	/** Immutable workspace root the commands file (.pi/commands.json) is anchored to. */
	readonly workspaceRoot: string;
	/** Absolute per-client session directory. */
	readonly sessionDir: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;

	/** PTY terminals for this client (killed when the last socket detaches). */
	readonly terminals = new TerminalManager((msg) => this.emit(msg));

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext((msg) => this.emit(msg));
	private widgetsTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private unsubscribe?: () => void;
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/**
	 * Stable per-message ids: assigned once per (role, timestamp) so snapshot ids
	 * don't change every 60ms — changing ids would remount the whole list in
	 * React (collapse open thinking blocks, reset scroll, jank on long chats).
	 */
	private msgIds = new Map<string, number>();
	private nextMsgId = 1;
	/** Serialized UiMessage cache — object-reference-stable across snapshots, so
	 *  the frontend's React.memo can skip unchanged messages entirely. */
	private uiMessageCache = new Map<string, UiMessage>();
	/** Reused when the message set didn't change, keeping state.messages
	 *  reference-stable so the frontend can memoize derived maps. */
	private lastMessagesSig = "";
	private lastMessagesArray: UiMessage[] = [];
	private queueSteering = 0;
	private queueFollowUp = 0;
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	private constructor(
		clientId: string,
		cwd: string,
		sessionDir: string,
		agentDir: string,
		runtime: AgentSessionRuntime,
	) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.workspaceRoot = cwd;
		this.sessionDir = sessionDir;
		this.agentDir = agentDir;
		this.runtime = runtime;
		this.session = runtime.session;
	}

	static async create(
		clientId: string,
		cwd: string,
		sessionDir: string,
	): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const runtime = await createAgentSessionRuntime(
			ClientSession.runtimeFactory,
			{
				cwd,
				agentDir,
				// Resume the most recent session for this client's private session dir,
				// or start a fresh one on first visit.
				sessionManager: SessionManager.continueRecent(cwd, sessionDir),
			},
		);

		const cs = new ClientSession(clientId, cwd, sessionDir, agentDir, runtime);
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
				});
			}
		}
		await cs.bindSession();
		return cs;
	}

	/** Builds a full cwd-bound runtime for the given working directory. */
	private static runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
		cwd: effectiveCwd,
		sessionManager,
	}) => {
		const services = await createAgentSessionServices({ cwd: effectiveCwd });
		return {
			...(await createAgentSessionFromServices({ services, sessionManager })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		const statuses = this.webUi.statusSnapshot();
		if (statuses.length > 0) send({ type: "statuses", statuses });
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// No sockets left for this client — kill its terminals so processes don't
		// survive a closed tab / dropped connection.
		if (this.sinks.size === 0) this.terminals.killAll();
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		for (const sink of [...this.sinks]) sink(msg);
	}

	/** (Re)attach event plumbing to the active session — also used after new_chat. */
	private async bindSession(): Promise<void> {
		this.unsubscribe?.();
		this.session = this.runtime.session;
		await this.session.bindExtensions({
			mode: "rpc",
			uiContext: this.webUi,
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: err.error });
			},
		});
		this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	private onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_update": {
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				this.queueSteering = event.steering.length;
				this.queueFollowUp = event.followUp.length;
				break;
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end":
			case "entry_appended":
				this.scheduleSessionsRefresh();
				break;
			default:
				break;
		}
		this.scheduleSnapshot();
	}

	/** Debounced push of the persisted session list to the client. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (!this.disposed) void this.pushSessions();
		}, 800);
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		const key =
			m.role === "toolResult"
				? `t:${m.toolCallId}`
				: `${m.role}:${m.timestamp}`;
		let n = this.msgIds.get(key);
		if (n === undefined) {
			n = this.nextMsgId++;
			this.msgIds.set(key, n);
		}
		const cacheKey = `${key}#${n}`;
		const cached = this.uiMessageCache.get(cacheKey);
		if (cached) return cached;
		const msg = serializeMessage(m, n);
		if (msg) this.uiMessageCache.set(cacheKey, msg);
		return msg;
	}

	snapshot(): UiState {
		const state = this.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.session.getSessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: s.contextUsage
					? {
							tokens: s.contextUsage.tokens,
							contextWindow: s.contextUsage.contextWindow,
							percent: s.contextUsage.percent,
						}
					: stats.contextUsage,
			};
		} catch {
			// stats are best-effort
		}
		const rawMessages = state.messages
			.map((m) => this.serializeCached(m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages =
			sig === this.lastMessagesSig ? this.lastMessagesArray : rawMessages;
		this.lastMessagesSig = sig;
		this.lastMessagesArray = rawMessages;
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			messages,
			// The in-progress assistant message lives in state.streamingMessage
			// (the SDK only pushes it into state.messages at message_end). Surfacing
			// it here is what makes thinking + text stream into the browser at
			// ~60ms granularity instead of appearing only when the turn finishes.
			streamingMessage: state.streamingMessage
				? serializeStreamingMessage(state.streamingMessage)
				: null,
			isStreaming: this.session.isStreaming,
			model: model
				? { id: model.id, name: model.name, provider: model.provider }
				: null,
			thinkingLevel: state.thinkingLevel,
			queue: { steering: this.queueSteering, followUp: this.queueFollowUp },
			errorMessage: state.errorMessage,
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			stats,
		};
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	/**
	 * Whether the pi agent config looks ready: the agent dir exists and
	 * auth.json has at least one provider credential. Cached for 2s.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		let configured = false;
		try {
			const authPath = join(this.agentDir, "auth.json");
			if (existsSync(authPath)) {
				const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
				configured =
					typeof data === "object" &&
					data !== null &&
					Object.keys(data).length > 0;
			}
		} catch {
			configured = false;
		}
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */
	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "正在安装 pi agent CLI（npm i -g @earendil-works/pi-coding-agent）…",
			});
			const { code, out } = await this.runAsync(
				"npm",
				["i", "-g", "@earendil-works/pi-coding-agent"],
				180_000,
			);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${code ?? "timeout"}）：${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const key = apiKey.trim();
		if (!provider.trim()) {
			this.emit({ type: "notice", level: "error", text: "请填写服务商 ID" });
			return;
		}
		if (!key) {
			this.emit({ type: "notice", level: "error", text: "请填写 API 密钥" });
			return;
		}
		try {
			// Persist to auth.json (auth.json shape: { <provider>: { type: "api_key", key } }).
			const authPath = join(this.agentDir, "auth.json");
			mkdirSync(this.agentDir, { recursive: true });
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
					string,
					unknown
				>;
			} catch {
				// no file yet / unparsable — start fresh
			}
			data[provider.trim()] = { type: "api_key", key };
			writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
			// Apply immediately for this session (runtime credentials are cached), then
			// refresh models. allowNetwork downloads the provider's official model
			// catalog (openai/anthropic/… are dynamic providers with no built-in list).
			const mr = this.runtime.services.modelRuntime;
			await mr.setRuntimeApiKey(provider.trim(), key);
			await mr.refresh({ allowNetwork: true });
			this.piCheckCache = null;
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存 ${provider.trim()} 的 API 密钥并刷新模型列表`,
			});
			await this.listModels();
			await this.listProviders();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `保存 API 密钥失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Enumerate pi's built-in providers with auth status (key-only config). */
	async listProviders(): Promise<void> {
		const mr = this.runtime.services.modelRuntime;
		let providers;
		try {
			providers = mr.getProviders().map((p) => {
				try {
					const st = mr.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						configured: st?.configured ?? false,
						source: st?.source,
					};
				} catch {
					// One odd provider must not blank the whole list.
					return { id: p.id, name: p.name, configured: false };
				}
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取服务商列表失败：${(err as Error).message}`,
			});
			return;
		}
		if (providers.length === 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "服务商列表为空——pi 运行时未注册任何提供商",
			});
		}
		this.emit({ type: "providers_status", providers });
	}

	// ---------------------------------------------------------------------------
	// Custom model config (agentDir/models.json)
	// ---------------------------------------------------------------------------

	private modelsConfigPath(): string {
		return join(this.agentDir, "models.json");
	}

	/** Strip // and /* *\/ comments without touching string literals (URLs contain //). */
	private static stripJsonComments(src: string): string {
		let out = "";
		let inString = false;
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			const next = src[i + 1];
			if (inString) {
				out += c;
				if (c === "\\") {
					out += next ?? "";
					i += 2;
					continue;
				}
				if (c === '"') inString = false;
				i++;
				continue;
			}
			if (c === '"') {
				inString = true;
				out += c;
				i++;
				continue;
			}
			if (c === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				i += 2;
				while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}

	/** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
	private readModelsConfig(): {
		providers: Record<string, Record<string, unknown>>;
	} {
		const path = this.modelsConfigPath();
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(ClientSession.stripJsonComments(raw)) as {
				providers?: Record<string, Record<string, unknown>>;
			};
			return { providers: parsed?.providers ?? {} };
		} catch {
			return { providers: {} };
		}
	}

	/** Send the current models.json custom providers to the client. */
	async listModelsConfig(): Promise<void> {
		const { providers } = this.readModelsConfig();
		const list: UiProviderConfig[] = Object.entries(providers).map(
			([providerId, p]) => {
				const models = Array.isArray(p.models)
					? (p.models as Record<string, unknown>[]).map((m) => ({
							id: String(m.id ?? ""),
							name: m.name as string | undefined,
							reasoning: m.reasoning as boolean | undefined,
							input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
							contextWindow: m.contextWindow as number | undefined,
							maxTokens: m.maxTokens as number | undefined,
						}))
					: [];
				return {
					providerId,
					name: p.name as string | undefined,
					api: p.api as string | undefined,
					baseUrl: p.baseUrl as string | undefined,
					apiKey: p.apiKey as string | undefined,
					authHeader: p.authHeader as boolean | undefined,
					headers: p.headers as Record<string, string> | undefined,
					models,
				};
			},
		);
		this.emit({ type: "models_config", providers: list });
	}

	/** Upsert one provider into models.json and hot-reload the model runtime. */
	async saveModelConfig(
		providerId: string,
		config: UiProviderConfig,
	): Promise<void> {
		const pid = providerId.trim();
		if (!pid || !/^[\w.-]+$/.test(pid)) {
			this.emit({
				type: "notice",
				level: "error",
				text: "服务商 ID 无效（仅字母/数字/._-）",
			});
			return;
		}
		const models = (config.models ?? [])
			.filter((m) => m.id && m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
				...(m.reasoning ? { reasoning: true } : {}),
				...(m.input?.length ? { input: m.input } : {}),
				...(m.contextWindow ? { contextWindow: Number(m.contextWindow) } : {}),
				...(m.maxTokens ? { maxTokens: Number(m.maxTokens) } : {}),
			}));
		if (models.length === 0) {
			this.emit({ type: "notice", level: "error", text: "至少需要一个模型" });
			return;
		}
		try {
			const { providers } = this.readModelsConfig();
			providers[pid] = {
				...(config.name?.trim() ? { name: config.name.trim() } : {}),
				...(config.api?.trim() ? { api: config.api.trim() } : {}),
				...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
				...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim() } : {}),
				...(config.authHeader ? { authHeader: true } : {}),
				...(config.headers && Object.keys(config.headers).length > 0
					? { headers: config.headers }
					: {}),
				models,
			};
			mkdirSync(this.agentDir, { recursive: true });
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);
			await this.runtime.services.modelRuntime.refresh();
			await this.listModelsConfig();
			await this.listModels();
			this.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存服务商 ${pid}（${models.length} 个模型）并刷新模型列表`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `保存模型配置失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Remove a provider from models.json and hot-reload. */
	async deleteModelConfig(providerId: string): Promise<void> {
		try {
			const { providers } = this.readModelsConfig();
			if (!(providerId in providers)) {
				this.emit({
					type: "notice",
					level: "info",
					text: `服务商 ${providerId} 不存在`,
				});
				return;
			}
			delete providers[providerId];
			writeFileSync(
				this.modelsConfigPath(),
				JSON.stringify({ providers }, null, 2) + "\n",
			);
			await this.runtime.services.modelRuntime.refresh();
			await this.listModelsConfig();
			await this.listModels();
			this.emit({
				type: "notice",
				level: "info",
				text: `🗑  已删除服务商 ${providerId}`,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `删除模型配置失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one). */
	flushSnapshot(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (!this.disposed) this.emit({ type: "snapshot", state: this.snapshot() });
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			if (!this.disposed)
				this.emit({ type: "snapshot", state: this.snapshot() });
		}, SNAPSHOT_INTERVAL_MS);
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	async prompt(
		text: string,
		attachments?: { path: string; mode?: "inline" | "reference" }[],
	): Promise<void> {
		try {
			const s = this.session;
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await this.buildAttachmentMessages(attachments);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// Queue for delivery after the current run finishes.
				await s.prompt(text, { streamingBehavior: "followUp" });
			} else {
				await s.prompt(text);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `提示发送失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content.
	 */
	private async buildAttachmentMessages(
		attachments: { path: string; mode?: "inline" | "reference" }[] | undefined,
	): Promise<{ message: Parameters<AgentSession["sendCustomMessage"]>[0] }[]> {
		if (!attachments || attachments.length === 0) return [];
		const fs = await import("node:fs/promises");
		const { resolve, sep, relative, extname } = await import("node:path");

		const root = resolve(this.cwd);
		const MAX_ATTACHMENT_BYTES = 200 * 1024;
		// Files at or below this size are inlined; larger files are referenced by
		// path only (the model reads them on demand — saves tokens for small edits).
		const MAX_INLINE_BYTES = Number(
			process.env.PI_WEB_INLINE_FILE_MAX ?? 12 * 1024,
		);
		const IMAGE_EXT = new Set([
			".png",
			".jpg",
			".jpeg",
			".gif",
			".webp",
			".bmp",
			".svg",
		]);
		const MIME: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
			".bmp": "image/bmp",
			".svg": "image/svg+xml",
		};

		const out: { message: Parameters<AgentSession["sendCustomMessage"]>[0] }[] =
			[];

		for (const att of attachments) {
			const abs = resolve(root, att.path);
			const rel = relative(root, abs);
			if (rel.startsWith("..") || rel.includes(`${sep}..`)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `附件路径超出工作区：${att.path}`,
				});
				continue;
			}
			let stat:
				| { size: number; isFile(): boolean; isDirectory(): boolean }
				| undefined;
			try {
				stat = await fs.stat(abs);
			} catch {
				this.emit({
					type: "notice",
					level: "error",
					text: `附件不存在：${att.path}`,
				});
				continue;
			}

			const name = att.path.split("/").pop() ?? att.path;

			// Folders can't be inlined — always a path reference the model browses
			// on demand with its own tools (ls/read).
			if (stat.isDirectory()) {
				out.push({
					message: {
						customType: "file",
						content: [{ type: "text", text: `<folder path="${rel}" />` }],
						display: true,
						details: {
							name,
							path: rel,
							mode: "reference",
							type: "folder",
						},
					},
				});
				continue;
			}

			if (!stat.isFile()) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `跳过非文件附件：${att.path}`,
				});
				continue;
			}

			const ext = extname(att.path).toLowerCase();
			if (IMAGE_EXT.has(ext)) {
				// Images can't be referenced — they must be inlined, so keep a hard cap.
				if (stat.size > MAX_ATTACHMENT_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `图片附件过大已跳过（>200KB）：${att.path}`,
					});
					continue;
				}
				const data = await fs.readFile(abs, "base64");
				out.push({
					message: {
						customType: "file",
						content: [
							{ type: "image", data, mimeType: MIME[ext] ?? "image/png" },
						],
						display: true,
						details: { name, path: rel, mode: "image", size: stat.size },
					},
				});
				continue;
			}

			const makeReference = (): {
				message: Parameters<AgentSession["sendCustomMessage"]>[0];
			} => ({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `<file path="${rel}" size="${stat.size}" />`,
						},
					],
					display: true,
					details: { name, path: rel, mode: "reference", size: stat.size },
				},
			});
			const makeInline = (
				buf: Buffer,
			): {
				message: Parameters<AgentSession["sendCustomMessage"]>[0];
			} => {
				const lines = countLines(buf);
				return {
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `\n<file path="${rel}">\n\`\`\`\n${buf.toString("utf8")}\n\`\`\`\n</file>`,
							},
						],
						display: true,
						details: {
							name,
							path: rel,
							mode: "inline",
							size: stat.size,
							lines,
						},
					},
				};
			};

			// Reference mode is always honored and never reads the file.
			if (att.mode === "reference") {
				out.push(makeReference());
				continue;
			}

			// Forced inline has a hard cap to protect the model context.
			if (att.mode === "inline") {
				if (stat.size > MAX_INLINE_BYTES) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `文件过大，已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				const buf = await fs.readFile(abs);
				if (buf.includes(0)) {
					this.emit({
						type: "notice",
						level: "warning",
						text: `二进制文件已改为仅引用：${att.path}`,
					});
					out.push(makeReference());
					continue;
				}
				out.push(makeInline(buf));
				continue;
			}

			// Auto: small files inline, large files reference by path.
			if (stat.size > MAX_INLINE_BYTES) {
				out.push(makeReference());
				continue;
			}
			const buf = await fs.readFile(abs);
			if (buf.includes(0)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `二进制文件已跳过（仅引用路径）：${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			out.push(makeInline(buf));
		}
		return out;
	}

	async abort(): Promise<void> {
		try {
			await this.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `中止失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	async newChat(): Promise<void> {
		try {
			await this.runtime.newSession();
			await this.bindSession();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `新建对话失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** List persisted sessions for this client, newest first. */
	/** Push the persisted session list to the client (client-requested). */
	async refreshSessions(): Promise<void> {
		await this.pushSessions();
	}

	private async pushSessions(): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			// The pi CLI/TUI keeps sessions in <agentDir>/sessions/--<cwd-sanitized>--
			// (encoded per working directory). List those too, so the conversation
			// panel shows every conversation of the current folder — not just the
			// ones created in this web UI.
			const safePath = `--${resolve(this.cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`;
			const tuiSessionDir = join(this.agentDir, "sessions", safePath);

			const [webInfos, tuiInfos] = await Promise.all([
				SessionManager.list(this.cwd, this.sessionDir),
				existsSync(tuiSessionDir)
					? SessionManager.list(this.cwd, tuiSessionDir).catch(() => [])
					: Promise.resolve([]),
			]);

			const sessions = new Map<string, SessionSummary>();
			for (const s of webInfos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
				});
			}
			for (const s of tuiInfos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "tui",
				});
			}
			const sorted = [...sessions.values()].sort(
				(a, b) => b.modified - a.modified,
			);
			this.emit({ type: "sessions", sessions: sorted });
		} catch {
			this.emit({ type: "sessions", sessions: [] });
		}
	}

	/** Switch the active session to a persisted one (from listSessions). */
	async switchSession(path: string): Promise<void> {
		try {
			await this.runtime.switchSession(path);
			await this.bindSession();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换会话失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, relative } = await import("node:path");
			const root = resolve(this.cwd);
			const target = relPath ? resolve(root, relPath) : root;
			const rel = relative(root, target);
			if (rel.startsWith("..") || rel.includes(`${sep}..`)) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath ?? ""}`,
				});
				return;
			}
			const dirents = await fs.readdir(target, { withFileTypes: true });
			const entries = dirents
				.filter((d) => !IGNORED_ENTRIES.has(d.name))
				.map((d) => ({
					name: d.name,
					path: rel === "" ? d.name : `${rel}/${d.name}`,
					type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
				}))
				.sort((a, b) =>
					a.type === b.type
						? a.name.localeCompare(b.name)
						: a.type === "dir"
							? -1
							: 1,
				)
				.slice(0, 500);
			this.emit({
				type: "files",
				path: rel === "" ? "" : rel,
				parent:
					rel === ""
						? null
						: rel.includes("/")
							? rel.slice(0, rel.lastIndexOf("/"))
							: "",
				entries,
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `读取目录失败：${(err as Error).message}`,
			});
		}
	}

	async cycleModel(): Promise<void> {
		try {
			await this.session.cycleModel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		const empty = () =>
			this.emit({ type: "path_completions", completions: [] });
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();

			// Expand ~ and relative inputs to an absolute path.
			let expanded = input.trim();
			if (expanded === "") {
				empty();
				return;
			}
			if (expanded === "~") expanded = `${home}${sep}`;
			else if (expanded.startsWith("~/")) expanded = home + expanded.slice(1);
			else if (!expanded.startsWith("/"))
				expanded = resolve(this.cwd, expanded);

			// Split into parent dir + prefix (handle trailing slash = browse a dir).
			const lastSlash = expanded.lastIndexOf("/");
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "/";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs
				.readdir(dirPart, { withFileTypes: true })
				.catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const completions = dirents
				.filter(
					(d) => d.name.startsWith(prefix) && !IGNORED_ENTRIES.has(d.name),
				)
				.map((d) => ({
					name: d.name,
					path: dirPart + d.name,
					type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
				}))
				.sort((a, b) => {
					const aHidden = a.name.startsWith(".");
					const bHidden = b.name.startsWith(".");
					if (aHidden !== bHidden) return aHidden ? 1 : -1;
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 30);
			this.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}

	/**
	 * Switch the agent's working directory by rebuilding the runtime for the new
	 * cwd (services are cwd-bound). Resumes that directory's most recent session;
	 * refreshes snapshot, session list, and file tree.
	 */
	async setCwd(newCwd: string): Promise<void> {
		try {
			const { resolve } = await import("node:path");
			const fs = await import("node:fs/promises");
			const abs = resolve(newCwd);
			const st = await fs.stat(abs);
			if (!st.isDirectory()) {
				throw new Error("路径不是目录");
			}
			if (abs === this.cwd) {
				this.emit({
					type: "notice",
					level: "info",
					text: `已在工作目录：${abs}`,
				});
				this.flushSnapshot();
				return;
			}

			// Build the new runtime first — only swap on success.
			const newRuntime = await createAgentSessionRuntime(
				ClientSession.runtimeFactory,
				{
					cwd: abs,
					agentDir: this.agentDir,
					sessionManager: SessionManager.continueRecent(abs, this.sessionDir),
				},
			);
			const oldRuntime = this.runtime;
			this.runtime = newRuntime;
			this.cwd = abs;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			await this.bindSession();
			await oldRuntime.dispose().catch(() => {});
			for (const d of newRuntime.diagnostics) {
				if (d.type !== "info") {
					this.emit({ type: "notice", level: d.type, text: d.message });
				}
			}
			this.emit({
				type: "notice",
				level: "info",
				text: `已切换到工作目录：${abs}`,
			});
			void this.refreshSessions();
			void this.listFiles(undefined);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换工作目录失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: m.name,
				provider: m.provider,
				reasoning: m.reasoning,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `获取模型列表失败：${(err as Error).message}`,
			});
		}
	}

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.session.setModel(model);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换模型失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(
				level as Parameters<AgentSession["setThinkingLevel"]>[0],
			);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `切换思考强度失败：${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning } = await loadCommands(this.workspaceRoot);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error } = await saveCommandsFile(
			this.workspaceRoot,
			commands,
		);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `命令已保存：${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.terminals.killAll();
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		this.webUi.dispose();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		try {
			await this.runtime.dispose();
		} catch {
			// best effort
		}
	}
}

export class AgentService {
	private clients = new Map<string, ClientSession>();
	private pending = new Map<string, Promise<ClientSession>>();

	constructor(
		private cwd: string,
		private sessionDirRoot: string,
	) {}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
	): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				const creating = ClientSession.create(
					clientId,
					this.cwd,
					join(this.sessionDirRoot, sanitizeId(clientId)),
				).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
			}
		}
		cs.attachSink(send);
		return cs;
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
