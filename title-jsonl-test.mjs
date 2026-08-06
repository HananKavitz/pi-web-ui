/**
 * Clean regression: after a prompt completes in project A, switching to
 * project B must refresh the conversation title (fresh session in B →
 * "新对话"), NOT keep/stale the A conversation's name.
 */
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8898;
const PROJ = "/Volumes/P/project/pi-web-ui";
const A = mkdtempSync(join(tmpdir(), "pi-tit-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-tit-b-"));
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(A, "data.jsonl"), '{"a":1}\n{"a":2}\n');
writeFileSync(join(B, "b.txt"), "b");

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
try {
	execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
} catch {}
await sleep(400);
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
let snapshot = null;
let conversations = [];
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "conversations") conversations = m.conversations;
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));

const waitFor = async (pred, what, timeout = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(200);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};
const convOf = (id) => conversations.find((c) => c.id === id);

await waitFor(() => snapshot !== null, "snapshot");
const conv1 = snapshot.conversationId;

// 0. jsonl must preview as text (read_file works).
let fileContent = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "file_content") fileContent = m;
});
ws.send(JSON.stringify({ type: "read_file", path: "data.jsonl" }));
await waitFor(() => fileContent !== null, "file_content for jsonl", 8000);
check(
	"jsonl previews as text",
	fileContent?.path === "data.jsonl" &&
		fileContent.text.includes('{"a":1}') &&
		fileContent.kind === "text",
	fileContent ? `kind=${fileContent.kind}` : "no file_content",
);

// 1. Prompt in A, wait for the turn to fully complete AND the title to update.
ws.send(JSON.stringify({ type: "prompt", text: "只回复两个字：好的" }));
const titled = await waitFor(
	() => {
		const c = convOf(conv1);
		return c && c.title && c.title !== "新对话";
	},
	"conv title updates after turn",
);
const titleA = convOf(conv1)?.title;
check("title reflects project A message", titled && titleA?.includes("只回复"), `title="${titleA}"`);

// 2. Switch project to B.
ws.send(JSON.stringify({ type: "set_cwd", path: B }));
const moved = await waitFor(
	() => convOf(conv1)?.cwd === B,
	"conv cwd → B",
	15000,
);
check("conversation moved to project B", moved, convOf(conv1)?.cwd);
await sleep(800); // let any follow-up conversations emit settle
const titleB = convOf(conv1)?.title;
check(
	"title refreshed after project switch (B has no history → 新对话)",
	titleB === "新对话" || titleB === undefined,
	`A="${titleA}" B="${titleB}"`,
);

ws.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
