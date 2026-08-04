import { memo, useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import type {
	UiBashBlock,
	UiContentBlock,
	UiImageBlock,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
	UiToolCallBlock,
} from "../types";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";

// ---------------------------------------------------------------------------
// Narrowing guards. UiContentBlock is an open union (its last member is
// `{ type: string; [k: string]: unknown }`), so plain `switch` narrowing does
// not work — same pattern pi-vsc uses in shared/blocks.ts.
// ---------------------------------------------------------------------------

export function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" &&
		typeof (block as UiTextBlock).text === "string"
		? (block as UiTextBlock)
		: null;
}

export function asThinking(block: UiContentBlock): UiThinkingBlock | null {
	return block.type === "thinking" &&
		typeof (block as UiThinkingBlock).thinking === "string"
		? (block as UiThinkingBlock)
		: null;
}

export function asToolCall(block: UiContentBlock): UiToolCallBlock | null {
	return block.type === "toolCall" &&
		typeof (block as UiToolCallBlock).id === "string" &&
		typeof (block as UiToolCallBlock).name === "string"
		? (block as UiToolCallBlock)
		: null;
}

export function asImage(block: UiContentBlock): UiImageBlock | null {
	return block.type === "image" &&
		typeof (block as UiImageBlock).dataUrl === "string"
		? (block as UiImageBlock)
		: null;
}

export function asBash(block: UiContentBlock): UiBashBlock | null {
	return block.type === "bash" &&
		typeof (block as UiBashBlock).command === "string"
		? (block as UiBashBlock)
		: null;
}

interface MessageProps {
	message: UiMessage;
	/** All messages, used to look up toolResult messages by toolCallId. */
	all: UiMessage[];
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	streaming: boolean;
}

export const Message = memo(function Message({
	message,
	all,
	liveOutputs,
	streaming,
}: MessageProps) {
	const isLast = all.length > 0 && all[all.length - 1].id === message.id;
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment =
		message.role === "custom" && message.customType === "file";

	const toolResults = new Map<string, UiMessage>();
	for (const m of all) {
		if (m.role === "toolResult" && m.toolCallId)
			toolResults.set(m.toolCallId, m);
	}

	return (
		<div className={`msg msg-${message.role}`} data-role={message.role}>
			<div className="msg-meta">
				<span className="msg-role">
					{message.role === "custom"
						? message.customType === "file"
							? "附件"
							: `插件 · ${message.customType ?? "未知"}`
						: roleLabel(message.role)}
				</span>
				{message.model && <span className="msg-model">{message.model}</span>}
				{message.timestamp && (
					<span className="msg-time">{formatTime(message.timestamp)}</span>
				)}
			</div>
			<div className="msg-body">
				{message.errorMessage && (
					<div className="msg-error">{message.errorMessage}</div>
				)}
				{isFileAttachment ? (
					<AttachmentCard message={message} />
				) : (
					message.content.map((block, i) => (
						<Block
							key={`${message.id}-${i}`}
							block={block}
							toolResults={toolResults}
							liveOutputs={liveOutputs}
							streaming={streaming}
							isLast={isLast}
						/>
					))
				)}
			</div>
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message }: { message: UiMessage }) {
	const [open, setOpen] = useState(false);
	const details = (message.details ?? {}) as {
		name?: string;
		path?: string;
		mode?: "inline" | "reference";
		size?: number;
		lines?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? "附件";
	const isFolder = details.type === "folder";
	const isReference = details.mode === "reference";

	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const clean = stripFileWrapper(text);
	const image = message.content.find((b) => b.type === "image") as
		| { type: "image"; dataUrl?: string }
		| undefined;
	const lines = clean.split("\n").length;

	return (
		<div className={`attachcard ${isReference ? "reference" : ""}`}>
			<button
				type="button"
				className="attachcard-head"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="attachcard-icon">{isFolder ? "📁" : "📎"}</span>
				<span className="attachcard-name">{name}</span>
				{details.path && (
					<span className="attachcard-path">{details.path}</span>
				)}
				<span className={`attachcard-mode ${isReference ? "ref" : "inline"}`}>
					{isReference
						? isFolder
							? "文件夹 · 仅引用"
							: `仅引用 · ${formatSize(details.size)}`
						: image
							? "🖼 图片"
							: `内联 · ${details.lines ?? lines} 行`}
				</span>
				{!isReference && (open ? <FiChevronDown /> : <FiChevronRight />)}
			</button>
			{!isReference &&
				open &&
				(image?.dataUrl ? (
					<div className="attachcard-image">
						<img src={image.dataUrl} alt={name} />
					</div>
				) : (
					<pre className="attachcard-content">{clean}</pre>
				))}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder
						? "文件夹，未展开内容 —— 智能体会按需浏览目录"
						: `文件较大（${formatSize(details.size)}），未展开内容 —— 智能体会按需读取`}
				</div>
			)}
		</div>
	);
}

function formatSize(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** Strip the <file path="..."> ``` ... ``` </file> wrapper for display. */
function stripFileWrapper(text: string): string {
	const m = text.match(
		/^\s*<file path="[^"]*">\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/,
	);
	return m ? m[1].trim() : text.trim();
}

function Block({
	block,
	toolResults,
	liveOutputs,
	streaming,
	isLast,
}: {
	block: UiContentBlock;
	toolResults: Map<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	streaming: boolean;
	isLast: boolean;
}) {
	const text = asText(block);
	if (text) {
		return (
			<div className="msg-text">
				<Markdown text={text.text} />
				{text.truncated && (
					<div className="trunc-note">… 内容过长，当前视图已截断</div>
				)}
			</div>
		);
	}

	const thinking = asThinking(block);
	if (thinking) {
		return (
			<ThinkingBlock
				thinking={thinking.thinking}
				streaming={streaming && isLast}
			/>
		);
	}

	const toolCall = asToolCall(block);
	if (toolCall) {
		const result = toolResults.get(toolCall.id);
		const live = liveOutputs.get(toolCall.id);
		const view: ToolView = { result, liveOutput: live?.text, streaming };
		return <ToolCallBlock block={toolCall} view={view} />;
	}

	const image = asImage(block);
	if (image && image.dataUrl) {
		return (
			<div className="msg-image">
				<img src={image.dataUrl} alt="attachment" />
			</div>
		);
	}

	const bash = asBash(block);
	if (bash) {
		return (
			<div className="bashblock">
				<div className="bashblock-command">
					<span className="bashblock-prompt">$</span>
					<code>{bash.command}</code>
					{bash.exitCode !== undefined && (
						<span
							className={`bashblock-exit ${bash.exitCode === 0 ? "ok" : "err"}`}
						>
							退出码 {bash.exitCode}
						</span>
					)}
					{bash.cancelled && <span className="bashblock-exit err">已取消</span>}
				</div>
				{bash.output && <pre className="bashblock-output">{bash.output}</pre>}
				{bash.truncated && (
					<div className="trunc-note">… 输出过长，当前视图已截断</div>
				)}
			</div>
		);
	}

	return null;
}

function roleLabel(role: string): string {
	switch (role) {
		case "user":
			return "你";
		case "assistant":
			return "pi";
		case "toolResult":
			return "工具";
		case "bashExecution":
			return "终端";
		case "branchSummary":
			return "分支摘要";
		case "compactionSummary":
			return "上下文已压缩";
		default:
			return role;
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
