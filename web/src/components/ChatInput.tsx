import { useEffect, useRef, useState } from "react";
import { FiSend, FiSquare } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import type { ClientMessage } from "../types";
import { useT } from "../i18n";

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
	const t = useT();
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
									? t("folderRef", { path: a.path })
									: a.mode === "reference"
										? t("refOnly", { path: a.path })
										: t("attachContent", { path: a.path })
							}
						>
							{a.isDir ? "📁" : a.mode === "reference" ? "🔗" : "📎"} {a.name}
							<button
								type="button"
								className="attach-remove"
								title={t("removeAttachment")}
								onClick={() => onRemoveAttachment(a.path)}
							>
								×
							</button>
						</span>
					))}
					<span className="attach-hint">{t("attachHint")}</span>
				</div>
			)}
			{streaming && queueTotal > 0 && state && (
				<div className="queue-hint">
					{state.queue.followUp > 0 && (
						<span>{t("followUpQueued", { n: state.queue.followUp })}</span>
					)}
					{state.queue.steering > 0 && (
						<span>{t("steeringQueued", { n: state.queue.steering })}</span>
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
								? t("placeholderStreaming")
								: t("placeholderIdle")
							: t("placeholderConnecting")
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
							title={t("stopAgent")}
							onClick={() => send({ type: "abort" })}
						>
							<FiSquare /> {t("stop")}
						</button>
					) : (
						<button
							type="button"
							className="btn send"
							title={t("sendTip")}
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
