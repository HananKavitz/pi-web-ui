import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiChevronRight,
	FiDownload,
	FiFile,
	FiFolder,
	FiLink,
	FiPlus,
	FiRefreshCw,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { getClientId } from "../use-chat";
import { useT } from "../i18n";
import { dragHasFiles } from "../upload";

type AttachMode = "inline" | "reference";

interface RightPanelProps {
	chat: ChatState;
	send: (msg: { type: "list_files"; path?: string }) => boolean;
	/** Called when the user clicks an attach button on a file or folder. */
	onAttach: (
		path: string,
		name: string,
		mode: AttachMode,
		isDir?: boolean,
	) => void;
	/** Called when the user clicks a file to open the preview modal. */
	onPreview: (path: string, name: string) => void;
	/** OS file drag state over the panel ("" = current dir, null = none). */
	onDragState: (folder: string | null) => void;
	/** OS files dropped on the panel — App uploads them into `destDir`. */
	onDropFiles: (destDir: string, dt: DataTransfer) => void;
}

export function RightPanel({
	chat,
	send,
	onAttach,
	onPreview,
	onDragState,
	onDropFiles,
}: RightPanelProps) {
	const t = useT();
	const [currentPath, setCurrentPath] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const files = chat.files;

	/** How often to silently re-poll the current directory (ms). */
	const AUTO_REFRESH_MS = 10_000;

	// Monotonic request id — responses are only trusted if they match the latest
	// requested path (guards against out-of-order responses when navigating fast).
	const reqSeq = useRef(0);

	// Last cwd we listed — when the workspace switches, jump back to its root.
	const lastCwd = useRef<string | undefined>(undefined);

	const request = useCallback(
		(path: string, opts?: { silent?: boolean }) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			// Silent refreshes (polling / cwd switch) keep the current listing on
			// screen instead of flashing the loading placeholder.
			if (!opts?.silent) setLoading(true);
			const ok = send({
				type: "list_files",
				path: path === "" ? undefined : path,
			});
			if (!ok) {
				// Not connected — nothing will arrive; back off the spinner.
				if (reqSeq.current === seq) setLoading(false);
			}
		},
		[send],
	);

	// The server response arrives via chat.files; only treat it as the answer to
	// the current navigation if its path matches (stale/out-of-order responses
	// for other directories keep the spinner up).
	useEffect(() => {
		if (files && files.path === currentPath) setLoading(false);
	}, [files, currentPath]);

	// Auto-refresh: when the cwd changes (project switch / set_cwd) re-list its
	// root; otherwise poll the current directory silently so the tree stays fresh
	// without a manual refresh button.
	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (cwd !== lastCwd.current) {
			lastCwd.current = cwd;
			request("", { silent: true });
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			request(currentPath, { silent: true });
		}, AUTO_REFRESH_MS);
		return () => clearInterval(timer);
	}, [chat.state?.cwd, currentPath, request]);

	// Enter a directory.
	const openDir = (path: string) => request(path);
	// Go back to the parent.
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	const crumbs = currentPath.split("/").filter(Boolean);

	// -- OS file drag & drop (copy into a folder) ----------------------------
	// Depth counter: dragenter/dragleave fire per child element, so only the
	// first enter / last leave toggles the drop state. The folder under the
	// cursor is derived from the event target so hovering a row highlights it.
	const dragDepth = useRef(0);
	const dragDest = useRef<string | null>(null);
	const [dragFolder, setDragFolder] = useState<string | null>(null);

	const onPanelDragEnter = (e: React.DragEvent) => {
		if (!dragHasFiles(e)) return;
		dragDepth.current += 1;
		// Re-derive the folder on every enter (moving background → row must
		// update the highlight); only notify when it actually changed.
		const row = (e.target as HTMLElement).closest?.(".file-item.dir");
		const dir = row ? (row as HTMLElement).dataset.path ?? "" : "";
		if (dragDepth.current === 1 || dir !== dragDest.current) {
			dragDest.current = dir;
			setDragFolder(dir);
			onDragState(dir);
		}
	};
	const onPanelDragOver = (e: React.DragEvent) => {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	};
	const onPanelDragLeave = (e: React.DragEvent) => {
		if (!dragHasFiles(e)) return;
		dragDepth.current -= 1;
		if (dragDepth.current > 0) return;
		dragDepth.current = 0;
		dragDest.current = null;
		setDragFolder(null);
		onDragState(null);
	};
	const onPanelDrop = (e: React.DragEvent) => {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dragDepth.current = 0;
		const dest = dragDest.current ?? "";
		dragDest.current = null;
		setDragFolder(null);
		onDragState(null);
		onDropFiles(dest, e.dataTransfer);
	};

	return (
		<aside
			className={`panel panel-right ${dragFolder !== null ? "drag-over" : ""}`}
			onDragEnter={onPanelDragEnter}
			onDragOver={onPanelDragOver}
			onDragLeave={onPanelDragLeave}
			onDrop={onPanelDrop}
		>
			<div className="panel-crumbs">
				<button
					type="button"
					className={`crumb ${currentPath === "" ? "active" : ""}`}
					onClick={() => request("")}
				>
					{t("rootDir")}
				</button>
				{crumbs.map((c, i) => {
					const path = crumbs.slice(0, i + 1).join("/");
					return (
						<span key={path} className="crumb-seg">
							<FiChevronRight />
							<button
								type="button"
								className={`crumb ${path === currentPath ? "active" : ""}`}
								onClick={() => request(path)}
							>
								{c}
							</button>
						</span>
					);
				})}
			</div>
			<div className="panel-body">
				{loading && <div className="panel-empty">{t("loading")}</div>}
				{!loading && files && files.path === currentPath && (
					<>
						{files.path !== "" && (
							<button type="button" className="file-item dir" onClick={goUp}>
								<FiFolder className="file-icon" />
								<span className="file-name">..</span>
							</button>
						)}
						{files.entries.map((e) =>
							e.type === "dir" ? (
							<div
								key={e.path}
								className={`file-item dir ${dragFolder === e.path ? "drop-target" : ""}`}
								data-path={e.path}
							>
									<button
										type="button"
										className="file-dir-main"
										onClick={() => openDir(e.path)}
									>
										<FiFolder className="file-icon" />
										<span className="file-name">{e.name}</span>
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("linkFolderTip")}
										onClick={() => onAttach(e.path, e.name, "reference", true)}
									>
										<FiLink />
									</button>
								</div>
							) : (
								<div key={e.path} className="file-item file">
									<button
										type="button"
										className={`file-name ${e.kind === "none" ? "no-preview" : ""}`}
										title={`${e.path} — ${
											e.kind === "none"
												? t("previewNotSupported")
												: t("previewFile")
										}`}
										onClick={
											e.kind === "none"
												? undefined
												: () => onPreview(e.path, e.name)
										}
									>
										<FiFile className="file-icon" />
										<span className="file-name-text">{e.name}</span>
									</button>
									{/* Download: any file, previewable or not (binary/archives
									too). /api/file resolves against the client's workspace. */}
									<a
										className="file-attach download"
										data-tip={t("downloadFile")}
										href={`/api/file?clientId=${encodeURIComponent(
											getClientId(),
										)}&path=${encodeURIComponent(e.path)}&download=1`}
										download={e.name}
									>
										<FiDownload />
									</a>
									<button
										type="button"
										className="file-attach inline"
										data-tip={t("attachInlineTip")}
										onClick={() => onAttach(e.path, e.name, "inline")}
									>
										<FiPlus />
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("referenceTip")}
										onClick={() => onAttach(e.path, e.name, "reference")}
									>
										<FiLink />
									</button>
								</div>
							),
						)}
					</>
				)}
				{!loading && !files && (
					<div className="panel-empty">{t("noFiles")}</div>
				)}
			</div>
			{chat.widgets.filter((w) => w.lines.length > 0).length > 0 && (
				<div className="panel-widgets">
					{chat.widgets
						.filter((w) => w.lines.length > 0)
						.map((w) => (
							<div key={w.key} className="widget">
								<div className="widget-title">{w.key}</div>
								<pre className="widget-lines">{w.lines.join("\n")}</pre>
							</div>
						))}
				</div>
			)}
			<button
				type="button"
				className="panel-fab"
				title={t("refreshFiles")}
				onClick={() => request(currentPath, { silent: true })}
			>
				<FiRefreshCw />
			</button>
		</aside>
	);
}
