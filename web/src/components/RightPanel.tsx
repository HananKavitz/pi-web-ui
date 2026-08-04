import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiChevronRight,
	FiFile,
	FiFolder,
	FiLink,
	FiPlus,
	FiRefreshCw,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";

type AttachMode = "inline" | "reference";

interface RightPanelProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "list_files"; path?: string }
			| { type: "set_cwd"; path: string }
			| { type: "complete_path"; path: string },
	) => boolean;
	/** Called when the user clicks an attach button on a file or folder. */
	onAttach: (
		path: string,
		name: string,
		mode: AttachMode,
		isDir?: boolean,
	) => void;
}

export function RightPanel({ chat, send, onAttach }: RightPanelProps) {
	const [currentPath, setCurrentPath] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const [editingCwd, setEditingCwd] = useState(false);
	const [cwdDraft, setCwdDraft] = useState("");
	const [selIdx, setSelIdx] = useState(0);
	const cwdInputRef = useRef<HTMLInputElement>(null);
	const files = chat.files;

	// Debounced path completion requests while editing the cwd.
	useEffect(() => {
		if (!editingCwd) return;
		const t = setTimeout(() => {
			send({ type: "complete_path", path: cwdDraft });
		}, 150);
		return () => clearTimeout(t);
	}, [cwdDraft, editingCwd, send]);

	// Reset selection whenever the completion list changes.
	useEffect(() => setSelIdx(0), [chat.pathCompletions]);

	const completions = chat.pathCompletions;
	const completionListRef = useRef<HTMLUListElement>(null);

	// Keep the highlighted item visible while navigating with the keyboard.
	useEffect(() => {
		const el = completionListRef.current?.querySelector(
			`.pc-item[data-idx="${selIdx}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [selIdx]);

	/** Fill the input with a completion and keep browsing (dirs) or stay for submit. */
	const applyCompletion = (path: string, isDir: boolean) => {
		// Shell-style: completing into a directory appends a trailing slash so the
		// next completion lists its contents.
		setCwdDraft(isDir ? `${path}/` : path);
		setSelIdx(0);
		cwdInputRef.current?.focus();
	};

	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelIdx((i) => Math.min(i + 1, completions.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Tab" && completions.length > 0) {
			e.preventDefault();
			const c = completions[Math.min(selIdx, completions.length - 1)];
			applyCompletion(c.path, c.type === "dir");
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			const trimmed = cwdDraft.trim();
			if (trimmed.endsWith("/")) {
				// Explicit directory (trailing slash) → switch immediately.
				setEditingCwd(false);
				send({ type: "set_cwd", path: trimmed });
			} else if (completions.some((c) => c.path === trimmed)) {
				// Input exactly matches a suggestion → switch to it.
				setEditingCwd(false);
				send({ type: "set_cwd", path: trimmed });
			} else if (completions.length > 0 && completions[selIdx]) {
				// Fill the highlighted completion first; press Enter again to switch.
				e.preventDefault();
				const c = completions[selIdx];
				applyCompletion(c.path, c.type === "dir");
			} else {
				setEditingCwd(false);
				if (trimmed) send({ type: "set_cwd", path: trimmed });
			}
		} else if (e.key === "Escape") {
			if (completions.length > 0) {
				// First Esc closes the suggestion list; second exits editing.
				e.stopPropagation();
				setCwdDraft(cwdDraft); // no-op to keep editing alive
				send({ type: "complete_path", path: "" }); // clears list
			} else {
				setEditingCwd(false);
			}
		}
	};

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
				<span className="panel-title">文件</span>
				<button
					type="button"
					className="panel-refresh"
					title="刷新文件列表"
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
					根目录
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
				{loading && <div className="panel-empty">加载中…</div>}
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
										data-tip="链接文件夹路径到对话"
										onClick={() => onAttach(e.path, e.name, "reference", true)}
									>
										<FiLink />
									</button>
								</div>
							) : (
								<div key={e.path} className="file-item file">
									<FiFile className="file-icon" />
									<span className="file-name" title={e.path}>
										{e.name}
									</span>
									<button
										type="button"
										className="file-attach inline"
										data-tip="附加内容到对话"
										onClick={() => onAttach(e.path, e.name, "inline")}
									>
										<FiPlus />
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip="仅引用路径（AI 按需读取）"
										onClick={() => onAttach(e.path, e.name, "reference")}
									>
										<FiLink />
									</button>
								</div>
							),
						)}
					</>
				)}
				{!loading && !files && <div className="panel-empty">暂无文件</div>}
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
			<div className="panel-footer">
				{editingCwd ? (
					<div className="cwd-edit-wrap">
						<input
							ref={cwdInputRef}
							className="cwd-input"
							value={cwdDraft}
							autoFocus
							placeholder="输入路径，Enter 切换"
							onChange={(e) => setCwdDraft(e.target.value)}
							onKeyDown={onInputKeyDown}
							onBlur={() => setEditingCwd(false)}
						/>
						{completions.length > 0 && (
							<ul
								ref={completionListRef}
								className="path-completions"
								onMouseDown={(e) => e.preventDefault()} // keep input focused
							>
								{completions.map((c, i) => (
									<li key={c.path}>
										<button
											type="button"
											data-idx={i}
											className={`pc-item ${i === selIdx ? "sel" : ""}`}
											onMouseEnter={() => setSelIdx(i)}
											onClick={() => applyCompletion(c.path, c.type === "dir")}
										>
											<span className="pc-icon">
												{c.type === "dir" ? <FiFolder /> : <FiFile />}
											</span>
											<span className="pc-body">
												<span className="pc-name">{c.name}</span>
												<span className="pc-path">{c.path}</span>
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				) : (
					<button
						type="button"
						className="cwd-bar"
						title="点击切换工作目录"
						onClick={() => {
							setCwdDraft(chat.state?.cwd ?? "");
							setEditingCwd(true);
						}}
					>
						<span className="cwd-label">目录</span>
						<span className="panel-cwd" title={chat.state?.cwd}>
							{chat.state?.cwd}
						</span>
						<span className="cwd-edit">✎</span>
					</button>
				)}
			</div>
		</aside>
	);
}
