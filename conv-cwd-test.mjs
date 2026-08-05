/**
 * Cross-directory open-conversation repro:
 *
 *   conv1 (A) → new_chat conv2 (A) → set_cwd(B) (rebuilds ACTIVE conv) →
 *   switch back and forth, verifying each snapshot's cwd + file tree root
 *   follow the active conversation.
 */
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const PORT = 8898;
const PROJ = "/Volumes/P/project/pi-web-ui";
const A = mkdtempSync(join(tmpdir(), "pi-proj-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-proj-b-"));
writeFileSync(join(A, "only-in-A.txt"), "A\n");
writeFileSync(join(B, "only-in-B.txt"), "B\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: A },
	stdio: "ignore",
});
const portUp = async () => {
	try {
		execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
for (let i = 0; i < 40 && !(await portUp()); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const pending = new Map(); // seq → {resolve}
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

// State mirrors
let snapshot = null;
let conversations = [];
let files = null;
const notices = [];

ws.on("message", (d) => {
	const m = JSON.parse(d.toString());
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "files") files = m;
	else if (m.type === "notice") notices.push(m.text);
	else if (m.type === "ready") {
		console.log("ready");
		send({ type: "list_files", path: undefined });
	}
});

const waitFor = async (pred, what, timeout = 8000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};
const waitSnapshot = () => waitFor(() => snapshot !== null, "snapshot");

ws.on("open", () => {
	ws.send(JSON.stringify({ type: "hello", clientId }));
});
await waitFor(() => snapshot !== null, "initial snapshot");

// --- conv1 in A (server cwd) ---
check("conv1 cwd = A", snapshot?.cwd === A, snapshot?.cwd);
const conv1 = snapshot.conversationId;

// --- new_chat → conv2 (still A) ---
send({ type: "new_chat" });
await waitFor(
	() => snapshot?.conversationId && snapshot.conversationId !== conv1,
	"conv2 active",
);
const conv2 = snapshot.conversationId;
check("conv2 cwd = A", snapshot?.cwd === A);
await waitFor(() => conversations.length >= 2, "2 conversations listed");
check("2 open conversations", conversations.length >= 2);

// --- set_cwd(B): rebuilds the ACTIVE conversation (conv2) in B ---
send({ type: "set_cwd", path: B });
await waitFor(() => snapshot?.cwd === B && conversations.length >= 2, "cwd=B");
check("after set_cwd: conv2 cwd = B", snapshot?.cwd === B);
await waitFor(() => files?.path === "", "files root for B");
await waitFor(
	() => files?.entries?.some((e) => e.name === "only-in-B.txt"),
	"B file tree",
);
check("file tree shows B's files", files?.entries?.some((e) => e.name === "only-in-B.txt"));

// --- switch back to conv1 (still A) ---
send({ type: "switch_conversation", id: conv1 });
await waitFor(() => snapshot?.conversationId === conv1 && snapshot?.cwd === A, "conv1+A");
check("switch to conv1 → cwd back to A", snapshot?.cwd === A, snapshot?.cwd);
await waitFor(
	() => files?.entries?.some((e) => e.name === "only-in-A.txt"),
	"A file tree",
);
check("file tree shows A's files", files?.entries?.some((e) => e.name === "only-in-A.txt"));

// --- and back to conv2 (B) ---
send({ type: "switch_conversation", id: conv2 });
await waitFor(() => snapshot?.conversationId === conv2 && snapshot?.cwd === B, "conv2+B");
check("switch to conv2 → cwd = B", snapshot?.cwd === B, snapshot?.cwd);
await waitFor(
	() => files?.entries?.some((e) => e.name === "only-in-B.txt"),
	"B file tree again",
);
check("file tree back to B's files", files?.entries?.some((e) => e.name === "only-in-B.txt"));

// --- conversations summary carries correct per-conv cwd ---
const cwdOf = (id) => conversations.find((c) => c.id === id)?.cwd;
check(
	"conv1 summary cwd = A",
	cwdOf(conv1) === A,
	`conv1=${cwdOf(conv1)} conv2=${cwdOf(conv2)}`,
);
check(
	"conv2 summary cwd = B",
	cwdOf(conv2) === B,
	`conv2=${cwdOf(conv2)}`,
);

console.log("--- conversation summaries ---");
for (const c of conversations) console.log(`  ${c.id} title="${c.title}" cwd=${c.cwd}`);
console.log("--- notices ---");
for (const n of notices) console.log("  ", n);

ws.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
