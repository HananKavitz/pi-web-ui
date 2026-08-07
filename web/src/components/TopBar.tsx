import { useEffect, useState } from "react";
import {
	FiCpu,
	FiDownload,
	FiGlobe,
	FiMessageSquare,
	FiPlus,
	FiTerminal,
	FiVolume2,
	FiZap,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, type Locale } from "../i18n";

interface TopBarProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "list_models" }
			| { type: "set_model"; modelId: string }
			| { type: "set_thinking"; level: string }
			| { type: "new_chat" }
			| { type: "list_models_config" }
			| { type: "check_update" }
			| { type: "update_app" },
	) => boolean;
	view: "chat" | "terminal";
	onViewChange: (view: "chat" | "terminal") => void;
	/** Open the custom model config panel. */
	onManageModels: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
}

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function TopBar({
	chat,
	send,
	view,
	onViewChange,
	onManageModels,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const state = chat.state;
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	/** Two-step arm before 立即更新 actually runs npm i -g. */
	const [updateArmed, setUpdateArmed] = useState(false);
	// Local loading flag for the model dropdown (list arrives via chat.models).
	const [modelsLoading, setModelsLoading] = useState(false);

	// Model-supported thinking levels (snapshot). The SDK clamps any request
	// outside this set — unsupported levels must be disabled, not silently
	// snapped (that's what made the level look "impossible to change").
	// Empty/absent → unknown, keep everything enabled.
	const supportedThinking =
		state?.availableThinkingLevels && state.availableThinkingLevels.length > 0
			? new Set(state.availableThinkingLevels)
			: null;
	const thinkingLevels: {
		value: string;
		label: string;
		supported: boolean;
	}[] = THINKING_VALUES.map((v) => ({
		value: v,
		label: t(`thinking.${v}`),
		supported: supportedThinking ? supportedThinking.has(v) : true,
	}));
	const thinkingLabel = (level: string): string =>
		thinkingLevels.find((l) => l.value === level)?.label ?? level;

	const LANGUAGES: { value: Locale; label: string }[] = [
		{ value: "zh", label: t("langZh") },
		{ value: "en", label: t("langEn") },
	];

	// Lazily fetch the model list when the dropdown opens for the first time.
	useEffect(() => {
		if (modelOpen && chat.models.length === 0 && !modelsLoading) {
			setModelsLoading(true);
			send({ type: "list_models" });
		}
	}, [modelOpen, chat.models.length, modelsLoading, send]);
	useEffect(() => {
		if (chat.models.length > 0) setModelsLoading(false);
	}, [chat.models.length]);

	const connLabel = chat.ready
		? t("connected")
		: chat.status === "closed"
			? t("reconnecting")
			: t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

	return (
		<header className="topbar">
			<div className="brand">
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			<div className="topbar-actions">
				<div
					className="view-switch"
					role="tablist"
					aria-label={t("viewSwitch")}
				>
					<button
						type="button"
						role="tab"
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>{t("terminal")}</span>
					</button>
				</div>
				<Dropdown
					trigger={
						<>
							<FiCpu />
							<span className="chip-model">
								{model ? model.name : t("selectModel")}
							</span>
							{model && <span className="chip-sub">{model.provider}</span>}
						</>
					}
					open={modelOpen}
					onOpenChange={setModelOpen}
				>
					<div className="dd-header">{t("availableModels")}</div>
					{(modelsLoading || chat.modelsLoading) && (
						<div className="dd-loading">{t("loading")}</div>
					)}
					{chat.models.length === 0 &&
						!modelsLoading &&
						!chat.modelsLoading && (
							<div className="dd-loading">{t("noModels")}</div>
						)}
					{chat.models.map((m) => (
						<DropdownItem
							key={m.id}
							active={currentModelId === m.id}
							onClick={() => {
								if (currentModelId !== m.id) {
									send({ type: "set_model", modelId: m.id });
								}
								setModelOpen(false);
							}}
						>
							<span className="dd-model-name">{m.name}</span>
							<span className="dd-model-sub">
								{m.provider}
								{m.reasoning ? ` · ${t("reasoning")}` : ""}
							</span>
						</DropdownItem>
					))}
					<button
						type="button"
						className="dd-refresh"
						onClick={() => send({ type: "list_models" })}
					>
						{t("refreshModels")}
					</button>
					<button
						type="button"
						className="dd-refresh"
						onClick={() => {
							setModelOpen(false);
							onManageModels();
						}}
					>
						{t("manageModels")}
					</button>
				</Dropdown>

				<Dropdown
					trigger={
						<>
							<FiZap />
							<span className="chip-sub">
								{t("thinkingChip", {
									level: state ? thinkingLabel(state.thinkingLevel) : "—",
								})}
							</span>
						</>
					}
					open={thinkingOpen}
					onOpenChange={setThinkingOpen}
				>
					<div className="dd-header">{t("thinkingLevel")}</div>
					{thinkingLevels.map((l) => (
						<DropdownItem
							key={l.value}
							active={state?.thinkingLevel === l.value}
							disabled={!l.supported}
							title={l.supported ? undefined : t("thinkingUnsupported")}
							onClick={() => {
								if (state?.thinkingLevel !== l.value) {
									send({ type: "set_thinking", level: l.value });
								}
								setThinkingOpen(false);
							}}
						>
							{l.label}
						</DropdownItem>
					))}
				</Dropdown>

				<Dropdown
					trigger={
						<>
							<FiVolume2 />
							<span className="chip-sub">{t("sound")}</span>
						</>
					}
					open={soundOpen}
					onOpenChange={setSoundOpen}
				>
					<SoundSettingsPanel
						settings={sound}
						onChange={onSoundChange}
						onPreview={onSoundPreview}
					/>
				</Dropdown>

				<Dropdown
					trigger={
						<>
							<FiGlobe />
							<span className="chip-sub">
								{locale === "zh" ? t("langZh") : "EN"}
							</span>
						</>
					}
					open={langOpen}
					onOpenChange={setLangOpen}
				>
					<div className="dd-header">{t("language")}</div>
					{LANGUAGES.map((l) => (
						<DropdownItem
							key={l.value}
							active={locale === l.value}
							onClick={() => {
								setLocale(l.value);
								setLangOpen(false);
							}}
						>
							{l.label}
						</DropdownItem>
					))}
				</Dropdown>

				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>

				<Dropdown
					trigger={
						<>
							<FiDownload />
							<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
							{chat.update &&
								!chat.update.upToDate &&
								!chat.update.pendingRestart && (
									<span
										className="update-dot"
										title={t("updateAvailable", {
											version: chat.update.latest ?? "",
										})}
									/>
								)}
						</>
					}
					open={updateOpen}
					onOpenChange={(v) => {
						setUpdateOpen(v);
						setUpdateArmed(false);
						if (v) send({ type: "check_update" });
					}}
					fit
				>
					<div className="dd-header">{t("update")}</div>
					<div className="dd-update">
						<div className="dd-row">
							<span>{t("currentVersion")}</span>
							<b>v{chat.update?.current ?? "…"}</b>
						</div>
						<div className="dd-row">
							<span>{t("latestVersion")}</span>
							<b>
								{chat.update === null
									? t("checkingUpdate")
									: chat.update.error
										? chat.update.error
										: chat.update.latest
											? `v${chat.update.latest}`
											: t("checkingUpdate")}
							</b>
						</div>
						{chat.update?.pendingRestart && (
							<div className="dd-note ok">{t("updateSuccess")}</div>
						)}
						{chat.update &&
							!chat.update.pendingRestart &&
							chat.update.upToDate && (
								<div className="dd-note ok">{t("upToDate")}</div>
							)}
						{chat.update &&
							!chat.update.pendingRestart &&
							!chat.update.upToDate &&
							chat.update.latest && (
								<div className="dd-note warn">
									{t("updateAvailable", { version: chat.update.latest })}
								</div>
							)}
						{chat.update?.latestPublishedAt &&
							Date.now() - new Date(chat.update.latestPublishedAt).getTime() <
								30 * 60_000 && (
								<div className="dd-note warn">
									{t("updateJustPublished", {
										version: chat.update.latest ?? "",
									})}
								</div>
							)}
						{chat.updateResult && !chat.updateResult.ok && (
							<div className="dd-note err">
								{t("updateFailed", { detail: chat.updateResult.detail })}
							</div>
						)}
						{chat.update?.pendingRestart && (
							<div className="dd-note">{t("restartHint")}</div>
						)}
					</div>
					<div className="dd-actions">
						<button
							type="button"
							className="dd-refresh"
							onClick={() => send({ type: "check_update" })}
						>
							{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
						</button>
						{chat.update &&
							!chat.update.pendingRestart &&
							!chat.update.upToDate &&
							chat.update.latest && (
								<button
									type="button"
									className={`dd-refresh accent ${updateArmed ? "armed" : ""}`}
									onClick={() => {
										if (!updateArmed) {
											setUpdateArmed(true);
											return;
										}
										setUpdateArmed(false);
										setUpdateOpen(false);
										send({ type: "update_app" });
									}}
								>
									{updateArmed ? t("confirmUpdate") : t("updateNow")}
								</button>
							)}
					</div>
				</Dropdown>
			</div>
		</header>
	);
}
