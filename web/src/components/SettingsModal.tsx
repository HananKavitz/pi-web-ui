import { useEffect, useRef, useState } from "react";
import { FiCpu, FiEye, FiPackage, FiPlus, FiSettings, FiTrash2, FiX, FiZap } from "react-icons/fi";
import type {
	ClientMessage,
	UiExtensionInfo,
	UiSettingsState,
	UiSkillInfo,
} from "../types";
import { useT } from "../i18n";

interface SettingsModalProps {
	chat: { settings: UiSettingsState | null };
	send: (msg: ClientMessage) => boolean;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
function ToggleRow({
	title,
	subtitle,
	enabled,
	onToggle,
}: {
	title: string;
	subtitle: string;
	enabled: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">{title}</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

export function SettingsModal({ chat, send, onClose }: SettingsModalProps) {
	const t = useT();
	const settings = chat.settings;

	// Prompt draft — local while typing; re-synced from the server on each push
	// UNLESS the textarea is focused (an echo must not clobber mid-edit text).
	const [promptDraft, setPromptDraft] = useState("");
	const [promptMode, setPromptMode] = useState<"append" | "replace">("append");
	const promptFocus = useRef(false);
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");

	useEffect(() => {
		if (!settings) return;
		setPromptMode(settings.promptMode);
		if (!promptFocus.current) setPromptDraft(settings.customSystemPrompt);
		setVbPromptMode(settings.visionBridgePromptMode);
		if (!vbPromptFocus.current) setVbPromptDraft(settings.visionBridgePrompt);
	}, [settings]);

	if (!settings) return null;

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
	}) => send({ type: "set_settings", ...patch });

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	const savePrompt = () =>
		setPartial({ promptMode, customSystemPrompt: promptDraft });

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
				</div>
				<p className="modal-desc">{t("settingsDesc")}</p>

				{/* ---- system prompt -------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiZap className="set-section-icon" />
						{t("settingsSystemPrompt")}
					</div>
					<div className="set-mode-row">
						<label className="set-field-label">{t("settingsPromptMode")}</label>
						<select
							className="set-select"
							value={promptMode}
							onChange={(e) => {
								const mode = e.target.value as "append" | "replace";
								setPromptMode(mode);
								setPartial({ promptMode: mode });
							}}
						>
							<option value="append">{t("promptModeAppend")}</option>
							<option value="replace">{t("promptModeReplace")}</option>
						</select>
					</div>
					<textarea
						className="set-prompt-input"
						rows={6}
						placeholder={t("promptPlaceholder")}
						value={promptDraft}
						onFocus={() => (promptFocus.current = true)}
						onBlur={() => {
							promptFocus.current = false;
							savePrompt();
						}}
						onChange={(e) => setPromptDraft(e.target.value)}
					/>
					<p className="set-hint">
						{promptMode === "append" ? t("promptAppendHint") : t("promptReplaceHint")}
					</p>
				</div>

				{/* ---- skills --------------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiCpu className="set-section-icon" />
						{t("settingsSkills")}
						<span className="set-count">{settings.skills.length}</span>
					</div>
					{settings.skills.length === 0 ? (
						<p className="set-empty">{t("noSkills")}</p>
					) : (
						<div className="set-list">
							{settings.skills.map((s) => (
								<ToggleRow
									key={s.name}
									title={s.name}
									subtitle={s.description}
									enabled={s.enabled}
									onToggle={() => toggleSkill(s)}
								/>
							))}
						</div>
					)}
				</div>

				{/* ---- extensions ------------------------------------------------ */}
				<div className="set-section">
					<div className="set-section-title">
						<FiPackage className="set-section-icon" />
						{t("settingsExtensions")}
						<span className="set-count">{settings.extensions.length}</span>
					</div>
					{settings.extensions.length === 0 ? (
						<p className="set-empty">{t("noExtensions")}</p>
					) : (
						<div className="set-list">
							{settings.extensions.map((e) => (
								<ToggleRow
									key={e.id}
									title={e.name}
									subtitle={e.path}
									enabled={e.enabled}
									onToggle={() => toggleExtension(e)}
								/>
							))}
						</div>
					)}
				</div>

				{/* ---- presets --------------------------------------------------- */}
				{/* ---- vision bridge ---------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiEye className="set-section-icon" />
						{t("settingsVisionBridge")}
					</div>
					<ToggleRow
						title={t("visionBridgeEnabled")}
						subtitle={t("settingsVisionBridgeDesc")}
						enabled={settings.visionBridgeEnabled}
						onToggle={() =>
							setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })
						}
					/>
					{!settings.visionBridgeEnabled && (
						<p className="set-hint">{t("visionBridgeOffHint")}</p>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgeModel")}
							</label>
							<select
								className="set-select"
								value={settings.visionBridgeModel ?? ""}
								onChange={(e) =>
									setPartial({ visionBridgeModel: e.target.value || null })
								}
							>
								<option value="">{t("visionBridgeAuto")}</option>
								{settings.visionModels.map((m) => (
									<option
										key={`${m.provider}/${m.id}`}
										value={`${m.provider}/${m.id}`}
									>
										{m.label}
									</option>
								))}
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgePromptMode")}
							</label>
							<select
								className="set-select"
								value={vbPromptMode}
								onChange={(e) => {
									const mode = e.target.value as "append" | "replace";
									setVbPromptMode(mode);
									setPartial({ visionBridgePromptMode: mode });
								}}
							>
								<option value="append">{t("promptModeAppend")}</option>
								<option value="replace">{t("promptModeReplace")}</option>
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<textarea
							className="set-prompt-input"
							rows={4}
							placeholder={t("visionBridgePromptPlaceholder")}
							value={vbPromptDraft}
							onFocus={() => (vbPromptFocus.current = true)}
							onBlur={() => {
								vbPromptFocus.current = false;
								setPartial({
									visionBridgePromptMode: vbPromptMode,
									visionBridgePrompt: vbPromptDraft,
								});
							}}
							onChange={(e) => setVbPromptDraft(e.target.value)}
						/>
					)}
					{settings.visionBridgeEnabled && (
						<p className="set-hint">
							{vbPromptMode === "append"
								? t("visionBridgePromptAppendHint")
								: t("visionBridgePromptReplaceHint")}
						</p>
					)}
					{settings.visionBridgeEnabled &&
						(settings.visionModels.length === 0 ? (
							<p className="set-hint">{t("visionBridgeNoModels")}</p>
						) : (
							<p className="set-hint">
								{t("visionBridgeCurrent", {
									model:
										settings.visionBridgeModel ??
										t("visionBridgeAuto"),
								})}
							</p>
						))}
				</div>
				<div className="set-section">
					<div className="set-section-title">
						<FiSettings className="set-section-icon" />
						{t("settingsPresets")}
						<span className="set-count">{settings.presets.length}</span>
					</div>
					<div className="set-preset-save">
						<input
							className="set-input"
							placeholder={t("presetNamePlaceholder")}
							value={presetName}
							onChange={(e) => setPresetName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && presetName.trim()) {
									send({ type: "save_preset", name: presetName.trim() });
									setPresetName("");
								}
							}}
						/>
						<button
							type="button"
							className="set-save-btn"
							disabled={!presetName.trim()}
							onClick={() => {
								send({ type: "save_preset", name: presetName.trim() });
								setPresetName("");
							}}
						>
							<FiPlus /> {t("saveAsPreset")}
						</button>
					</div>
					{settings.presets.length === 0 ? (
						<p className="set-empty">{t("noPresets")}</p>
					) : (
						<div className="set-list">
							{settings.presets.map((p) => (
								<div className="set-row" key={p.name}>
									<div className="set-row-info">
										<div className="set-row-name">{p.name}</div>
										<div className="set-row-desc">
											{p.promptMode === "replace"
												? t("promptModeReplace")
												: t("promptModeAppend")}
											{p.disabledSkills.length > 0 &&
												` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
											{p.disabledExtensions.length > 0 &&
												` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
										</div>
									</div>
									<div className="set-row-actions">
										<button
											type="button"
											className="dd-refresh"
											onClick={() => send({ type: "apply_preset", name: p.name })}
										>
											{t("applyPreset")}
										</button>
										<button
											type="button"
											className="set-icon-btn danger"
											title={t("deletePreset")}
											onClick={() => send({ type: "delete_preset", name: p.name })}
										>
											<FiTrash2 />
										</button>
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
