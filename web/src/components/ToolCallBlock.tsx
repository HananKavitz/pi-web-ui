import { memo, useState } from "react";
import {
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiCopy,
	FiTerminal,
} from "react-icons/fi";
import type { UiMessage, UiToolCallBlock } from "../types";

export interface ToolView {
	/** Tool result message if the tool already finished. */
	result?: UiMessage;
	/** Live output accumulated from tool_delta while running. */
	liveOutput?: string;
	/** True when the session is streaming (tool may still be running). */
	streaming: boolean;
}

const TOOL_ICONS: Record<string, string> = {
	bash: "$",
	read: "📄",
	write: "✍️",
	edit: "✏️",
	grep: "🔍",
	find: "🧭",
	ls: "📂",
};

function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "🛠";
}

export const ToolCallBlock = memo(function ToolCallBlock({
	block,
	view,
}: {
	block: UiToolCallBlock;
	view: ToolView;
}) {
	const [open, setOpen] = useState(true);
	const [copied, setCopied] = useState(false);

	const running = !view.result && view.streaming;
	const done = view.result !== undefined;
	const isError = view.result?.isError ?? false;

	const output = view.result
		? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
		: (view.liveOutput ?? "");

	const statusClass = isError ? "err" : done ? "ok" : running ? "run" : "idle";
	const statusLabel = isError
		? "出错"
		: done
			? "完成"
			: running
				? "执行中…"
				: "排队中";

	const copyArgs = () => {
		if (block.argumentsText) {
			void navigator.clipboard.writeText(block.argumentsText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	};

	return (
		<div className={`toolcall ${statusClass}`}>
			<div className="toolcall-head">
				<span className="toolcall-icon">{toolIcon(block.name)}</span>
				<span className="toolcall-name">{block.name}</span>
				<span className="toolcall-status">{statusLabel}</span>
				<span className="toolcall-spacer" />
				<button
					type="button"
					className="toolcall-copy"
					title="复制参数"
					onClick={copyArgs}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
				<button
					type="button"
					className="toolcall-toggle"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? <FiChevronDown /> : <FiChevronRight />}
				</button>
			</div>
			{open && (
				<div className="toolcall-body">
					{block.argumentsText && (
						<div className="toolcall-args">
							{block.name === "bash" && block.argumentsText.startsWith("{") ? (
								<TerminalCommand args={block.argumentsText} />
							) : (
								<pre>{block.argumentsText}</pre>
							)}
						</div>
					)}
					{output.length > 0 && (
						<div className="toolcall-output">
							<div className="toolcall-output-label">
								{isError ? "错误输出" : "输出"}
								{running && <span className="cursor" />}
							</div>
							<pre>{output}</pre>
						</div>
					)}
					{running && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> 等待输出…
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/** Pretty-print a bash tool call's arguments as a terminal line. */
function TerminalCommand({ args }: { args: string }) {
	let parsed: { command?: string; timeout?: number } | null = null;
	try {
		parsed = JSON.parse(args) as { command?: string; timeout?: number };
	} catch {
		return <pre>{args}</pre>;
	}
	if (typeof parsed.command !== "string") return <pre>{args}</pre>;
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{parsed.command}</code>
			{typeof parsed.timeout === "number" && (
				<span className="termline-timeout">⏱ {parsed.timeout}s</span>
			)}
		</div>
	);
}
