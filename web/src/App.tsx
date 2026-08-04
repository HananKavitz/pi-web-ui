import { useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { FooterBar } from "./components/FooterBar";
import { Dialog } from "./components/Dialog";
import { TerminalPanel } from "./components/TerminalPanel";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";
import { useChat } from "./use-chat";
import {
	loadSoundSettings,
	playSound,
	saveSoundSettings,
	type SoundKind,
	type SoundSettings,
} from "./sounds";

export interface PendingAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference";
	/** Folder path link (always reference mode). */
	isDir?: boolean;
}

export function App() {
	const { chat, send, dismissNotice, terminal } = useChat();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [view, setView] = useState<"chat" | "terminal">("chat");
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);

	// -- sound notifications --------------------------------------------------
	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
	const lastErrorNotice = useRef(0);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	// Run start / end cues (streaming edge transitions).
	useEffect(() => {
		const streaming = chat.state?.isStreaming ?? false;
		const prev = prevStreaming.current;
		prevStreaming.current = streaming;
		if (prev === null) return; // first observation — don't cue
		if (!prev && streaming) playSound("start", sound);
		else if (prev && !streaming) playSound("done", sound);
	}, [chat.state?.isStreaming, sound]);

	// Questionnaire cue — each new dialog id.
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && id !== prevDialogId.current) {
			playSound("question", sound);
		}
		prevDialogId.current = id;
	}, [chat.dialog, sound]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
		}
	}, [chat.notices, sound]);

	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference",
		isDir = false,
	) => {
		setAttachments((prev) =>
			prev.some((a) => a.path === path)
				? prev
				: [...prev, { path, name, mode, isDir }],
		);
	};
	const removeAttachment = (path: string) =>
		setAttachments((prev) => prev.filter((a) => a.path !== path));

	return (
		<div className="app">
			<TopBar
				chat={chat}
				send={send}
				view={view}
				onViewChange={setView}
				onManageModels={() => setManageModelsOpen(true)}
				sound={sound}
				onSoundChange={setSound}
				onSoundPreview={(kind: SoundKind) => playSound(kind, sound)}
			/>
			<div className="notices">
				{chat.notices.map((n) => (
					<button
						type="button"
						key={n.id}
						className={`notice notice-${n.level}`}
						onClick={() => dismissNotice(n.id)}
					>
						{n.text}
					</button>
				))}
			</div>
			<div className="layout">
				<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
					<LeftPanel chat={chat} send={send} />
					<main className="main">
						{chat.state ? (
							<MessageList state={chat.state} liveOutputs={chat.liveOutputs} />
						) : (
							<div className="boot-wait">
								{chat.ready ? "正在加载会话…" : "正在连接 pi-web-ui 服务器…"}
							</div>
						)}
						<ChatInput
							chat={chat}
							send={send}
							attachments={attachments}
							onRemoveAttachment={removeAttachment}
							onSent={() => setAttachments([])}
						/>
					</main>
					<RightPanel chat={chat} send={send} onAttach={attach} />
				</div>
				<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
					<TerminalPanel chat={chat} send={send} terminal={terminal} />
				</div>
			</div>
			<FooterBar chat={chat} send={send} />
			{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}
			{chat.ready &&
				chat.state &&
				chat.state.piConfigured === false &&
				!setupDismissed &&
				!manageModelsOpen && (
					<PiSetupModal
						send={send}
						piConfigured={chat.state.piConfigured}
						providers={chat.providers}
						installResult={chat.installResult}
						onClose={() => setSetupDismissed(true)}
					/>
				)}
			{manageModelsOpen && (
				<ModelConfigModal
					send={send}
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
		</div>
	);
}
