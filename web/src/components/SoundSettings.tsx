import { FiVolume2 } from "react-icons/fi";
import type { SoundKind, SoundSettings } from "../sounds";

interface SoundSettingsProps {
	settings: SoundSettings;
	onChange: (settings: SoundSettings) => void;
	/** Play a preview cue (the actual synthesized sound). */
	onPreview: (kind: SoundKind) => void;
}

const EVENT_LABELS: { kind: SoundKind; label: string; desc: string }[] = [
	{ kind: "question", label: "问卷弹出", desc: "ask_user_question 出现时" },
	{ kind: "done", label: "回复结束", desc: "智能体完成一轮回答时" },
	{ kind: "start", label: "回复开始", desc: "智能体开始新一轮时" },
	{ kind: "error", label: "出错", desc: "出现错误提示时" },
];

export function SoundSettingsPanel({
	settings,
	onChange,
	onPreview,
}: SoundSettingsProps) {
	const toggle = (patch: Partial<SoundSettings>) =>
		onChange({ ...settings, ...patch });

	return (
		<div className="sound-menu">
			<div className="dd-header">声音提示</div>

			<label className="sound-row sound-master">
				<span className="sound-label">
					<FiVolume2 className="sound-icon" />
					<span>启用声音</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled}
					onChange={(e) => toggle({ enabled: e.target.checked })}
				/>
			</label>

			{EVENT_LABELS.map(({ kind, label, desc }) => (
				<label
					key={kind}
					className={`sound-row ${settings.enabled ? "" : "disabled"}`}
				>
					<span className="sound-label">
						<span className="sound-name">{label}</span>
						<span className="sound-desc">{desc}</span>
					</span>
					<span className="sound-right">
						<button
							type="button"
							className="sound-preview"
							title="试听"
							disabled={!settings.enabled}
							onClick={(e) => {
								e.preventDefault();
								onPreview(kind);
							}}
						>
							试听
						</button>
						<input
							type="checkbox"
							checked={settings[kind]}
							disabled={!settings.enabled}
							onChange={(e) => toggle({ [kind]: e.target.checked })}
						/>
					</span>
				</label>
			))}

			<div className={`sound-volume ${settings.enabled ? "" : "disabled"}`}>
				<span className="sound-name">音量</span>
				<input
					type="range"
					min={0}
					max={100}
					step={5}
					value={settings.volume}
					disabled={!settings.enabled}
					onChange={(e) => toggle({ volume: Number(e.target.value) })}
				/>
				<span className="sound-vol-num">{settings.volume}%</span>
			</div>
		</div>
	);
}
