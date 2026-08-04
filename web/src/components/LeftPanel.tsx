import { FiMessageSquare, FiSquare } from "react-icons/fi";
import type { SessionSummary } from "../types";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";

interface LeftPanelProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "switch_session"; path: string },
	) => boolean;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function LeftPanel({ chat, send }: LeftPanelProps) {
	const t = useT();
	const currentFile = chat.state?.sessionFile;
	const sessions = chat.sessions;

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	return (
		<aside className="panel panel-left">
			<div className="panel-header">
				<span className="panel-title">{t("chat")}</span>
				<button
					type="button"
					className="panel-new"
					title={t("newChat")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiSquare />
				</button>
			</div>
			<div className="panel-body">
				{sessions.length === 0 && (
					<div className="panel-empty">{t("noHistory")}</div>
				)}
				{sessions.map((s) => {
					const active = currentFile === s.path;
					return (
						<button
							type="button"
							key={s.path}
							className={`session-item ${active ? "active" : ""}`}
							title={s.path}
							onClick={() => {
								if (!active) send({ type: "switch_session", path: s.path });
							}}
						>
							<FiMessageSquare className="session-icon" />
							<span className="session-info">
								<span className="session-title">{displayName(s)}</span>
								<span className="session-sub">
									{active
										? t("current")
										: t("messageCount", { n: s.messageCount })}
									{s.source === "tui" && (
										<span className="session-src" title={t("tuiTip")}>
											TUI
										</span>
									)}
								</span>
							</span>
							<span className="session-time">{formatModified(s.modified)}</span>
						</button>
					);
				})}
			</div>
			<div className="panel-footer">
				<button
					type="button"
					className="panel-refresh"
					onClick={() => send({ type: "list_sessions" })}
				>
					{t("refreshList")}
				</button>
			</div>
		</aside>
	);
}
