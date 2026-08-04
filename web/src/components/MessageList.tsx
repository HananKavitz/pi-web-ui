import { useCallback, useEffect, useRef, useState } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { UiState } from "../types";
import { Message } from "./Message";

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
						all={messages}
						liveOutputs={liveOutputs}
						streaming={state.isStreaming}
					/>
				))}
				{state.streamingMessage && (
					<Message
						key={state.streamingMessage.id}
						message={state.streamingMessage}
						all={messages}
						liveOutputs={liveOutputs}
						streaming
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
