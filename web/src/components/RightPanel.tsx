import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiChevronRight,
	FiEye,
	FiFile,
	FiFolder,
	FiLink,
	FiPlus,
	FiRefreshCw,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";

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
}

export function RightPanel({
	chat,
	send,
	onAttach,
	onPreview,
}: RightPanelProps) {
	const t = useT();
	const [currentPath, setCurrentPath] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const files = chat.files;

	// Monotonic request id — responses are only trusted if they match the latest
	// requested path (guards against out-of-order responses when navigating fast).
	const reqSeq = useRef(0);

	const request = useCallback(
		(path: string) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			setLoading(true);
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

	// Enter a directory.
	const openDir = (path: string) => request(path);
	// Go back to the parent.
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	const crumbs = currentPath.split("/").filter(Boolean);

	return (
		<aside className="panel panel-right">
			<div className="panel-header">
				<span className="panel-title">{t("files")}</span>
				<button
					type="button"
					className="panel-refresh"
					title={t("refreshFiles")}
					onClick={() => request(currentPath)}
				>
					<FiRefreshCw />
				</button>
			</div>
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
								<div key={e.path} className="file-item dir">
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
										className="file-name"
										title={`${e.path} — ${t("previewFile")}`}
										onClick={() => onPreview(e.path, e.name)}
									>
										<FiFile className="file-icon" />
										<span className="file-name-text">{e.name}</span>
									</button>
									<button
										type="button"
										className="file-attach preview"
										data-tip={t("previewFile")}
										onClick={() => onPreview(e.path, e.name)}
									>
										<FiEye />
									</button>
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
		</aside>
	);
}
