/**
 * Left-panel layout: open conversations are pinned above the scrolling
 * history; both section titles live OUTSIDE the scroll container.
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
const WS = mkdtempSync(join(tmpdir(), "pi-layout-"));
writeFileSync(join(WS, "a.txt"), "a");

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
	env: { ...process.env, PORT: String(PORT), PI_WEB_CWD: WS },
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
await page.waitForSelector(".panel-left .panel-sessions", { timeout: 15000 });
await sleep(800);

// 1. Single conversation → history title exists, no convs section.
let histTitles = await page
	.locator(".panel-sessions .panel-section-title")
	.allTextContents();
check("history title present", histTitles.some((t) => t.includes("历史对话")));
check(
	"no convs section yet",
	(await page.locator(".panel-left .panel-convs").count()) === 0,
);

// 2. Two more conversations → convs section appears, pinned ABOVE sessions.
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find(
		(b) => b.textContent && b.textContent.includes("新对话"),
	);
	btn?.click();
});
await sleep(900);
await page.evaluate(() => {
	const btn = [...document.querySelectorAll("button")].find(
		(b) => b.textContent && b.textContent.includes("新对话"),
	);
	btn?.click();
});
await sleep(900);

const convs = page.locator(".panel-left .panel-convs");
check("convs section present", (await convs.count()) === 1);
const convTitles = await convs.locator(".panel-section-title").allTextContents();
check("convs title inside convs section", convTitles.some((t) => t.includes("打开的对话")));

// 3. Structure: history title must be OUTSIDE the scroll container.
const historyTitleInsideScroll = await page
	.locator(".panel-sessions .sessions-scroll .panel-section-title")
	.count();
check(
	"history title NOT inside the scroll container",
	historyTitleInsideScroll === 0,
	`inside=${historyTitleInsideScroll}`,
);

// 4. Scroll behavior: sessions-scroll scrolls; convs section is a sibling.
const styles = await page.evaluate(() => {
	const ss = document.querySelector(".sessions-scroll");
	const pc = document.querySelector(".panel-convs");
	const gs = getComputedStyle;
	return {
		sessionsScrollOverflow: ss ? gs(ss).overflowY : "missing",
		convsOverflow: pc ? gs(pc).overflowY : "missing",
		convsInsideScroll: !!ss?.querySelector(".panel-convs"),
		sessionsFlex: document.querySelector(".panel-sessions")
			? gs(document.querySelector(".panel-sessions")).flex
			: "missing",
	};
});
check("sessions-scroll is the scrolling area", styles.sessionsScrollOverflow === "auto");
check("convs not nested inside sessions-scroll", !styles.convsInsideScroll);
check("convs section scrolls independently", styles.convsOverflow === "auto");

// 5. Titles must not move when the sessions list scrolls.
const before = await page.evaluate(() => {
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
const after = await page.evaluate(async () => {
	const sc = document.querySelector(".sessions-scroll");
	if (sc) sc.scrollTop = 300;
	await new Promise((r) => setTimeout(r, 200));
	const t = document.querySelector(".panel-sessions .panel-section-title");
	return t ? t.getBoundingClientRect().top : null;
});
check("history title stays fixed after scroll", before !== null && before === after, `top=${before}→${after}`);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
