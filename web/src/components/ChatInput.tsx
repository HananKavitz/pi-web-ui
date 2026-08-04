import { useEffect, useRef, useState } from "react";
import { FiSend, FiSquare } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import type { ClientMessage } from "../types";

interface ChatInputProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	/** Files/folders attached via the right panel, waiting to be sent. */
	attachments: {
		path: string;
		name: string;
		mode: "inline" | "reference";
		isDir?: boolean;
	}[];
	onRemoveAttachment: (path: string) => void;
	/** Called after a prompt is successfully sent — clears pending attachments. */
	onSent: () => void;
}

export function ChatInput({
	chat,
	send,
	attachments,
	onRemoveAttachment,
	onSent,
}: ChatInputProps) {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement>(null);

	const state = chat.state;
	const streaming = state?.isStreaming ?? false;
	const connected = chat.ready;
	const queueTotal = state ? state.queue.steering + state.queue.followUp : 0;

	// Fill the input from the welcome-page example cards.
	useEffect(() => {
		const onFill = (e: Event) => {
			const detail = (e as CustomEvent<string>).detail;
			setText(detail);
			taRef.current?.focus();
		};
		window.addEventListener("pi-web:fill", onFill);
		return () => window.removeEventListener("pi-web:fill", onFill);
	}, []);

	// Auto-grow the textarea.
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "0px";
		ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
	}, [text]);

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed || !connected || streaming) return;
		if (
			send({
				type: "prompt",
				text: trimmed,
				attachments: attachments.map((a) => ({
					path: a.path,
					mode: a.mode,
				})),
			})
		) {
			setText("");
			onSent();
			taRef.current?.focus();
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="inputbar">
			{attachments.length > 0 && (
				<div className="attach-row">
					{attachments.map((a) => (
						<span
							key={a.path}
							className={`attach-chip ${a.mode}`}
							title={
								a.isDir
									? `文件夹引用：${a.path}`
									: a.mode === "reference"
										? `仅引用：${a.path}`
										: `附加内容：${a.path}`
							}
						>
							{a.isDir ? "📁" : a.mode === "reference" ? "🔗" : "📎"} {a.name}
							<button
								type="button"
								className="attach-remove"
								title="移除附件"
								onClick={() => onRemoveAttachment(a.path)}
							>
								×
							</button>
						</span>
					))}
					<span className="attach-hint">将随下一条消息发送</span>
				</div>
			)}
			{streaming && queueTotal > 0 && state && (
				<div className="queue-hint">
					{state.queue.followUp > 0 && (
						<span>⏳ {state.queue.followUp} 条跟进消息排队中</span>
					)}
					{state.queue.steering > 0 && (
						<span>⏳ {state.queue.steering} 条转向消息排队中</span>
					)}
				</div>
			)}
			<div className="inputbox">
				<textarea
					ref={taRef}
					value={text}
					rows={1}
					placeholder={
						connected
							? streaming
								? "智能体正在工作中…（消息可排队发送）"
								: "给 pi 发送消息 — Enter 发送，Shift+Enter 换行"
							: "正在连接服务器…"
					}
					disabled={!connected}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
				/>
				<div className="inputbox-actions">
					{streaming ? (
						<button
							type="button"
							className="btn stop"
							title="停止智能体"
							onClick={() => send({ type: "abort" })}
						>
							<FiSquare /> 停止
						</button>
					) : (
						<button
							type="button"
							className="btn send"
							title="发送（Enter）"
							disabled={!connected || !text.trim()}
							onClick={submit}
						>
							<FiSend />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
