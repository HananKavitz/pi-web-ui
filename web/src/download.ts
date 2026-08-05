import { getClientId } from "./use-chat";

/**
 * Browser download of a workspace file via /api/file?download=1.
 *
 * Downloads go through fetch → blob → objectURL instead of a plain anchor
 * navigation: Chrome's Safe Browsing blocks direct HTTP downloads of
 * "no-reputation" file types (.zip/.exe/…) with a confusing "无法下载/请重试
 * 或联系你的组织" error, and a failed request gives no usable feedback. A
 * blob download from the page's own origin avoids that block in most cases
 * and lets us surface real error messages. Files above BLOB_MAX_BYTES fall
 * back to a native navigation (streamed, no memory buffering).
 */

const BLOB_MAX_BYTES = 200 * 1024 * 1024;

export function downloadUrl(path: string, download = true): string {
	const qs = new URLSearchParams({
		clientId: getClientId(),
		path,
		...(download ? { download: "1" } : {}),
	});
	return `/api/file?${qs}`;
}

export type DownloadResult = { ok: true } | { ok: false; error: string };

export async function downloadFile(
	path: string,
	name: string,
): Promise<DownloadResult> {
	try {
		const res = await fetch(downloadUrl(path));
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				ok: false,
				error:
					body || (res.status === 404 ? "文件不存在" : `HTTP ${res.status}`),
			};
		}
		const len = Number(res.headers.get("content-length") ?? "0");
		if (len > BLOB_MAX_BYTES) {
			// Too big to buffer — let the browser stream it natively.
			window.location.assign(downloadUrl(path));
			return { ok: true };
		}
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
