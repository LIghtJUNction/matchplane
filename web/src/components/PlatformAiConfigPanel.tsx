"use client";

import type { SyntheticEvent } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  OFFICIAL_AI_PROVIDERS,
  usePlatformAiConfiguration,
  type PlatformAiConfigurationController,
  type PlatformAiProviderChoice,
} from "../hooks/usePlatformAiConfiguration";
import type {
  ManagedPlatformRouterConfig,
  PlatformRouterEffectiveStatus,
} from "../api";
import { SectionHeading } from "./Primitives";
import styles from "./PlatformAiConfigPanel.module.css";

export function PlatformAiConfigPanel({
  rootRole,
  onNotice,
}: {
  rootRole?: string | null;
  onNotice: (message: string) => void;
}) {
  const controller = usePlatformAiConfiguration({
    canEdit: rootRole === "rootSuperAdmin",
    onNotice,
  });

  return (
    <section
      className={`surface root-email-config ${styles.panel}`}
      aria-labelledby="platform-ai-config-title"
    >
      <SectionHeading title="AI" titleId="platform-ai-config-title" />
      <p className="subplatform-intro">
        选择服务商，填写密钥和模型，测试通过后再应用。已生效连接在测试期间不会改变。
      </p>

      <PanelContent controller={controller} />

      {controller.canEdit ? null : (
        <p className={styles.permissionNote}>
          <Bot size={15} aria-hidden="true" />
          商城运营可以查看状态；只有商城负责人可以修改并应用 AI 配置。
        </p>
      )}
    </section>
  );
}

function PanelContent({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  if (controller.async.loading) {
    return (
      <div className={styles.loadingState} role="status">
        正在读取 AI 配置…
      </div>
    );
  }
  if (controller.async.loadError) {
    return (
      <LoadError
        message={controller.async.loadError}
        retry={controller.retryLoad}
      />
    );
  }
  return <ConfigurationForm controller={controller} />;
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className={styles.errorState} role="alert">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>配置暂时无法读取</strong>
        <p>{message}</p>
      </div>
      <button type="button" onClick={retry}>
        <RefreshCw size={16} aria-hidden="true" />
        重新读取
      </button>
    </div>
  );
}

function ConfigurationForm({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void controller.saveAndTest();
  };

  return (
    <>
      <EffectiveStatus effective={controller.managed.effective} />
      <form className={styles.form} onSubmit={submit}>
        <EssentialFields controller={controller} />
        <ConnectionFields controller={controller} />
        <AdvancedSettings controller={controller} />
        <ActionArea controller={controller} />
      </form>
    </>
  );
}

function EssentialFields({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const { form } = controller;
  const disabled = !controller.canEdit || controller.interactionLocked;

  return (
    <div className={styles.essentialGrid}>
      <label className={styles.field} htmlFor="platform-ai-provider">
        <span>AI 服务商</span>
        <select
          id="platform-ai-provider"
          aria-label="AI 服务商"
          aria-describedby="platform-ai-provider-help"
          value={form.provider}
          disabled={disabled}
          onChange={(event) =>
            controller.chooseProvider(
              event.target.value as PlatformAiProviderChoice,
            )
          }
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic Claude</option>
          <option value="gemini">Google Gemini</option>
          <option value="custom">自定义兼容服务</option>
        </select>
        <small id="platform-ai-provider-help">
          {form.provider === "custom"
            ? "适用于中转网关、私有部署和兼容接口。"
            : `使用 ${providerLabel(form.provider)} 官方 API 地址。`}
        </small>
      </label>

      <label className={styles.field} htmlFor="platform-ai-model">
        <span>模型 ID</span>
        <Input
          id="platform-ai-model"
          aria-label="模型 ID"
          aria-describedby="platform-ai-model-help"
          value={form.model}
          disabled={disabled}
          maxLength={256}
          required
          onChange={(event) =>
            controller.updateForm({
              model: event.target.value,
              assistantReasoningEffort: "none",
            })
          }
          placeholder={modelPlaceholder(form.protocol)}
        />
        <small id="platform-ai-model-help">
          {modelHelp(form.provider)}
        </small>
      </label>

      <ApiKeyField controller={controller} disabled={disabled} />
    </div>
  );
}

function ApiKeyField({
  controller,
  disabled,
}: {
  controller: PlatformAiConfigurationController;
  disabled: boolean;
}) {
  const { form } = controller;
  return (
    <div className={`${styles.field} ${styles.keyField}`}>
      <label htmlFor="platform-ai-key">API Key</label>
      <div className={styles.secretInput}>
        <Input
          id="platform-ai-key"
          aria-describedby="platform-ai-key-help"
          type={form.showApiKey ? "text" : "password"}
          value={form.apiKey}
          disabled={disabled}
          onChange={(event) =>
            controller.updateForm({ apiKey: event.target.value })
          }
          autoComplete="new-password"
          placeholder={
            controller.savedCredentialFitsConnection
              ? "已安全保存；留空继续使用"
              : "粘贴服务商签发的 API Key"
          }
        />
        <button
          type="button"
          className={styles.revealButton}
          disabled={disabled || !form.apiKey}
          onClick={() =>
            controller.updateForm({ showApiKey: !form.showApiKey })
          }
          aria-label={
            form.showApiKey
              ? "隐藏本次输入的 API Key"
              : "显示本次输入的 API Key"
          }
        >
          {form.showApiKey ? (
            <EyeOff size={17} aria-hidden="true" />
          ) : (
            <Eye size={17} aria-hidden="true" />
          )}
        </button>
      </div>
      <small id="platform-ai-key-help">
        {controller.savedCredentialFitsConnection
          ? "服务器已有可用密钥；页面不会读取或显示它。"
          : "切换连接地址后需要填写适用于新地址的密钥。"}
      </small>
    </div>
  );
}

function ConnectionFields({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  if (controller.form.provider === "custom") {
    return <CustomConnection controller={controller} />;
  }
  return (
    <div className={styles.officialConnection}>
      <ShieldCheck size={17} aria-hidden="true" />
      <span>
        官方连接地址：<code>{controller.form.endpoint}</code>
      </span>
    </div>
  );
}

function CustomConnection({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const { form } = controller;
  const disabled = !controller.canEdit || controller.interactionLocked;
  return (
    <div className={styles.customConnection}>
      <div>
        <strong>自定义连接</strong>
        <p>按服务商文档填写协议与 HTTPS API 基址。</p>
      </div>
      <div className={styles.connectionGrid}>
        <label className={styles.field} htmlFor="platform-ai-protocol">
          <span>兼容协议</span>
          <select
            id="platform-ai-protocol"
            aria-label="兼容协议"
            value={form.protocol}
            disabled={disabled}
            onChange={(event) =>
              controller.updateForm({
                protocol:
                  event.target.value as ManagedPlatformRouterConfig["protocol"],
                model: "",
                apiKey: "",
                showApiKey: false,
                assistantReasoningEffort: "none",
              })
            }
          >
            <option value="openai-compatible">OpenAI Compatible</option>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="gemini-generate-content">
              Gemini Generate Content
            </option>
          </select>
        </label>
        <label className={styles.field} htmlFor="platform-ai-endpoint">
          <span>API 基址</span>
          <Input
            id="platform-ai-endpoint"
            aria-label="API 基址"
            aria-describedby="platform-ai-endpoint-help"
            value={form.endpoint}
            disabled={disabled}
            onChange={(event) =>
              controller.updateForm({
                endpoint: event.target.value,
                apiKey: "",
                showApiKey: false,
              })
            }
            placeholder={endpointPlaceholder(form.protocol)}
            inputMode="url"
            required
          />
          <small id="platform-ai-endpoint-help">
            {protocolHelp(form.protocol)}
          </small>
        </label>
      </div>
    </div>
  );
}

function AdvancedSettings({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const { form } = controller;
  const disabled = !controller.canEdit || controller.interactionLocked;
  return (
    <details className={styles.advanced}>
      <summary>
        <SlidersHorizontal size={17} aria-hidden="true" />
        导购行为与高级设置
        <span className={styles.disclosureIcon} aria-hidden="true" />
      </summary>
      <div className={styles.advancedBody}>
        <label className={styles.field} htmlFor="platform-ai-instructions">
          <span>补充指引（可选）</span>
          <textarea
            id="platform-ai-instructions"
            value={form.assistantInstructions}
            disabled={disabled}
            maxLength={4000}
            rows={4}
            onChange={(event) =>
              controller.updateForm({
                assistantInstructions: event.target.value,
              })
            }
            placeholder="例如：先确认预算和用途，再给出商品对比。"
          />
        </label>
        <AdvancedNumberFields controller={controller} disabled={disabled} />
        <ReasoningField controller={controller} disabled={disabled} />
        <ToolBoundary />
      </div>
    </details>
  );
}

function AdvancedNumberFields({
  controller,
  disabled,
}: {
  controller: PlatformAiConfigurationController;
  disabled: boolean;
}) {
  const { form } = controller;
  return (
    <div className={styles.advancedGrid}>
      <NumberField
        label="单次回答上限"
        value={form.assistantMaxOutputTokens}
        min={64}
        max={512}
        help="64–512 tokens"
        disabled={disabled}
        onChange={(value) =>
          controller.updateForm({ assistantMaxOutputTokens: value })
        }
      />
      <NumberField
        label="回答发散度"
        value={form.assistantTemperature}
        min={0}
        max={1}
        step={0.1}
        help="0 更稳定，1 更开放"
        disabled={disabled}
        onChange={(value) =>
          controller.updateForm({ assistantTemperature: value })
        }
      />
      <NumberField
        label="工具循环步数"
        value={form.assistantMaxSteps}
        min={2}
        max={8}
        help="2–8 步，保留最终回答"
        disabled={disabled}
        onChange={(value) =>
          controller.updateForm({ assistantMaxSteps: value })
        }
      />
      <NumberField
        label="单次超时"
        value={form.assistantTimeoutMs}
        min={4000}
        max={30000}
        step={1000}
        help="4000–30000 ms"
        disabled={disabled}
        onChange={(value) =>
          controller.updateForm({ assistantTimeoutMs: value })
        }
      />
    </div>
  );
}

function ReasoningField({
  controller,
  disabled,
}: {
  controller: PlatformAiConfigurationController;
  disabled: boolean;
}) {
  if (!controller.reasoningEfforts.length) return null;
  return (
    <label className={styles.field}>
      <span>思考等级</span>
      <select
        value={controller.form.assistantReasoningEffort}
        disabled={disabled}
        onChange={(event) =>
          controller.updateForm({
            assistantReasoningEffort: event.target.value,
          })
        }
      >
        <option value="none">不指定，由模型决定</option>
        {controller.reasoningEfforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <small>仅使用供应商已声明的能力，不按模型名猜测。</small>
    </label>
  );
}

function ToolBoundary() {
  return (
    <div className={styles.toolBoundary}>
      <strong>AI 可以使用</strong>
      <ul>
        <li>公开店铺与商品检索</li>
        <li>商品比较与购物计算</li>
        <li>基础计算</li>
      </ul>
      <p>
        服务端会重新读取工具结果；模型不能读取联系方式、密钥或未审核商品。
      </p>
    </div>
  );
}

function ActionArea({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const draft = controller.managed.draft;
  const busy = controller.async.action;
  return (
    <div className={styles.actionArea}>
      <DraftState controller={controller} />
      <FeedbackMessage feedback={controller.async.feedback} />
      <div className={styles.actions}>
        <button
          className={
            controller.canActivate
              ? styles.secondaryAction
              : styles.primaryAction
          }
          type="submit"
          disabled={
            !controller.canEdit ||
            controller.interactionLocked ||
            !controller.formReady
          }
        >
          <Send size={16} aria-hidden="true" />
          {saveTestLabel(busy, Boolean(draft), controller.hasUnsavedChanges)}
        </button>
        <button
          className={
            controller.canActivate
              ? styles.primaryAction
              : styles.secondaryAction
          }
          type="button"
          disabled={
            !controller.canEdit ||
            controller.interactionLocked ||
            !controller.canActivate
          }
          onClick={() => void controller.activate()}
        >
          <Power size={16} aria-hidden="true" />
          {busy === "activate" ? "应用中…" : "应用到生产"}
        </button>
      </div>
      <small className={styles.actionHelp}>
        保存和测试不会影响当前生效配置；只有“应用到生产”会切换连接。
      </small>
    </div>
  );
}

function FeedbackMessage({
  feedback,
}: {
  feedback: PlatformAiConfigurationController["async"]["feedback"];
}) {
  if (!feedback) return null;
  return (
    <div
      className={`${styles.feedback} ${styles[feedback.tone]}`}
      role={feedback.tone === "error" ? "alert" : "status"}
    >
      {feedback.text}
    </div>
  );
}

function saveTestLabel(
  action: PlatformAiConfigurationController["async"]["action"],
  hasDraft: boolean,
  hasUnsavedChanges: boolean,
): string {
  if (action === "save-test") return "保存并测试中…";
  if (hasDraft && !hasUnsavedChanges) return "重新测试";
  return "保存并测试";
}

function DraftState({
  controller,
}: {
  controller: PlatformAiConfigurationController;
}) {
  const draft = controller.managed.draft;
  if (controller.hasUnsavedChanges) {
    return (
      <div className={styles.draftState} aria-live="polite">
        <CircleAlert size={17} aria-hidden="true" />
        <span>当前页面有尚未测试的改动。</span>
      </div>
    );
  }
  if (draft?.testedReady) {
    return (
      <div className={styles.draftState} aria-live="polite">
        <CheckCircle2 size={17} aria-hidden="true" />
        <span>
          待测配置已通过
          {draft.testedAt ? ` · ${formatTestedAt(draft.testedAt)}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.draftState} aria-live="polite">
      {draft ? (
        <>
          <CircleAlert size={17} aria-hidden="true" />
          <span>待测配置尚未通过连接测试。</span>
        </>
      ) : (
        <span>尚未创建待测配置。</span>
      )}
    </div>
  );
}

function EffectiveStatus({
  effective,
}: {
  effective: PlatformRouterEffectiveStatus | null;
}) {
  if (!effective) return <EmptyEffectiveStatus />;
  const summary =
    effective.ready && effective.model
      ? `${providerLabelFromProtocol(effective.protocol)} · ${effective.model}`
      : effective.issues.map(issueLabel).join("、") || "等待配置";
  return (
    <div
      className={`${styles.effectiveStatus} ${effective.ready ? styles.ready : styles.blocked}`}
      role="status"
    >
      {effective.ready ? (
        <ShieldCheck size={18} aria-hidden="true" />
      ) : (
        <CircleAlert size={18} aria-hidden="true" />
      )}
      <div>
        <strong>{effective.ready ? "AI 导购正在运行" : "AI 导购未就绪"}</strong>
        <p>{summary}</p>
        <EffectiveDetails effective={effective} />
      </div>
    </div>
  );
}

function EmptyEffectiveStatus() {
  return (
    <div className={`${styles.effectiveStatus} ${styles.blocked}`}>
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>尚未配置 AI 导购</strong>
        <p>选择服务商并完成连接测试后即可应用。</p>
      </div>
    </div>
  );
}

function EffectiveDetails({
  effective,
}: {
  effective: PlatformRouterEffectiveStatus;
}) {
  const conflicts = Object.values(effective.conflicts).some(
    (conflict) => conflict === true,
  );
  const managedOverrideMessage = conflicts
    ? "WebUI 配置正在覆盖环境变量，且两处非秘密配置存在冲突。"
    : "WebUI 配置正在覆盖环境变量。";
  return (
    <details className={styles.statusDetails}>
      <summary>
        查看连接详情
        <span className={styles.disclosureIcon} aria-hidden="true" />
      </summary>
      <dl>
        <div>
          <dt>生效来源</dt>
          <dd>{sourceLabel(effective.source)}</dd>
        </div>
        <div>
          <dt>协议</dt>
          <dd>{effective.protocol ?? "未配置"}</dd>
        </div>
        <div>
          <dt>来源限制</dt>
          <dd>{effective.originAllowlistApplied ? "已应用" : "未配置"}</dd>
        </div>
      </dl>
      {!effective.ready && effective.issues.length ? (
        <p>{effective.issues.map(issueLabel).join("、")}</p>
      ) : null}
      {effective.managedOverridesEnvironment ? (
        <p>{managedOverrideMessage}</p>
      ) : null}
    </details>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  help,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step?: number;
  help: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{help}</small>
    </label>
  );
}

function providerLabel(provider: PlatformAiProviderChoice): string {
  if (provider === "custom") return "自定义兼容服务";
  return OFFICIAL_AI_PROVIDERS[provider].label;
}

function providerLabelFromProtocol(
  protocol: PlatformRouterEffectiveStatus["protocol"],
): string {
  if (protocol === "anthropic-messages") return "Anthropic Claude";
  if (protocol === "gemini-generate-content") return "Google Gemini";
  if (protocol === "openai-compatible") return "OpenAI Compatible";
  return "未配置服务商";
}

function endpointPlaceholder(
  protocol: ManagedPlatformRouterConfig["protocol"],
): string {
  if (protocol === "anthropic-messages") return "https://api.anthropic.com";
  if (protocol === "gemini-generate-content")
    return "https://generativelanguage.googleapis.com";
  return "https://provider.example/v1";
}

function modelPlaceholder(
  protocol: ManagedPlatformRouterConfig["protocol"],
): string {
  if (protocol === "anthropic-messages") return "例如 claude-…";
  if (protocol === "gemini-generate-content") return "例如 gemini-…";
  return "供应商控制台中的模型 ID";
}

function protocolHelp(
  protocol: ManagedPlatformRouterConfig["protocol"],
): string {
  if (protocol === "anthropic-messages")
    return "填写实现 Messages 协议的 HTTPS 基址。";
  if (protocol === "gemini-generate-content")
    return "填写实现 Generate Content 协议的 HTTPS 基址。";
  return "填写 OpenAI-compatible HTTPS 基址，可包含 /v1。";
}

function modelHelp(provider: PlatformAiProviderChoice): string {
  return `请从 ${providerLabel(provider)} 控制台或文档复制准确模型 ID。`;
}

function formatTestedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sourceLabel(source: PlatformRouterEffectiveStatus["source"]): string {
  if (source === "managed") return "WebUI 托管";
  if (source === "environment") return "环境变量";
  return "未配置";
}

function issueLabel(issue: string): string {
  const labels = {
    provider_not_configured: "供应商未配置",
    provider_not_enabled: "尚未启用",
    credential_not_configured: "API Key 未配置",
    endpoint_invalid: "API 基址必须是安全的 HTTPS URL",
    model_invalid: "模型 ID 无效",
    protocol_invalid: "协议不受支持",
    origin_allowlist_invalid: "供应商来源限制无效",
    endpoint_origin_not_allowed: "API 地址不在允许来源中",
    managed_configuration_unreadable: "托管配置无法安全读取",
  } satisfies Record<string, string>;
  return Object.hasOwn(labels, issue)
    ? labels[issue as keyof typeof labels]
    : "配置不符合要求";
}
