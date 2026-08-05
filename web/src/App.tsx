import { useCallback, useEffect, useRef, useState } from "react";
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
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import { useT } from "./i18n";
import { DropOverlay, type DropZoneState } from "./components/DropOverlay";
import {
	collectDroppedFiles,
	dragHasFiles,
	uploadFile,
	type DroppedFile,
	type UploadResult,
} from "./upload";
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
	mode: "inline" | "reference" | "lines";
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
}

export function App() {
	const t = useT();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	const [view, setView] = useState<"chat" | "terminal">("chat");
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);

	// -- OS file drag & drop ---------------------------------------------------
	// Full-window hint state: which zone the cursor is over (right panel = copy,
	// chat area = reference). The overlay itself is pointer-events none; each
	// zone performs the drop. Depth counters tame dragenter/dragleave flapping.
	const [dropZone, setDropZone] = useState<DropZoneState | null>(null);
	const chatDragDepth = useRef(0);
	// Staging dir inside the client's workspace (gitignored) for files dropped
	// on the chat area — the agent can read them via the reference path.
	const UPLOAD_STAGING = ".pi-web/uploads";

	// Upload dropped files; then either report the copy or attach the top-level
	// dropped items (files/folders) as reference chips.
	const runUploads = async (
		files: DroppedFile[],
		destDir: string,
		kind: "copy" | "reference",
	) => {
		if (files.length === 0) {
			pushNotice("warning", t("dropNoFiles"));
			return;
		}
		const results: UploadResult[] = [];
		for (const df of files) {
			const r = await uploadFile(df.file, destDir, df.relPath);
			results.push(r);
			if (!r.ok) pushNotice("error", t("dropUploadError", { error: r.error }));
		}
		const ok = results.filter(
			(r): r is Extract<UploadResult, { ok: true }> => r.ok,
		);
		if (ok.length === 0) return;
		if (kind === "copy") {
			pushNotice(
				"info",
				t("dropCopied", { n: ok.length, path: destDir || "/" }),
			);
			send({ type: "list_files", path: destDir === "" ? undefined : destDir });
		} else {
			// Reference: upload into the staging dir, then attach each top-level
			// dropped item (file, or folder root) as a reference chip.
			const tops = new Map<string, boolean>(); // path → isDir
			for (const r of ok) {
				const rest = r.path.startsWith(`${UPLOAD_STAGING}/`)
					? r.path.slice(UPLOAD_STAGING.length + 1)
					: r.path;
				const top = rest.split("/")[0];
				tops.set(`${UPLOAD_STAGING}/${top}`, rest.includes("/"));
			}
			for (const [p, isDir] of tops) {
				attach(p, p.split("/").pop() ?? p, "reference", isDir);
			}
			pushNotice(
				"info",
				t(
					ok.length === 1 ? "dropReferenced" : "dropReferencedN",
					ok.length === 1
						? { path: [...tops.keys()][0] }
						: { n: tops.size },
				),
			);
		}
	};
	const onPanelDrop = (destDir: string, dt: DataTransfer) => {
		void collectDroppedFiles(dt).then((files) =>
			runUploads(files, destDir, "copy"),
		);
	};
	const onChatDrop = (dt: DataTransfer) => {
		void collectDroppedFiles(dt).then((files) =>
			runUploads(files, UPLOAD_STAGING, "reference"),
		);
	};

	// Keep the browser from navigating/opening files dropped anywhere outside
	// the drop zones, and clear the hint when the drag ends elsewhere.
	useEffect(() => {
		const onDragOver = (e: DragEvent) => {
			if (dragHasFiles(e)) e.preventDefault();
		};
		const onDrop = (e: DragEvent) => {
			if (dragHasFiles(e)) {
				e.preventDefault();
				setDropZone(null);
			}
		};
		const onDragEnd = () => setDropZone(null);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		window.addEventListener("dragend", onDragEnd);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
			window.removeEventListener("dragend", onDragEnd);
		};
	}, []);

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
		mode: "inline" | "reference" | "lines",
		isDir = false,
		lines?: { start: number; end: number },
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some(
				(a) =>
					`${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` ===
					key,
			)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	};
	const removeAttachment = (path: string) =>
		setAttachments((prev) => prev.filter((a) => a.path !== path));

	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized).
	const onEditMessage = useCallback(
		(messageId: string, text: string) => {
			send({ type: "edit_message", messageId, text });
		},
		[send],
	);

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
					<main
						className="main"
						onDragEnter={(e) => {
							if (!dragHasFiles(e)) return;
							chatDragDepth.current += 1;
							if (chatDragDepth.current === 1)
								setDropZone({ kind: "chat", folder: null });
						}}
						onDragOver={(e) => {
							if (!dragHasFiles(e)) return;
							e.preventDefault();
							e.dataTransfer.dropEffect = "copy";
						}}
						onDragLeave={(e) => {
							if (!dragHasFiles(e)) return;
							chatDragDepth.current -= 1;
							if (chatDragDepth.current <= 0) {
								chatDragDepth.current = 0;
								setDropZone(null);
							}
						}}
						onDrop={(e) => {
							if (!dragHasFiles(e)) return;
							e.preventDefault();
							chatDragDepth.current = 0;
							setDropZone(null);
							onChatDrop(e.dataTransfer);
						}}
					>
						{chat.state ? (
							<MessageList
								key={chat.state.conversationId ?? "boot"}
								state={chat.state}
								liveOutputs={chat.liveOutputs}
								onEdit={onEditMessage}
							/>
						) : (
							<div className="boot-wait">
								{chat.ready ? t("loadingSession") : t("connectingServer")}
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
					<RightPanel
						chat={chat}
						send={send}
						onAttach={attach}
						onPreview={(path, name) => setPreviewFile({ path, name })}
						onDragState={(folder) =>
							setDropZone(
								folder === null ? null : { kind: "panel", folder },
							)
						}
						onDropFiles={onPanelDrop}
					/>
				</div>
				<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
					<TerminalPanel chat={chat} send={send} terminal={terminal} />
				</div>
			</div>
			<FooterBar chat={chat} send={send} />
			{chat.dialog && <Dialog dialog={chat.dialog} send={send} />}
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					send={send}
					onAddLines={(path, name, start, end) =>
						attach(path, name, "lines", false, { start, end })
					}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
				/>
			)}
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
			<DropOverlay zone={dropZone} />
		</div>
	);
}
