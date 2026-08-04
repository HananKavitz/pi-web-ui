import { useEffect, useState } from "react";
import {
	FiCpu,
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

interface TopBarProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "list_models" }
			| { type: "set_model"; modelId: string }
			| { type: "set_thinking"; level: string }
			| { type: "new_chat" },
	) => boolean;
	view: "chat" | "terminal";
	onViewChange: (view: "chat" | "terminal") => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
}

const THINKING_LEVELS: { value: string; label: string }[] = [
	{ value: "off", label: "关闭" },
	{ value: "minimal", label: "极简" },
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "xhigh", label: "极高" },
	{ value: "max", label: "最大" },
];

function thinkingLabel(level: string): string {
	return THINKING_LEVELS.find((l) => l.value === level)?.label ?? level;
}

export function TopBar({
	chat,
	send,
	view,
	onViewChange,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const state = chat.state;
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [soundOpen, setSoundOpen] = useState(false);
	// Local loading flag for the model dropdown (list arrives via chat.models).
	const [modelsLoading, setModelsLoading] = useState(false);

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
		? "已连接"
		: chat.status === "closed"
			? "重连中…"
			: "连接中…";
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
				<div className="view-switch" role="tablist" aria-label="视图切换">
					<button
						type="button"
						role="tab"
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>对话</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>终端</span>
					</button>
				</div>
				<Dropdown
					trigger={
						<>
							<FiCpu />
							<span className="chip-model">
								{model ? model.name : "选择模型"}
							</span>
							{model && <span className="chip-sub">{model.provider}</span>}
						</>
					}
					open={modelOpen}
					onOpenChange={setModelOpen}
				>
					<div className="dd-header">可用模型</div>
					{(modelsLoading || chat.modelsLoading) && (
						<div className="dd-loading">加载中…</div>
					)}
					{chat.models.length === 0 &&
						!modelsLoading &&
						!chat.modelsLoading && (
							<div className="dd-loading">
								暂无可用模型（请先配置 API 密钥）
							</div>
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
								{m.reasoning ? " · 推理" : ""}
							</span>
						</DropdownItem>
					))}
					<button
						type="button"
						className="dd-refresh"
						onClick={() => send({ type: "list_models" })}
					>
						刷新模型列表
					</button>
				</Dropdown>

				<Dropdown
					trigger={
						<>
							<FiZap />
							<span className="chip-sub">
								思考：{state ? thinkingLabel(state.thinkingLevel) : "—"}
							</span>
						</>
					}
					open={thinkingOpen}
					onOpenChange={setThinkingOpen}
				>
					<div className="dd-header">思考强度</div>
					{THINKING_LEVELS.map((l) => (
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
							<span className="chip-sub">声音</span>
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

				<button
					type="button"
					className="chip newchat"
					data-tip="新建对话（每个浏览器独立保存会话）"
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>新对话</span>
				</button>
			</div>
		</header>
	);
}
