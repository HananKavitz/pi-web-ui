import { useEffect, useState } from "react";
import { FiEdit2, FiKey, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import type {
	ClientMessage,
	ProviderStatus,
	UiModelConfigEntry,
	UiProviderConfig,
} from "../types";

interface ModelConfigModalProps {
	send: (msg: ClientMessage) => boolean;
	/** Custom providers from agentDir/models.json. */
	providers: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providerStatus: ProviderStatus[];
	onClose: () => void;
}

const API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

interface DraftModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: "text" | "text-image";
	contextWindow: string;
	maxTokens: string;
}

interface Draft {
	providerId: string;
	name: string;
	api: string;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	models: DraftModel[];
}

const emptyModel = (): DraftModel => ({
	id: "",
	name: "",
	reasoning: false,
	input: "text",
	contextWindow: "",
	maxTokens: "",
});

const emptyDraft = (): Draft => ({
	providerId: "",
	name: "",
	api: "openai-completions",
	baseUrl: "",
	apiKey: "",
	authHeader: true,
	models: [emptyModel()],
});

function toDraft(p: UiProviderConfig): Draft {
	return {
		providerId: p.providerId,
		name: p.name ?? "",
		api: p.api ?? "openai-completions",
		baseUrl: p.baseUrl ?? "",
		apiKey: p.apiKey ?? "",
		authHeader: p.authHeader ?? false,
		models: (p.models.length ? p.models : [emptyModel()]).map((m) => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: m.reasoning ?? false,
			input: m.input?.includes("image") ? "text-image" : "text",
			contextWindow: m.contextWindow ? String(m.contextWindow) : "",
			maxTokens: m.maxTokens ? String(m.maxTokens) : "",
		})),
	};
}

export function ModelConfigModal({
	send,
	providers,
	providerStatus,
	onClose,
}: ModelConfigModalProps) {
	const [editing, setEditing] = useState<Draft | null>(null);
	/** Built-in provider rows: providerId → inline key being typed. */
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [savingKey, setSavingKey] = useState<string | null>(null);

	// Fresh config when the modal opens.
	useEffect(() => {
		send({ type: "list_models_config" });
		send({ type: "list_providers" });
	}, [send]);

	const saveBuiltinKey = (p: ProviderStatus) => {
		const key = (keys[p.id] ?? "").trim();
		if (!key || savingKey) return;
		setSavingKey(p.id);
		send({ type: "set_provider_api_key", provider: p.id, apiKey: key });
		// Server refreshes + emits providers_status; clear the input on success.
		setTimeout(() => {
			setSavingKey(null);
			setKeys((k) => ({ ...k, [p.id]: "" }));
			send({ type: "list_providers" });
		}, 1500);
	};

	const save = () => {
		if (!editing) return;
		const providerId = editing.providerId.trim();
		const models: UiModelConfigEntry[] = editing.models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				name: m.name.trim() || undefined,
				reasoning: m.reasoning || undefined,
				input: m.input === "text-image" ? ["text", "image"] : undefined,
				contextWindow: m.contextWindow ? Number(m.contextWindow) : undefined,
				maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
			}));
		const config: UiProviderConfig = {
			providerId,
			name: editing.name.trim() || undefined,
			api: editing.api.trim() || undefined,
			baseUrl: editing.baseUrl.trim() || undefined,
			apiKey: editing.apiKey.trim() || undefined,
			authHeader: editing.authHeader || undefined,
			models,
		};
		send({ type: "save_model_config", providerId, config });
		onClose();
	};

	const removeProvider = (p: UiProviderConfig) => {
		if (
			window.confirm(
				`删除服务商 ${p.providerId} 及其 ${p.models.length} 个模型？`,
			)
		) {
			send({ type: "delete_model_config", providerId: p.providerId });
		}
	};

	const setModel = (i: number, patch: Partial<DraftModel>) => {
		if (!editing) return;
		setEditing({
			...editing,
			models: editing.models.map((m, j) => (j === i ? { ...m, ...patch } : m)),
		});
	};

	return (
		<div className="modal-backdrop">
			<div className="modal model-modal">
				<button
					type="button"
					className="modal-close"
					aria-label="关闭"
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<h2>{editing ? "编辑服务商" : "管理模型"}</h2>
				</div>

				{!editing ? (
					<>
						<div className="form-section-title">
							内置服务商 <em className="section-hint">只需填入 API 密钥</em>
						</div>
						<div className="provider-list">
							{providerStatus.length === 0 && (
								<div className="dd-loading">加载中…</div>
							)}
							{providerStatus.map((p) => (
								<div className="provider-row" key={p.id}>
									<div className="provider-info">
										<span className="provider-name">{p.name}</span>
										<span className="provider-sub">
											{p.id}
											{p.configured && (
												<span className="auth-badge">✓ 已配置</span>
											)}
											{p.source && !p.configured && (
												<span className="auth-badge dim">{p.source}</span>
											)}
										</span>
									</div>
									<div className="provider-actions">
										{p.configured ? (
											<span className="auth-badge">密钥已就绪</span>
										) : (
											<>
												<input
													type="password"
													className="key-input"
													placeholder="粘贴 API 密钥…"
													value={keys[p.id] ?? ""}
													onChange={(e) =>
														setKeys((k) => ({ ...k, [p.id]: e.target.value }))
													}
												/>
												<button
													type="button"
													className="btn primary sm"
													disabled={
														!(keys[p.id] ?? "").trim() || savingKey === p.id
													}
													onClick={() => saveBuiltinKey(p)}
												>
													<FiKey /> {savingKey === p.id ? "保存中" : "保存密钥"}
												</button>
											</>
										)}
									</div>
								</div>
							))}
						</div>

						<div className="form-section-title">自定义服务商</div>
						<p className="modal-desc">
							用于 Ollama / vLLM / 兼容 OpenAI 的代理等，写入 pi 的{" "}
							<code>models.json</code>，保存后热重载、立即生效。
						</p>
						{providers.length === 0 && (
							<div className="dd-loading">还没有自定义服务商</div>
						)}
						<div className="provider-list">
							{providers.map((p) => (
								<div className="provider-row" key={p.providerId}>
									<div className="provider-info">
										<span className="provider-name">{p.providerId}</span>
										<span className="provider-sub">
											{p.api ?? "—"}
											{p.baseUrl ? ` · ${p.baseUrl}` : ""}
											{p.models.length > 0 && ` · ${p.models.length} 个模型`}
										</span>
									</div>
									<div className="provider-actions">
										<button
											type="button"
											className="iconbtn"
											title="编辑"
											onClick={() => setEditing(toDraft(p))}
										>
											<FiEdit2 />
										</button>
										<button
											type="button"
											className="iconbtn danger"
											title="删除"
											onClick={() => removeProvider(p)}
										>
											<FiTrash2 />
										</button>
									</div>
								</div>
							))}
						</div>
						<div className="modal-actions">
							<button
								type="button"
								className="btn primary"
								onClick={() => setEditing(emptyDraft())}
							>
								<FiPlus /> 新增服务商
							</button>
						</div>
					</>
				) : (
					<div className="provider-form">
						<div className="form-grid">
							<label className="field">
								<span className="field-label">
									服务商 ID <em>（必填，如 ollama / my-proxy）</em>
								</span>
								<input
									type="text"
									value={editing.providerId}
									disabled={providers.some(
										(p) => p.providerId === editing.providerId,
									)}
									onChange={(e) =>
										setEditing({ ...editing, providerId: e.target.value })
									}
									placeholder="my-proxy"
								/>
							</label>
							<label className="field">
								<span className="field-label">显示名</span>
								<input
									type="text"
									value={editing.name}
									onChange={(e) =>
										setEditing({ ...editing, name: e.target.value })
									}
									placeholder="我的代理"
								/>
							</label>
							<label className="field">
								<span className="field-label">API 类型</span>
								<select
									value={editing.api}
									onChange={(e) =>
										setEditing({ ...editing, api: e.target.value })
									}
								>
									{API_TYPES.map((a) => (
										<option key={a} value={a}>
											{a}
										</option>
									))}
								</select>
							</label>
							<label className="field">
								<span className="field-label">
									baseUrl <em>（OpenAI 兼容端点）</em>
								</span>
								<input
									type="text"
									value={editing.baseUrl}
									onChange={(e) =>
										setEditing({ ...editing, baseUrl: e.target.value })
									}
									placeholder="http://localhost:11434/v1"
								/>
							</label>
							<label className="field">
								<span className="field-label">API 密钥</span>
								<input
									type="password"
									value={editing.apiKey}
									onChange={(e) =>
										setEditing({ ...editing, apiKey: e.target.value })
									}
									placeholder="sk-…（可留空，用 auth.json 的密钥）"
								/>
							</label>
							<label className="field check">
								<input
									type="checkbox"
									checked={editing.authHeader}
									onChange={(e) =>
										setEditing({ ...editing, authHeader: e.target.checked })
									}
								/>
								<span>自动添加 Authorization 请求头</span>
							</label>
						</div>

						<div className="form-section-title">模型</div>
						{editing.models.map((m, i) => (
							<div className="model-row" key={i}>
								<input
									type="text"
									value={m.id}
									onChange={(e) => setModel(i, { id: e.target.value })}
									placeholder="模型 ID（必填）"
								/>
								<input
									type="text"
									value={m.name}
									onChange={(e) => setModel(i, { name: e.target.value })}
									placeholder="显示名"
								/>
								<select
									value={m.input}
									onChange={(e) =>
										setModel(i, {
											input: e.target.value as DraftModel["input"],
										})
									}
								>
									<option value="text">文本</option>
									<option value="text-image">文本+图片</option>
								</select>
								<label className="check">
									<input
										type="checkbox"
										checked={m.reasoning}
										onChange={(e) =>
											setModel(i, { reasoning: e.target.checked })
										}
									/>
									<span>推理</span>
								</label>
								<input
									type="number"
									value={m.contextWindow}
									onChange={(e) =>
										setModel(i, { contextWindow: e.target.value })
									}
									placeholder="上下文"
									title="contextWindow"
								/>
								<input
									type="number"
									value={m.maxTokens}
									onChange={(e) => setModel(i, { maxTokens: e.target.value })}
									placeholder="最大输出"
									title="maxTokens"
								/>
								<button
									type="button"
									className="iconbtn danger"
									title="移除模型"
									onClick={() =>
										setEditing({
											...editing,
											models: editing.models.filter((_, j) => j !== i),
										})
									}
								>
									<FiTrash2 />
								</button>
							</div>
						))}
						<button
							type="button"
							className="btn"
							onClick={() =>
								setEditing({
									...editing,
									models: [...editing.models, emptyModel()],
								})
							}
						>
							<FiPlus /> 添加模型
						</button>

						<div className="modal-actions">
							<button
								type="button"
								className="btn"
								onClick={() => setEditing(null)}
							>
								取消
							</button>
							<button
								type="button"
								className="btn primary"
								disabled={
									!editing.providerId.trim() ||
									!editing.models.some((m) => m.id.trim())
								}
								onClick={save}
							>
								保存
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
