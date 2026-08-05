import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowDown } from "react-icons/fi";
import type { UiMessage, UiState } from "../types";
import { Message } from "./Message";
import { CollapsedMessage } from "./CollapsedMessage";
import { useT, type Translate } from "../i18n";

/** Stable shared empty map — passing this (instead of a fresh Map) lets
 *  React.memo skip messages that have no live tool output to show. */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();

/**
 * Messages beyond the most recent KEEP_RECENT are rendered as cheap collapsed
 * summary rows (no Markdown / thinking / tool output) until clicked. Only kicks
 * in once the chat grows past COLLAPSE_MIN, so short conversations are untouched.
 */
const KEEP_RECENT = 15;
const COLLAPSE_MIN = 30;

function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

/** Suggested prompts shown on the empty-state welcome page. */
const EXAMPLE_DEFS: {
	key: "ex.understand" | "ex.debug" | "ex.test" | "ex.review";
	icon: string;
}[] = [
	{ key: "ex.understand", icon: "🔍" },
	{ key: "ex.debug", icon: "🐛" },
	{ key: "ex.test", icon: "🧪" },
	{ key: "ex.review", icon: "🧹" },
];

function examples(
	t: Translate,
): { icon: string; text: string; prompt: string }[] {
	return EXAMPLE_DEFS.map(({ key, icon }) => ({
		icon,
		text: t(key),
		prompt: t(`${key}.prompt`),
	}));
}

interface MessageListProps {
	state: UiState;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	/** Edit-and-re-ask handler (forwarded to user message bubbles). */
	onEdit?: (messageId: string, text: string) => void;
}

export function MessageList({ state, liveOutputs, onEdit }: MessageListProps) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [stickBottom, setStickBottom] = useState(true);
	const stickRef = useRef(true);
	/** Messages the user expanded from the collapsed view — stay expanded. */
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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
	// Only the last KEEP_RECENT persisted messages are fully rendered; older
	// ones collapse to summary rows (unless the user expanded them).
	const recentStart =
		state.messages.length > COLLAPSE_MIN
			? Math.max(0, state.messages.length - KEEP_RECENT)
			: 0;

	const expand = useCallback((id: string) => {
		setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);
	const collapse = useCallback((id: string) => {
		setExpanded((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
	}, []);

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
						<h2 className="empty-title">{t("welcomeTitle")}</h2>
						<p className="empty-sub">{t("welcomeSub")}</p>
						<div className="empty-cwd">
							<span className="empty-cwd-label">{t("directory")}</span>
							<span className="empty-cwd-path">{state.cwd}</span>
						</div>
						<div className="empty-examples">
							{examples(t).map((ex) => (
								<button
									type="button"
									key={ex.prompt}
									className="empty-example"
									title={t("clickToFill")}
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
				{state.messages.map((m, i) => {
					const isOld = i < recentStart;
					const isExpandedOld = isOld && expanded.has(m.id);
					if (isOld && !isExpandedOld) {
						// toolResult content lives inside its toolCall card — nothing to
						// show in the collapsed row either.
						if (m.role === "toolResult") return null;
						return (
							<CollapsedMessage
								key={m.id}
								message={m}
								onExpand={expand}
							/>
						);
					}
					return (
						<Message
							key={m.id}
							message={m}
							toolResults={toolResults}
							liveOutputs={hasToolCall(m) ? liveOutputs : EMPTY_LIVE}
							streaming={state.isStreaming}
							isLast={m.id === lastId}
							onEdit={onEdit}
							onCollapse={isExpandedOld ? collapse : undefined}
						/>
					);
				})}
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
						onEdit={onEdit}
					/>
				)}
				{state.isStreaming && messages.length === 0 && (
					<div className="streaming-wait">{t("waitingResponse")}</div>
				)}
			</div>
			{!stickBottom && (
				<button
					type="button"
					className="scroll-bottom"
					onClick={scrollToBottom}
				>
					<FiArrowDown /> {t("backToBottom")}
				</button>
			)}
		</div>
	);
}
