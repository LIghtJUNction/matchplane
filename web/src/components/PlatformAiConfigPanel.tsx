"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Save, Send, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getManagedPlatformRouterConfig,
  listManagedPlatformRouterModels,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
  type ManagedPlatformRouterConfig,
  type ManagedPlatformRouterModel,
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
  const reasoningEfforts = useMemo(() => {
    const listed = models.find(
      (candidate) => candidate.id === model,
    )?.reasoningEfforts;
    if (listed) return listed;
    return config?.model === model ? config.modelReasoningEfforts : [];
  }, [config, model, models]);

  useEffect(() => {
    let mounted = true;
    void getManagedPlatformRouterConfig()
      .then((current) => {
        if (mounted && current) apply(current);
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
      const updated = await saveManagedPlatformRouterConfig({
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
      apply(updated);
      setApiKey("");
      onNotice(
        updated.credentialConfigured
          ? "AI 配置已保存"
          : "请输入 API Key 后再保存",
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await testPlatformAi();
      onNotice(
        result.status === "ready" ? "AI 连接测试成功" : result.message,
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 连接测试失败");
    } finally {
      setTesting(false);
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
        在这里配置模型、导购行为和输出边界。API Key 只保存在服务器受保护存储中。
      </p>
      <div className="seller-upload-form">
        <label
          className="platform-ai-endpoint-field"
          htmlFor="platform-ai-endpoint"
        >
          <span>模型网关主机</span>
          <Input
            id="platform-ai-endpoint"
            value={endpoint}
            disabled={!canEdit || loading}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://api.example.com"
            inputMode="url"
          />
        </label>
        <label htmlFor="platform-ai-protocol">
          <span>协议</span>
          <select
            id="platform-ai-protocol"
            value={protocol}
            disabled={!canEdit || loading}
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
            disabled={!canEdit || loading}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            placeholder={
              config?.credentialConfigured
                ? "留空则保持当前 API Key"
                : "填写 API Key"
            }
          />
        </label>
        <div className="platform-ai-model-picker seller-upload-wide">
          <button
            className="root-email-test"
            type="button"
            disabled={!canEdit || modelsLoading || loading}
            onClick={() => void loadModels()}
          >
            {modelsLoading ? "获取中…" : "获取模型列表"}
          </button>
          <label htmlFor="platform-ai-model">
            <span>模型</span>
            <select
              id="platform-ai-model"
              value={model}
              disabled={!canEdit || loading || !models.length}
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
            disabled={!canEdit || loading}
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
              disabled={!canEdit || loading}
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
              disabled={!canEdit || loading}
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
              disabled={!canEdit || loading}
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
              disabled={!canEdit || loading}
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
              disabled={!canEdit || loading}
              onChange={(event) => setAssistantTimeoutMs(event.target.value)}
            />
            <small>4000–30000 ms</small>
          </label>
          {reasoningEfforts.length ? (
            <label>
              <span>思考等级</span>
              <select
                value={assistantReasoningEffort}
                disabled={!canEdit || loading}
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
            API Key：{config?.credentialConfigured ? "已就绪" : "尚未写入"}
          </p>
          <div className="root-email-action-buttons">
            {canEdit ? (
              <button
                className="root-email-save"
                type="button"
                disabled={saving || loading}
                onClick={() => void save()}
              >
                <Save size={16} aria-hidden="true" />
                {saving ? "保存中…" : "保存配置"}
              </button>
            ) : null}
            <button
              className="root-email-test"
              type="button"
              disabled={
                !canEdit ||
                testing ||
                !config?.credentialConfigured ||
                !config.enabled
              }
              onClick={() => void test()}
            >
              <Send size={16} aria-hidden="true" />
              {testing ? "测试中…" : "测试连接"}
            </button>
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
