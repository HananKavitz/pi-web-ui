/**
 * Wire protocol between the browser client and the pi-web-ui server.
 * Pure JSON over WebSocket. The web frontend mirrors these types in
 * web/src/types.ts (kept in sync by hand — types only, no shared runtime code).
 */

// ---------------------------------------------------------------------------
// Serialized messages (server -> client snapshot)
// ---------------------------------------------------------------------------

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

/** Live bash execution (the `!` command / bashExecution transcript message). */
export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	| UiTextBlock
	| UiThinkingBlock
	| UiToolCallBlock
	| UiImageBlock
	| UiBashBlock
	| { type: string; [k: string]: unknown };

export interface UiMessage {
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). */
	details?: unknown;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
}

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	messages: UiMessage[];
	/**
	 * Live partial assistant message while a run is streaming. The SDK keeps the
	 * in-progress message in agent.state.streamingMessage — it only enters
	 * `messages` once the turn finishes (message_end). Null when idle.
	 */
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	queue: { steering: number; followUp: number };
	errorMessage?: string;
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent config looks ready (agentDir + auth.json with at
	 * least one provider credential). False → the client should offer the
	 * one-time auto-install flow.
	 */
	piConfigured: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
		};
	};
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** A user-defined command shown in the terminal command list (.pi/commands.json). */
export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

export type ClientMessage =
	| { type: "hello"; clientId: string }
	| {
			type: "prompt";
			text: string;
			attachments?: {
				path: string;
				mode?: "inline" | "reference" | "lines";
				/** 1-based inclusive line range (mode "lines" only). */
				lines?: { start: number; end: number };
			}[];
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			cwd: string;
			cols: number;
			rows: number;
	  }
	| { type: "terminal_input"; terminalId: string; data: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number }
	| { type: "terminal_kill"; terminalId: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
	  }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	| { type: "new_chat" }
	| { type: "cycle_model" }
	| { type: "cycle_thinking" }
	| { type: "get_state" }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string }
	| { type: "list_files"; path?: string }
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	/** Upsert one provider (api/baseUrl/apiKey + its models) into models.json. */
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	/** Remove a provider from models.json. */
	| { type: "delete_model_config"; providerId: string }
	/** List pi's built-in providers with their auth status (key-only config). */
	| { type: "list_providers" };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface SessionSummary {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself). */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). "none" files are
	 * never previewed — the UI doesn't open them and read_file refuses them.
	 */
	kind?: "image" | "video" | "text" | "none";
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
}

// ---------------------------------------------------------------------------
// Custom model configuration (agentDir/models.json) — browser-editable shape
// ---------------------------------------------------------------------------

/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	providerId: string;
	name?: string;
	/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models: UiModelConfigEntry[];
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
}

export type ServerMessage =
	| { type: "ready"; clientId: string; serverVersion: string }
	| { type: "snapshot"; state: UiState }
	| {
			type: "tool_delta";
			toolCallId: string;
			toolName: string;
			delta: string;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; terminalId: string; data: string }
	| { type: "terminal_exit"; terminalId: string; exitCode: number | null }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "sessions"; sessions: SessionSummary[] }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
	  }
	/** Content of a workspace file for the preview panel. */
	| {
			type: "file_content";
			path: string;
			name: string;
			/**
			 * Preview category: media kinds render via the /api/file HTTP
			 * endpoint (text stays empty); "none" means not previewable.
			 */
			kind: "image" | "video" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			/** Total line count of the *read* portion (equal to lines in text). */
			lines: number;
			/** Total file size in bytes. */
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	/** Result of an install_pi_agent run (npm i -g finished or failed). */
	| { type: "install_result"; ok: boolean; detail: string }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
	  }
	/** The server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "dialog_closed"; id: number };
