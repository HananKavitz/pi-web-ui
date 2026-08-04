import type { ChatState } from "../use-chat";

interface FooterBarProps {
	chat: ChatState;
}

/** Compact status bar: connection, context usage, cost, session, queue. */
export function FooterBar({ chat }: FooterBarProps) {
	const state = chat.state;
	if (!state) return null;
	const s = state.stats;

	const connClass = chat.ready ? "ok" : "busy";
	const connLabel = chat.ready ? "已连接" : "连接中…";

	const context = s.contextUsage;
	const ctxText =
		context.tokens !== null && context.percent !== null
			? `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
			: "—";
	const ctxPercent = context.percent ?? null;
	const ctxBarClass =
		ctxPercent === null
			? ""
			: ctxPercent >= 80
				? "warn"
				: ctxPercent >= 50
					? "mid"
					: "ok";

	const queueTotal = state.queue.steering + state.queue.followUp;

	return (
		<footer className="statusbar">
			<span className={`status-dot ${connClass}`} title={connLabel} />
			<span className="status-item">{connLabel}</span>
			<span className="status-sep">·</span>

			<span className="status-item" title="上下文用量">
				上下文
				<span className={`ctx-bar ${ctxBarClass}`}>
					{ctxPercent !== null && (
						<span
							className="ctx-bar-fill"
							style={{ width: `${Math.min(ctxPercent, 100)}%` }}
						/>
					)}
				</span>
				{ctxText}
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title="累计成本">
				${formatCost(s.cost)}
			</span>
			<span className="status-sep">·</span>

			<span className="status-item" title="会话消息数">
				消息 {s.totalMessages}
			</span>

			{chat.statuses.length > 0 && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item ext-status" title="插件状态">
						{chat.statuses.map((st) => st.text).join(" · ")}
					</span>
				</>
			)}

			{state.isStreaming && (
				<>
					<span className="status-sep">·</span>
					<span className="status-item working">
						<span className="working-spin" />
						工作中
						{queueTotal > 0 && (
							<span className="status-queue">⏳ {queueTotal} 排队</span>
						)}
					</span>
				</>
			)}

			<span className="status-item status-cwd" title={`工作目录：${state.cwd}`}>
				📁 {state.cwd}
			</span>
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
