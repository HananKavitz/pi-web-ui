import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { UiMessage, UiState } from "../types";
import { Message } from "./Message";

/** Stable shared empty map — passing this (instead of a fresh Map) lets
 *  React.memo skip messages that have no live tool output to show. */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

/** Suggested prompts shown on the empty-state welcome page. */
const EXAMPLES: { icon: string; text: string; prompt: string }[] = [
	{
		icon: "🔍",
		text: "了解这个项目",
		prompt: "介绍一下这个项目：整体结构、主要模块和如何运行？",
	},
	{
		icon: "🐛",
		text: "排查一个问题",
		prompt: "帮我排查一个 bug，请先说明问题现象，我会补充细节。",
	},
	{
		icon: "🧪",
		text: "编写测试",
		prompt: "为项目的核心模块编写单元测试。",
	},
	{
		icon: "🧹",
		text: "代码审查",
		prompt: "审查最近改动的代码，指出潜在问题和改进建议。",
	},
];

interface MessageListProps {
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
}

export function MessageList({ state, liveOutputs }: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	/** Persisted messages + the live in-progress assistant message (if any). */
	const messages = state.streamingMessage
		? [...state.messages, state.streamingMessage]
		: state.messages;
	/**
	 * toolResult lookup, memoized on the messages array. The server keeps the
	 * array reference stable while the message set is unchanged, so this Map is
	 * rebuilt only when a new tool result actually arrives — not every snapshot.
	 */
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of state.messages) {
			if (msg.role === "toolResult" && msg.toolCallId)
				m.set(msg.toolCallId, msg);
		}
		return m;
	}, [state.messages]);
	const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		stickRef.current = nearBottom;
		setStickBottom(nearBottom);
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, state.isStreaming, liveOutputs]);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		stickRef.current = true;
		setStickBottom(true);
	}, []);

	return (
		<div className="messages-wrap">
			<div className="messages" ref={scrollRef} onScroll={onScroll}>
				{state.messages.length === 0 && !state.streamingMessage && (
					<div className="empty-state">
						<div className="empty-logo-wrap">
							<div className="empty-logo">π</div>
						</div>
						<h2 className="empty-title">pi 编码智能体</h2>
						<p className="empty-sub">检查、编辑、运行 —— 随时待命</p>
						<div className="empty-cwd">
							<span className="empty-cwd-label">目录</span>
							<span className="empty-cwd-path">{state.cwd}</span>
						</div>
						<div className="empty-examples">
							{EXAMPLES.map((ex) => (
								<button
									type="button"
									key={ex.prompt}
									className="empty-example"
									title="点击填入输入框"
									onClick={() =>
										window.dispatchEvent(
											new CustomEvent("pi-web:fill", { detail: ex.prompt }),
										)
									}
								>
									<span className="empty-example-icon">{ex.icon}</span>
									<span className="empty-example-text">{ex.text}</span>
								</button>
							))}
						</div>
					</div>
				)}
				{state.messages.map((m) => (
					<Message
						key={m.id}
						message={m}
						toolResults={toolResults}
						liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
						streaming={state.isStreaming}
						isLast={m.id === lastId}
					/>
				))}
				{state.streamingMessage && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						toolResults={toolResults}
						liveOutputs={
							hasToolCall(state.streamingMessage) ? liveOutputs : EMPTY_LIVE
						}
						streaming
						isLast
					/>
				)}
				{state.isStreaming && messages.length === 0 && (
					<div className="streaming-wait">正在等待模型响应…</div>
				)}
			</div>
			{!stickBottom && (
				<button
					type="button"
					className="scroll-bottom"
					onClick={scrollToBottom}
				>
					<FiArrowDown /> 回到底部
				</button>
			)}
		</div>
	);
}
