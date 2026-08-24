"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CircleAlert,
  Power,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  activateManagedPlatformRouterConfig,
  getManagedPlatformRouterState,
  listManagedPlatformRouterModels,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
  type ManagedPlatformRouterConfig,
  type ManagedPlatformRouterDraftConfig,
  type ManagedPlatformRouterModel,
  type PlatformRouterEffectiveStatus,
} from "../api";
import { SectionHeading } from "./Primitives";

export function PlatformAiConfigPanel({
  rootRole,
  onNotice,
}: {
  rootRole?: string | null;
  onNotice: (message: string) => void;
}) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<ManagedPlatformRouterConfig | null>(
    null,
  );
  const [draft, setDraft] = useState<ManagedPlatformRouterDraftConfig | null>(
    null,
  );
  const [effective, setEffective] =
    useState<PlatformRouterEffectiveStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [protocol, setProtocol] =
    useState<ManagedPlatformRouterConfig["protocol"]>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ManagedPlatformRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [assistantInstructions, setAssistantInstructions] = useState("");
  const [assistantMaxOutputTokens, setAssistantMaxOutputTokens] =
    useState("320");
  const [assistantTemperature, setAssistantTemperature] = useState("0.2");
  const [assistantMaxSteps, setAssistantMaxSteps] = useState("3");
  const [assistantTimeoutMs, setAssistantTimeoutMs] = useState("20000");
  const [assistantReasoningEffort, setAssistantReasoningEffort] =
    useState<ManagedPlatformRouterConfig["assistantReasoningEffort"]>("none");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [activating, setActivating] = useState(false);
  const interactionLocked = loading || saving || testing || activating;
  const reasoningEfforts = useMemo(() => {
    const listed = models.find(
      (candidate) => candidate.id === model,
    )?.reasoningEfforts;
    if (listed) return listed;
    const saved = draft ?? config;
    return saved?.model === model ? saved.modelReasoningEfforts : [];
  }, [config, draft, model, models]);

  useEffect(() => {
    let mounted = true;
    void getManagedPlatformRouterState()
      .then((state) => {
        if (!mounted) return;
        applyState(state);
        const editable = state.draft ?? state.config;
        if (editable) apply(editable);
        else applyRequiredDefaults(state.effective);
      })
      .catch((error) => {
        if (mounted)
          onNotice(error instanceof Error ? error.message : "AI 配置读取失败");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [onNotice]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const state = await saveManagedPlatformRouterConfig({
        endpoint,
        model,
        protocol,
        enabled,
        apiKey: apiKey || undefined,
        assistantInstructions,
        assistantMaxOutputTokens: Number.parseInt(assistantMaxOutputTokens, 10),
        assistantTemperature: Number.parseFloat(assistantTemperature),
        assistantMaxSteps: Number.parseInt(assistantMaxSteps, 10),
        assistantTimeoutMs: Number.parseInt(assistantTimeoutMs, 10),
        assistantReasoningEffort,
        modelReasoningEfforts: reasoningEfforts,
      });
      applyState(state);
      if (state.draft) apply(state.draft);
      setApiKey("");
      onNotice("待测配置已保存；当前生效配置未改变，请继续测试连接");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await testPlatformAi({ candidate: true });
      const state = await getManagedPlatformRouterState();
      applyState(state);
      onNotice(
        result.status === "ready"
          ? "待测配置连接成功，现在可以显式启用"
          : result.message,
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 连接测试失败");
    } finally {
      setTesting(false);
    }
  };

  const activate = async () => {
    if (!canEdit) return;
    setActivating(true);
    try {
      const state = await activateManagedPlatformRouterConfig();
      applyState(state);
      if (state.config) apply(state.config);
      onNotice("待测配置已原子启用；AI-ready 状态已更新");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 配置启用失败");
    } finally {
      setActivating(false);
    }
  };

  const loadModels = async () => {
    setModelsLoading(true);
    try {
      const loaded = await listManagedPlatformRouterModels({
        endpoint,
        protocol,
        apiKey: apiKey || undefined,
      });
      setModels(loaded);
      if (!loaded.some((candidate) => candidate.id === model)) {
        setModel(loaded[0]?.id ?? "");
        setAssistantReasoningEffort("none");
      }
      onNotice(`已获取 ${loaded.length} 个模型`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型列表读取失败");
    } finally {
      setModelsLoading(false);
    }
  };

  function applyState(state: {
    config: ManagedPlatformRouterConfig | null;
    draft: ManagedPlatformRouterDraftConfig | null;
    effective: PlatformRouterEffectiveStatus;
  }) {
    setConfig(state.config);
    setDraft(state.draft);
    setEffective(state.effective);
  }

  function applyRequiredDefaults(status: PlatformRouterEffectiveStatus) {
    setEndpoint(status.requiredEndpoint);
    setModel(status.requiredModel);
    setModels([{ id: status.requiredModel, reasoningEfforts: [] }]);
    setProtocol("openai-compatible");
    setEnabled(true);
  }

  function apply(current: ManagedPlatformRouterConfig) {
    setConfig(current);
    setEndpoint(current.endpoint);
    setModel(current.model);
    setModels([
      { id: current.model, reasoningEfforts: current.modelReasoningEfforts },
    ]);
    setProtocol(current.protocol);
    setEnabled(current.enabled);
    setAssistantInstructions(current.assistantInstructions ?? "");
    setAssistantMaxOutputTokens(
      String(current.assistantMaxOutputTokens ?? 320),
    );
    setAssistantTemperature(String(current.assistantTemperature ?? 0.2));
    setAssistantMaxSteps(String(current.assistantMaxSteps ?? 3));
    setAssistantTimeoutMs(String(current.assistantTimeoutMs ?? 20000));
    setAssistantReasoningEffort(current.assistantReasoningEffort ?? "low");
  }

  return (
    <section
      className="surface root-email-config platform-ai-config"
      aria-labelledby="platform-ai-config-title"
    >
      <SectionHeading title="AI" titleId="platform-ai-config-title" />
      <p className="subplatform-intro">
        WebUI 托管配置是正式生产路径。API Key
        仅写入服务器受保护存储，读取接口、响应和日志都不会返回密钥或指纹。
      </p>
      {effective ? (
        <div
          className={`platform-ai-effective-status ${effective.ready ? "is-ready" : "is-blocked"}`}
          role="status"
        >
          {effective.ready ? (
            <ShieldCheck size={18} aria-hidden="true" />
          ) : (
            <CircleAlert size={18} aria-hidden="true" />
          )}
          <div>
            <strong>
              {effective.ready
                ? "AI 流量已就绪"
                : "AI 流量已阻塞，后台配置仍可用"}
            </strong>
            <p>
              生效来源：{sourceLabel(effective.source)}；要求：
              {effective.requiredEndpoint} + {effective.requiredModel}
            </p>
            {!effective.ready ? (
              <span>{effective.issues.map(issueLabel).join("、")}</span>
            ) : null}
            {effective.managedOverridesEnvironment ? (
              <span>
                WebUI managed 配置正在覆盖 env
                {Object.values(effective.conflicts).some(Boolean)
                  ? "，且两处非秘密配置存在冲突"
                  : ""}
                。
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="seller-upload-form">
        <label
          className="platform-ai-endpoint-field"
          htmlFor="platform-ai-endpoint"
        >
          <span>模型网关 API 基址</span>
          <Input
            id="platform-ai-endpoint"
            value={endpoint}
            disabled={!canEdit || interactionLocked}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://api.lmm.best/v1"
            inputMode="url"
          />
        </label>
        <label htmlFor="platform-ai-protocol">
          <span>协议</span>
          <select
            id="platform-ai-protocol"
            value={protocol}
            disabled={!canEdit || interactionLocked}
            onChange={(event) => {
              setProtocol(
                event.target.value as ManagedPlatformRouterConfig["protocol"],
              );
              setModels([]);
              setModel("");
              setAssistantReasoningEffort("none");
            }}
          >
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="gemini-generate-content">
              Gemini Generate Content
            </option>
          </select>
        </label>
        <label htmlFor="platform-ai-key">
          <span>API Key</span>
          <Input
            id="platform-ai-key"
            type="password"
            value={apiKey}
            disabled={!canEdit || interactionLocked}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            placeholder={
              draft?.credentialConfigured || config?.credentialConfigured
                ? "留空则保持服务器中的待测/生效 API Key"
                : "粘贴由 api.lmm.best 生成的专用 API Key"
            }
          />
        </label>
        <div className="platform-ai-model-picker seller-upload-wide">
          <button
            className="root-email-test"
            type="button"
            disabled={!canEdit || modelsLoading || interactionLocked}
            onClick={() => void loadModels()}
          >
            {modelsLoading ? "获取中…" : "获取模型列表"}
          </button>
          <label htmlFor="platform-ai-model">
            <span>模型</span>
            <select
              id="platform-ai-model"
              value={model}
              disabled={!canEdit || interactionLocked || !models.length}
              onChange={(event) => {
                const next = event.target.value;
                setModel(next);
                const supported =
                  models.find((candidate) => candidate.id === next)
                    ?.reasoningEfforts ?? [];
                if (
                  assistantReasoningEffort !== "none" &&
                  !supported.includes(assistantReasoningEffort)
                )
                  setAssistantReasoningEffort("none");
              }}
            >
              <option value="">选择模型</option>
              {models.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="email-enabled">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit || interactionLocked}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          启用商城 AI 导购
        </label>
        <div className="platform-ai-advanced seller-upload-wide">
          <div>
            <SlidersHorizontal size={16} aria-hidden="true" />
            <strong>导购行为</strong>
          </div>
          <label htmlFor="platform-ai-instructions">
            <span>补充指引（可选）</span>
            <textarea
              id="platform-ai-instructions"
              value={assistantInstructions}
              disabled={!canEdit || interactionLocked}
              maxLength={4000}
              rows={4}
              onChange={(event) => setAssistantInstructions(event.target.value)}
              placeholder="例如：确认预算和用途，给出对比建议。"
            />
          </label>
          <label>
            <span>单次回答上限</span>
            <Input
              type="number"
              min={64}
              max={512}
              value={assistantMaxOutputTokens}
              disabled={!canEdit || interactionLocked}
              onChange={(event) =>
                setAssistantMaxOutputTokens(event.target.value)
              }
            />
            <small>64–512 tokens</small>
          </label>
          <label>
            <span>回答发散度</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={assistantTemperature}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => setAssistantTemperature(event.target.value)}
            />
            <small>0 更稳定，1 更开放</small>
          </label>
          <label>
            <span>工具循环步数</span>
            <Input
              type="number"
              min={2}
              max={8}
              value={assistantMaxSteps}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => setAssistantMaxSteps(event.target.value)}
            />
            <small>2–8 步，保留最终回答</small>
          </label>
          <label>
            <span>单次超时</span>
            <Input
              type="number"
              min={4000}
              max={30000}
              step={1000}
              value={assistantTimeoutMs}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => setAssistantTimeoutMs(event.target.value)}
            />
            <small>4000–30000 ms</small>
          </label>
          {reasoningEfforts.length ? (
            <label>
              <span>思考等级</span>
              <select
                value={assistantReasoningEffort}
                disabled={!canEdit || interactionLocked}
                onChange={(event) =>
                  setAssistantReasoningEffort(event.target.value)
                }
              >
                <option value="none">不指定，由模型决定</option>
                {reasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <small>
                完全来自模型服务返回的能力元数据，不按模型名称猜测。
              </small>
            </label>
          ) : (
            <div className="platform-ai-capability-note">
              <span>思考等级</span>
              <strong>
                {model ? "模型服务未返回可选等级" : "选择模型后读取能力"}
              </strong>
              <small>未声明时不发送该参数，避免错误配置。</small>
            </div>
          )}
        </div>
        <div
          className="platform-ai-tools seller-upload-wide"
          aria-label="导购 Agent 工具"
        >
          <strong>导购 Agent 工具</strong>
          <span>公开店铺目录</span>
          <span>公开商品检索</span>
          <span>商品比较</span>
          <span>购物计算</span>
          <span>基础计算</span>
          <small>
            工具结果由服务端重新读取；模型不能读取联系方式、密钥或未审核商品。
          </small>
        </div>
        <div className="seller-upload-wide root-email-actions">
          <p>
            <ShieldCheck size={16} aria-hidden="true" />
            生效凭据：{config?.credentialConfigured ? "已配置" : "未配置"}；
            待测凭据：{draft?.credentialConfigured ? "已配置" : "未保存"}
          </p>
          {draft ? (
            <small className="platform-ai-draft-state">
              待测配置：{draft.endpoint} · {draft.model} ·
              {draft.testedReady
                ? ` 已通过（${draft.testedAt ?? "刚刚"}）`
                : " 尚未通过连接测试"}
            </small>
          ) : null}
          <div className="root-email-action-buttons">
            {canEdit ? (
              <button
                className="root-email-save"
                type="button"
                disabled={interactionLocked}
                onClick={() => void save()}
              >
                <Save size={16} aria-hidden="true" />
                {saving ? "保存中…" : "保存待测配置"}
              </button>
            ) : null}
            <button
              className="root-email-test"
              type="button"
              disabled={
                !canEdit ||
                interactionLocked ||
                !draft?.credentialConfigured ||
                !draft.enabled
              }
              onClick={() => void test()}
            >
              <Send size={16} aria-hidden="true" />
              {testing ? "测试中…" : "测试待测配置"}
            </button>
            {canEdit ? (
              <button
                className="root-email-save"
                type="button"
                disabled={interactionLocked || !draft?.testedReady}
                onClick={() => void activate()}
              >
                <Power size={16} aria-hidden="true" />
                {activating ? "启用中…" : "启用已测试配置"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {!canEdit ? (
        <p className="subplatform-intro">
          <Bot size={15} aria-hidden="true" />
          商城运营可以查看状态；服务配置仅由商城负责人修改。
        </p>
      ) : null}
    </section>
  );
}

function sourceLabel(source: PlatformRouterEffectiveStatus["source"]): string {
  if (source === "managed") return "WebUI managed";
  if (source === "environment") return "env fallback";
  return "未配置";
}

function issueLabel(issue: string): string {
  const labels: Record<string, string> = {
    provider_not_enabled: "尚未启用",
    credential_not_configured: "凭据未配置",
    endpoint_mismatch: "API 基址不符合 M0 要求",
    model_mismatch: "模型不符合 M0 要求",
    protocol_mismatch: "协议不符合 M0 要求",
  };
  return labels[issue] ?? "配置不符合要求";
}
