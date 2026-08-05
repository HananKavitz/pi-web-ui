/**
 * Left-panel sections + cross-directory conversations UI check:
 * divider between 打开的对话 / 历史对话, project labels on open chats,
 * and the workspace-switch notice when jumping directories.
 */
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HEADLESS =
	"/Users/c/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = "/Volumes/P/project/pi-web-ui";

const A = mkdtempSync(join(tmpdir(), "pi-ui-a-"));
const B = mkdtempSync(join(tmpdir(), "pi-ui-b-"));
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(B, "b.txt"), "b");
const nameA = A.split("/").pop();
const nameB = B.split("/").pop();

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

// Free the port from any straggler before spawning.
try {
	execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
} catch {
	/* port free */
}
await sleep(500);
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

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector(".panel-left .panel-body", { timeout: 15000 });

// Wait for the Chinese locale UI (conn label or section titles).
await sleep(800);

// 1. Fresh state: only 历史对话 title, no 打开的对话 (1 conv), no divider.
let titles = await page
	.locator(".panel-left .panel-section-title")
	.allTextContents();
check(
	"history title present in fresh state",
	titles.some((t) => t.includes("历史对话")),
	titles.join("|"),
);
check(
	"no 打开的对话 section yet (single conv)",
	!titles.some((t) => t.includes("打开的对话")),
	titles.join("|"),
);

// 2. Start a second conversation (still project A) → 打开的对话 + divider appear.
await page.evaluate(() => {
	// Click the 新对话 button in the top bar by dispatching on the visible button.
	const btn = [...document.querySelectorAll("button")].find(
		(b) => b.textContent && b.textContent.includes("新对话"),
	);
	btn?.click();
});
await sleep(1200);
titles = await page.locator(".panel-left .panel-section-title").allTextContents();
check(
	"打开对话 + 历史对话 titles both present",
	titles.some((t) => t.includes("打开的对话")) &&
		titles.some((t) => t.includes("历史对话")),
	titles.join("|"),
);
check(
	"divider line present",
	(await page.locator(".panel-left .panel-section-divider").count()) === 1,
);

// 3. Switch workspace to project B (footer cwd input) → active conv rebuilds in B.
await page.locator(".status-cwd").click();
await page.locator(".status-cwd-input").fill(B);
await page.keyboard.press("Enter");
await sleep(1500);

// 4. Open-conversation entries must show their project labels (A and B).
const cwdLabels = await page
	.locator(".panel-left .session-item .session-cwd")
	.allTextContents();
check(
	"cross-directory conversation labels shown",
	cwdLabels.some((t) => t.includes(nameA)) && cwdLabels.some((t) => t.includes(nameB)),
	cwdLabels.join(" | "),
);

// 5. Switch back to the project-A conversation → workspace-switch notice fires.
const noticeBefore = await page
	.locator(".notice")
	.allTextContents()
	.catch(() => []);
const convA = page.locator(".panel-left .session-item", {
	has: page.locator(".session-cwd", { hasText: nameA }),
});
await convA.first().click();
await sleep(1000);
const notices = await page.locator(".notice").allTextContents().catch(() => []);
check(
	"cross-directory switch shows workspace notice",
	notices.some((n) => n.includes("已切换到工作目录") || n.includes(A)),
	notices.join(" | ") || `(before: ${noticeBefore.join(" | ")})`,
);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
