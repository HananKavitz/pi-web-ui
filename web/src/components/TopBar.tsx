import { useEffect, useState } from "react";
import {
	FiCpu,
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
			| { type: "list_models_config" },
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
	// Local loading flag for the model dropdown (list arrives via chat.models).
	const [modelsLoading, setModelsLoading] = useState(false);

	const thinkingLevels: { value: string; label: string }[] =
		THINKING_VALUES.map((v) => ({ value: v, label: t(`thinking.${v}`) }));
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
			</div>
		</header>
	);
}
