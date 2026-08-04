import { useEffect, useState } from "react";
import { FiCpu, FiRefreshCw, FiX } from "react-icons/fi";
import type { ClientMessage, ProviderStatus } from "../types";

interface PiSetupModalProps {
	send: (msg: ClientMessage) => boolean;
	/** Fetched from the latest snapshot; true once auth.json has credentials. */
	piConfigured: boolean;
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Real result of the last install_pi_agent run (null = not finished). */
	installResult: { ok: boolean; detail: string } | null;
	onClose: () => void;
}

/**
 * One-time setup overlay: shown when the server reports the pi agent config is
 * missing (no auth.json credentials). Offers auto-install of the pi CLI and an
 * in-browser API key form for pi's built-in providers — no terminal needed.
 * The key form only appears after the server confirms the install (install_result).
 */
export function PiSetupModal({
	send,
	piConfigured,
	providers,
	installResult,
	onClose,
}: PiSetupModalProps) {
	const [installing, setInstalling] = useState(false);
	const [provider, setProvider] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);

	// Built-in provider list for the dropdown.
	useEffect(() => {
		send({ type: "list_providers" });
	}, [send]);

	// Auto-close once the config is actually ready (snapshot-driven).
	useEffect(() => {
		if (piConfigured) onClose();
	}, [piConfigured, onClose]);

	// Install finished (success or failure) → stop the spinner.
	useEffect(() => {
		if (installResult) setInstalling(false);
	}, [installResult]);

	// Default to the first unconfigured provider once the list arrives.
	useEffect(() => {
		if (!provider && providers.length > 0) {
			setProvider(
				providers.find((p) => !p.configured)?.id ?? providers[0].id,
			);
		}
	}, [providers, provider]);

	const doInstall = () => {
		if (installing) return;
		setInstalling(true);
		send({ type: "install_pi_agent" });
	};

	const saveKey = () => {
		if (!apiKey.trim() || saving) return;
		setSaving(true);
		send({
			type: "set_provider_api_key",
			provider: provider.trim(),
			apiKey: apiKey.trim(),
		});
		// The server refreshes models and flushes a snapshot — the modal closes
		// itself once piConfigured flips true. Keep the button disabled meanwhile.
		setTimeout(() => setSaving(false), 3000);
	};

	const recheck = () => {
		send({ type: "get_state" });
		send({ type: "list_providers" });
	};

	const selected = providers.find((p) => p.id === provider);
	const installFailed = installResult !== null && !installResult.ok;

	return (
		<div className="modal-backdrop">
			<div className="modal setup-modal">
				<button
					type="button"
					className="modal-close"
					aria-label="关闭"
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiCpu className="modal-head-icon" />
					<h2>未检测到 pi agent 配置</h2>
				</div>
				<p className="modal-desc">
					pi-web-ui 需要 pi 的配置目录（
					<code>~/.pi/agent</code>）和至少一个 API
					密钥才能运行智能体。pi 内置了 openai、anthropic、deepseek 等服务商
					——选一个填密钥即可，全程无需打开终端。
				</p>

				{installFailed ? (
					<div className="setup-failed">
						<div className="setup-done">✖ pi agent 安装失败：</div>
						<pre className="setup-detail">{installResult.detail}</pre>
						<div className="setup-actions">
							<button
								type="button"
								className="btn primary"
								disabled={installing}
								onClick={doInstall}
							>
								重试安装
							</button>
							<button type="button" className="btn" onClick={onClose}>
								跳过
							</button>
						</div>
					</div>
				) : installResult?.ok ? (
					<div className="setup-key-form">
						<div className="setup-done">
							✅ pi agent CLI 已安装。选择服务商并填入 API 密钥即可开始对话：
						</div>
						<label className="field">
							<span className="field-label">服务商</span>
							<select
								value={provider}
								onChange={(e) => setProvider(e.target.value)}
							>
								{providers.length === 0 && <option value="">加载中…</option>}
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}（{p.id}）
										{p.configured ? " · 已配置" : ""}
									</option>
								))}
							</select>
							{selected?.configured && (
								<div className="field-hint">
									该服务商已配置密钥，可直接使用或更换新密钥。
								</div>
							)}
						</label>
						<label className="field">
							<span className="field-label">API 密钥</span>
							<input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder="sk-…"
							/>
						</label>
						<div className="setup-actions">
							<button
								type="button"
								className="btn primary"
								disabled={!apiKey.trim() || saving || !provider}
								onClick={saveKey}
							>
								{saving ? "保存中…" : "保存并开始使用"}
							</button>
							<button type="button" className="btn" onClick={recheck}>
								<FiRefreshCw /> 重新检测
							</button>
						</div>
					</div>
				) : (
					<div className="setup-actions">
						<button
							type="button"
							className="btn primary"
							disabled={installing}
							onClick={doInstall}
						>
							{installing ? "正在安装 pi agent CLI…" : "自动安装 pi agent"}
						</button>
						<button type="button" className="btn" onClick={onClose}>
							跳过
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
