import { useEffect, useRef, useState } from "react";
import {
	FiEdit2,
	FiFileText,
	FiPlay,
	FiPlus,
	FiRefreshCw,
	FiTerminal,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { TermXterm } from "./TermXterm";

interface TerminalPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string) => void;
		register: (
			id: string,
			writer: { write(data: string): void; dispose(): void },
		) => () => void;
		restart: (id: string) => void;
	};
}

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/**
 * Built-in terminal — three panes:
 *   left   : user command list (.pi/commands.json) — click a command to run it
 *   middle : the active terminal (one xterm per tab, kept mounted)
 *   right  : terminal tabs (VSCode-style vertical strip)
 */
export function TerminalPanel({ chat, send, terminal }: TerminalPanelProps) {
	const [activeId, setActiveId] = useState<string | null>(null);
	// Command list editing state.
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	// Two-step delete confirmation.
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// When the connection drops the server kills all PTYs and the reducer clears
	// the tab list — make sure the active selection doesn't dangle.
	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => t.id === activeId)) {
			setActiveId(chat.terminals[chat.terminals.length - 1].id);
		}
	}, [chat.terminals, activeId]);

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

	// -- tab management --------------------------------------------------------

	const openTab = (meta: Omit<TerminalMeta, "running" | "exitCode" | "id">) => {
		if (!chat.ready) return; // topbar already shows the connection state
		const id = crypto.randomUUID();
		terminal.create({ ...meta, id, running: true, exitCode: null });
		setActiveId(id);
	};

	const openShell = () =>
		openTab({
			title: `终端 ${chat.terminals.length + 1}`,
			cwd: chat.state?.cwd ?? "",
		});

	const runCommand = (cmd: CommandDef) => {
		const title = cmd.name || cmd.command;
		// Reuse a terminal with the same title (VSCode-style task reuse): the
		// command is re-run in the SAME tab — a running process is interrupted
		// first (the server kills the PTY's process group and starts fresh).
		const existing = chat.terminals.find((t) => t.title === title);
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			return;
		}
		openTab({ title, cwd: chat.state?.cwd ?? "", command: cmd });
	};

	const closeTab = (id: string) => {
		terminal.close(id);
		if (activeId === id) {
			const rest = chat.terminals.filter((t) => t.id !== id);
			setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
		}
	};

	// -- command list editing --------------------------------------------------

	const startNew = () => {
		setIsNew(true);
		setEditingIdx(null);
		setDraft(EMPTY_DRAFT);
	};

	const startEdit = (idx: number) => {
		const c = chat.commands[idx];
		if (!c) return;
		setIsNew(false);
		setEditingIdx(idx);
		setDraft({ name: c.name, command: c.command, cwd: c.cwd ?? "" });
	};

	const cancelEdit = () => {
		setIsNew(false);
		setEditingIdx(null);
	};

	const saveDraft = () => {
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const cwd = draft.cwd.trim();
		const def: CommandDef = { name, command, cwd: cwd ? cwd : undefined };
		const next = isNew
			? [...chat.commands, def]
			: editingIdx !== null
				? chat.commands.map((c, i) => (i === editingIdx ? def : c))
				: chat.commands;
		send({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			send({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;

	return (
		<div className="terminal-view">
			{/* ---------------- left: command list ---------------- */}
			<aside className="term-side term-commands">
				<div className="panel-header">
					<span className="panel-title">命令</span>
					<div className="panel-header-actions">
						<button
							type="button"
							className="panel-refresh"
							title="重新读取 .pi/commands.json"
							onClick={() => send({ type: "list_commands" })}
						>
							<FiRefreshCw />
						</button>
						<button
							type="button"
							className="panel-new"
							title="新建命令"
							onClick={startNew}
						>
							<FiPlus />
						</button>
					</div>
				</div>

				<div className="panel-body">
					{editing ? (
						<div className="cmd-form">
							<label htmlFor="cmd-name">名称</label>
							<input
								id="cmd-name"
								className="cmd-input"
								value={draft.name}
								placeholder="例如：启动开发服务器"
								autoFocus
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
							<label htmlFor="cmd-command">命令</label>
							<input
								id="cmd-command"
								className="cmd-input"
								value={draft.command}
								placeholder="例如：npm run dev"
								onChange={(e) =>
									setDraft({ ...draft, command: e.target.value })
								}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<label htmlFor="cmd-cwd">
								目录{" "}
								<span className="cmd-hint">（${"{pwd}"} = 当前工作目录）</span>
							</label>
							<input
								id="cmd-cwd"
								className="cmd-input"
								value={draft.cwd}
								placeholder="${pwd}"
								onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<div className="cmd-form-actions">
								<button type="button" className="btn" onClick={cancelEdit}>
									取消
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={!draft.name.trim() || !draft.command.trim()}
									onClick={saveDraft}
								>
									保存
								</button>
							</div>
						</div>
					) : (
						<>
							{chat.commands.length === 0 && (
								<div className="panel-empty">还没有命令，点 + 添加一个</div>
							)}
							{chat.commands.map((c, i) => (
								<div key={i} className="cmd-item">
									<button
										type="button"
										className="cmd-run"
										title="点击运行"
										onClick={() => runCommand(c)}
									>
										<FiPlay />
									</button>
									<button
										type="button"
										className="cmd-main"
										title="点击运行"
										onClick={() => runCommand(c)}
									>
										<span className="cmd-name">{c.name}</span>
										<span className="cmd-command">{c.command}</span>
										{c.cwd && <span className="cmd-cwd">{c.cwd}</span>}
									</button>
									<button
										type="button"
										className="cmd-act"
										title="编辑"
										onClick={() => startEdit(i)}
									>
										<FiEdit2 />
									</button>
									<button
										type="button"
										className={`cmd-act del ${confirmDel === i ? "confirm" : ""}`}
										title="删除"
										onClick={() => requestDelete(i)}
									>
										{confirmDel === i ? "确认?" : <FiTrash2 />}
									</button>
								</div>
							))}
						</>
					)}
				</div>

				<div className="panel-footer">
					<div className="cmd-file" title={chat.commandsPath}>
						<FiFileText className="cmd-file-icon" />
						<span className="cmd-file-path">
							{chat.commandsPath || ".pi/commands.json"}
						</span>
					</div>
					<div className="cmd-file-hint">${"{pwd}"} 指代当前工作目录</div>
				</div>
			</aside>

			{/* ---------------- middle: terminals ---------------- */}
			<div className="term-main">
				{chat.terminals.length === 0 ? (
					<div className="term-empty">
						<FiTerminal className="term-empty-icon" />
						<div className="term-empty-title">内置终端</div>
						<div className="term-empty-sub">
							点击左侧命令运行，或点右侧 + 新建终端
						</div>
					</div>
				) : (
					chat.terminals.map((t) => (
						<TermXterm
							key={t.id}
							terminalId={t.id}
							command={t.command}
							cwd={t.cwd}
							active={t.id === activeId}
							send={send}
							register={terminal.register}
						/>
					))
				)}
			</div>

			{/* ---------------- right: terminal tabs ---------------- */}
			<aside className="term-side term-tabs">
				<div className="panel-header">
					<span className="panel-title">终端</span>
					<button
						type="button"
						className="panel-new"
						title="新建终端"
						onClick={openShell}
					>
						<FiPlus />
					</button>
				</div>
				<div className="panel-body">
					{chat.terminals.length === 0 && (
						<div className="panel-empty">暂无终端</div>
					)}
					{chat.terminals.map((t) => (
						<div
							key={t.id}
							className={`term-tab ${t.id === activeId ? "active" : ""}`}
						>
							<button
								type="button"
								className="term-tab-main"
								title={`${t.cwd}${t.command ? `\n> ${t.command.command}` : ""}`}
								onClick={() => setActiveId(t.id)}
							>
								<span
									className={`term-tab-dot ${t.running ? "run" : "exit"}`}
								/>
								<span className="term-tab-title">
									{t.title}
									{!t.running && (
										<span className="term-tab-exit">
											（已退出{t.exitCode !== null ? ` ${t.exitCode}` : ""}）
										</span>
									)}
								</span>
							</button>
							<button
								type="button"
								className="term-tab-close"
								title="关闭终端"
								onClick={() => closeTab(t.id)}
							>
								<FiX />
							</button>
						</div>
					))}
				</div>
			</aside>
		</div>
	);
}
