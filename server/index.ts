/**
 * pi-web-ui server entry.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PORT            HTTP port (default 8787)
 *   PI_WEB_CWD      workspace the agent operates in (default: process.cwd())
 *   PI_WEB_DATA_DIR where per-client session dirs are stored (default: <cwd>/.pi-web)
 *   PI_CODING_AGENT_DIR  pi config dir (auth/models/skills) — passed to the SDK
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { AgentService } from "./agent-service.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const CWD = resolve(process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(process.env.PI_WEB_DATA_DIR ?? join(CWD, ".pi-web"));
const SESSION_DIR_ROOT = join(DATA_DIR, "sessions");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
	res.json({ ok: true, piVersion: VERSION, cwd: CWD, pid: process.pid });
});

// Production: serve the built frontend from web/dist. Resolve relative to this
// module so it works when installed as a package (global/npx/Docker), not just
// from the repo root. In dev, Vite serves the UI on :5173 and proxies /ws.
const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/server or <pkg>/server
const pkgRoot = resolve(here, "..", "..");
const webDist = join(pkgRoot, "web", "dist");
if (existsSync(webDist)) {
	app.use(express.static(webDist));
	app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
		res.sendFile(join(webDist, "index.html"));
	});
}

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Idle connections otherwise
// carry no traffic and TCP keepalive defaults are far too slow (~2h).
const heartbeatTimer = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "heartbeat" } satisfies ServerMessage));
		}
	}
}, 10_000);

const service = new AgentService(CWD, SESSION_DIR_ROOT);

wss.on("connection", (ws) => {
	let clientId: string | null = null;
	let closed = false;
	/** Commands received while the session is still being created — replayed after attach. */
	let pending: ClientMessage[] = [];

	const send = (msg: ServerMessage): void => {
		if (!closed && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

	const dispatch = (msg: ClientMessage): void => {
		if (!clientId) {
			pending.push(msg);
			return;
		}
		const cs = service.get(clientId);
		if (!cs) {
			// Session not ready yet (hello processing) — hold the command.
			pending.push(msg);
			return;
		}
		switch (msg.type) {
			case "prompt":
				void cs.prompt(msg.text, msg.attachments);
				break;
			case "abort":
				void cs.abort();
				break;
			case "new_chat":
				void cs.newChat();
				break;
			case "cycle_model":
				void cs.cycleModel();
				break;
			case "cycle_thinking":
				cs.cycleThinking();
				break;
			case "get_state":
				cs.flushSnapshot();
				break;
			case "list_sessions":
				void cs.refreshSessions();
				break;
			case "switch_session":
				void cs.switchSession(msg.path);
				break;
			case "list_files":
				void cs.listFiles(msg.path);
				break;
			case "list_models":
				void cs.listModels();
				break;
			case "set_model":
				void cs.setModel(msg.modelId);
				break;
			case "set_thinking":
				cs.setThinking(msg.level);
				break;
			case "set_cwd":
				void cs.setCwd(msg.path);
				break;
			case "complete_path":
				void cs.completePath(msg.path);
				break;
			case "dialog_response":
				cs.resolveDialog(msg.id, msg.value);
				break;
			case "install_pi_agent":
				void cs.installPiAgent();
				break;
			case "set_provider_api_key":
				void cs.setProviderApiKey(msg.provider, msg.apiKey);
				break;
			case "list_models_config":
				void cs.listModelsConfig();
				break;
			case "save_model_config":
				void cs.saveModelConfig(msg.providerId, msg.config);
				break;
			case "delete_model_config":
				void cs.deleteModelConfig(msg.providerId);
				break;
			case "list_providers":
				void cs.listProviders();
				break;
			case "terminal_create":
				cs.terminals.create(
					msg.terminalId,
					msg.cwd,
					msg.cols,
					msg.rows,
					cs.cwd,
				);
				break;
			case "terminal_input":
				cs.terminals.input(msg.terminalId, msg.data);
				break;
			case "terminal_resize":
				cs.terminals.resize(msg.terminalId, msg.cols, msg.rows);
				break;
			case "terminal_kill":
				cs.terminals.kill(msg.terminalId);
				break;
			case "run_command":
				cs.terminals.runCommand(
					msg.terminalId,
					msg.command,
					msg.cols,
					msg.rows,
					cs.cwd,
				);
				break;
			case "list_commands":
				void cs.listCommands();
				break;
			case "save_commands":
				void cs.saveCommands(msg.commands);
				break;
			default:
				break;
		}
	};

	ws.on("message", (data) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString()) as ClientMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			const cid = msg.clientId || randomUUID();
			clientId = cid;
			service
				.attach(cid, send)
				.then((cs) => {
					if (closed) return;
					send({ type: "ready", clientId: cid, serverVersion: VERSION });
					cs.flushSnapshot();
					// Replay anything that arrived while the session was starting.
					const queued = pending;
					pending = [];
					for (const m of queued) dispatch(m);
				})
				.catch((err: unknown) => {
					send({
						type: "notice",
						level: "error",
						text: `会话初始化失败：${(err as Error).message}`,
					});
				});
			return;
		}

		dispatch(msg);
	});

	ws.on("close", () => {
		closed = true;
		pending = [];
		if (clientId) service.detach(clientId, send);
	});
});

httpServer.listen(PORT, () => {
	console.log("");
	console.log("  ⚡ pi-web-ui — web chat for the pi coding agent");
	console.log(`    http://localhost:${PORT}`);
	console.log(`    workspace   : ${CWD}`);
	console.log(`    session dir : ${SESSION_DIR_ROOT}`);
	console.log(`    pi SDK      : v${VERSION}`);
	console.log("");
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nshutting down…");
	clearInterval(heartbeatTimer);
	await service.disposeAll();
	wss.close();
	httpServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
