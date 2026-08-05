import { getClientId } from "./use-chat";

/**
 * Drag & drop from the OS file manager (Finder / Explorer): the browser never
 * exposes absolute paths, so files are uploaded over HTTP to the server's
 * /api/upload endpoint, which writes them inside the client's workspace.
 * Dropped directories are traversed via webkitGetAsEntry and re-created
 * under the drop target, preserving their internal structure.
 */

export interface DroppedFile {
	/** Path of the file within the drop (top-level name for plain files). */
	relPath: string;
	file: File;
}

export type UploadResult =
	| { ok: true; path: string; name: string; size: number }
	| { ok: false; error: string };

/** Upload one file to `destDir` (workspace-relative, "" = workspace root). */
export async function uploadFile(
	file: File,
	destDir: string,
	relPath?: string,
): Promise<UploadResult> {
	try {
		const qs = new URLSearchParams({ clientId: getClientId(), destDir });
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"X-File-Name": encodeURIComponent(
				relPath ? (relPath.split("/").pop() ?? file.name) : file.name,
			),
		};
		if (relPath) headers["X-File-Rel-Path"] = encodeURIComponent(relPath);
		const res = await fetch(`/api/upload?${qs}`, {
			method: "POST",
			headers,
			body: file,
		});
		const data = (await res.json().catch(() => null)) as
			| { ok: true; path: string; name: string; size: number }
			| { ok: false; error: string }
			| null;
		if (!res.ok || !data || !data.ok) {
			const error = data && "error" in data ? data.error : `HTTP ${res.status}`;
			return { ok: false, error };
		}
		return data;
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Collect every file in a drop, recursing into dropped directories so their
 * structure can be preserved on the server. Falls back to dt.files when the
 * entry API is unavailable (some browsers / some drag sources).
 */
export async function collectDroppedFiles(
	dt: DataTransfer,
): Promise<DroppedFile[]> {
	const out: DroppedFile[] = [];
	const items = dt.items ? Array.from(dt.items) : [];
	if (items.length > 0) {
		let usedEntryApi = false;
		for (const item of items) {
			const entry = item.webkitGetAsEntry?.();
			if (!entry) continue;
			usedEntryApi = true;
			if (entry.isFile) {
				const file = item.getAsFile();
				if (file) out.push({ relPath: entry.name, file });
			} else if (entry.isDirectory) {
				out.push(
					...(await walkDirectory(entry as FileSystemDirectoryEntry, "")),
				);
			}
		}
		if (usedEntryApi) return out;
	}
	// Fallback: no entry API — plain files, structure lost.
	for (const f of Array.from(dt.files)) {
		out.push({ relPath: f.name, file: f });
	}
	return out;
}

function walkDirectory(
	dir: FileSystemDirectoryEntry,
	prefix: string,
): Promise<DroppedFile[]> {
	const reader = dir.createReader();
	// readEntries must be called repeatedly until it returns an empty array.
	const readBatch = () =>
		new Promise<FileSystemEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
	const readFile = (e: FileSystemFileEntry) =>
		new Promise<File | null>((resolve) => e.file(resolve, () => resolve(null)));
	return (async () => {
		const out: DroppedFile[] = [];
		for (;;) {
			const batch = await readBatch();
			if (batch.length === 0) break;
			for (const e of batch) {
				const rel = prefix ? `${prefix}/${e.name}` : e.name;
				if (e.isFile) {
					const f = await readFile(e as FileSystemFileEntry);
					if (f) out.push({ relPath: rel, file: f });
				} else if (e.isDirectory) {
					out.push(
						...(await walkDirectory(e as FileSystemDirectoryEntry, rel)),
					);
				}
			}
		}
		return out;
	})();
}

/** True when a drag event carries OS files (vs. internal text/HTML drags). */
export function dragHasFiles(e: {
	dataTransfer: DataTransfer | null;
}): boolean {
	return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}
