"use client";

import { Button } from "@appica/ui-react/button";
import { AlertTriangle, ReceiptText, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { InvoiceProviderRecord, InvoiceSetting } from "../api";
import {
  invoiceConfigurationResourceData,
  type InvoiceProviderDraft,
  type PlatformInvoiceConfigurationController,
} from "../hooks/usePlatformInvoiceConfigurationResources";
import { ModeDialog } from "./Overlays";
import { SectionHeading } from "./Primitives";

interface PlatformInvoiceConfigurationPanelProps {
  controller: PlatformInvoiceConfigurationController;
  onNotice: (message: string) => void;
}

export function PlatformInvoiceConfigurationPanel({
  controller,
  onNotice,
}: PlatformInvoiceConfigurationPanelProps) {
  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerMode, setProviderMode] =
    useState<InvoiceProviderDraft["mode"]>("test");
  const [providerSettings, setProviderSettings] = useState("{}");
  const [providerCredentialRef, setProviderCredentialRef] = useState("");
  const [targetProviderId, setTargetProviderId] = useState("");
  const displayedProviders = invoiceConfigurationResourceData(
    controller.providers,
  );
  const displayedSetting = invoiceConfigurationResourceData(controller.setting);
  const freshProviders =
    controller.providers.status === "ready" ? controller.providers.data : null;
  const freshSetting =
    controller.setting.status === "ready" ? controller.setting.data : null;
  const targetMode = freshSetting
    ? freshSetting.active_mode === "test"
      ? "production"
      : "test"
    : null;
  const targetProviders = useMemo(
    () =>
      targetMode
        ? (freshProviders?.filter(
            (provider) => provider.enabled && provider.mode === targetMode,
          ) ?? [])
        : [],
    [freshProviders, targetMode],
  );
  const selectedTargetProvider = targetProviders.find(
    (provider) => provider.provider_id === targetProviderId,
  );
  const providerWritable =
    !controller.writeBlockReason && controller.providers.status === "ready";
  const modeWritable =
    !controller.writeBlockReason &&
    controller.providers.status === "ready" &&
    controller.setting.status === "ready";

  useEffect(() => {
    if (
      targetProviderId &&
      !targetProviders.some(
        (provider) => provider.provider_id === targetProviderId,
      )
    ) {
      setTargetProviderId("");
      setModeDialogOpen(false);
    }
  }, [targetProviderId, targetProviders]);

  const submitProvider = async () => {
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(providerSettings) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch {
      onNotice("发票 provider settings 必须是 JSON 对象");
      return;
    }
    if (!providerName.trim()) {
      onNotice("请填写发票 provider 名称");
      return;
    }
    if (!providerKey.trim()) {
      onNotice("请选择发票 provider 协议");
      return;
    }
    if (providerMode === "production" && !providerCredentialRef.trim()) {
      onNotice("生产发票 provider 必须填写 secret reference");
      return;
    }
    const committed = await controller.commitProvider({
      name: providerName.trim(),
      providerKey,
      mode: providerMode,
      settings,
      credentialSecretRef: providerCredentialRef.trim() || undefined,
    });
    if (!committed) return;

    setProviderEditorOpen(false);
    setProviderName("");
    setProviderKey("");
    setProviderMode("test");
    setProviderSettings("{}");
    setProviderCredentialRef("");
    await controller.refreshProviders();
  };

  const confirmModeChange = async () => {
    if (!targetMode || !selectedTargetProvider) {
      onNotice("请选择目标模式下当前启用的发票 provider");
      return;
    }
    const committed = await controller.commitMode({
      mode: targetMode,
      providerId: selectedTargetProvider.provider_id,
    });
    if (!committed) return;
    setModeDialogOpen(false);
    setTargetProviderId("");
  };

  return (
    <div className="platform-invoice-configuration">
      <InvoiceConfigurationNotice controller={controller} />
      {controller.writeBlockReason &&
      (displayedProviders !== undefined || displayedSetting !== undefined) ? (
        <p className="invoice-configuration-status" role="status">
          {controller.writeBlockReason}
        </p>
      ) : null}

      <SectionHeading
        eyebrow="Invoice configuration"
        title="发票配置"
        actionClassName="invoice-provider-toggle min-h-11 min-w-11"
        action={
          providerEditorOpen
            ? "关闭配置"
            : providerWritable
              ? "配置 provider"
              : undefined
        }
        onAction={() => setProviderEditorOpen((current) => !current)}
      />

      {resourceStaleText(controller.providers, "发票 provider") ? (
        <p className="invoice-configuration-stale" role="status">
          {resourceStaleText(controller.providers, "发票 provider")}
        </p>
      ) : null}

      {displayedProviders?.length ? (
        <div className="provider-list" aria-label="已配置发票 provider">
          {displayedProviders.map((provider) => (
            <div className="provider-row" key={provider.provider_id}>
              <span>
                <strong>{provider.name}</strong>
                <small>
                  {provider.provider_key} · {provider.mode}
                </small>
              </span>
              <b>{provider.enabled ? "启用" : "停用"}</b>
            </div>
          ))}
        </div>
      ) : controller.providers.status === "ready" ? (
        <div className="invoice-provider-empty">
          <ReceiptText size={20} aria-hidden="true" />
          <p>尚未配置发票 provider。</p>
        </div>
      ) : null}

      {providerEditorOpen ? (
        <form
          className="admin-editor"
          aria-label="发票 provider 配置"
          onSubmit={(event) => {
            event.preventDefault();
            void submitProvider();
          }}
        >
          <div className="admin-editor-heading">
            <strong>新增发票 provider</strong>
            <Button
              className="min-h-11"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setProviderEditorOpen(false)}
            >
              关闭
            </Button>
          </div>
          <label>
            <span>名称</span>
            <input
              className="min-h-11"
              required
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="例如：电子发票服务"
            />
          </label>
          <label>
            <span>provider</span>
            <select
              className="min-h-11"
              required
              value={providerKey}
              onChange={(event) => setProviderKey(event.target.value)}
            >
              <option value="">选择 provider 协议</option>
              <option value="local_test">测试协议</option>
              <option value="http_json">HTTP JSON</option>
              <option value="fapiao_http">Fapiao HTTP</option>
            </select>
          </label>
          <label>
            <span>模式</span>
            <select
              className="min-h-11"
              required
              value={providerMode}
              onChange={(event) =>
                setProviderMode(
                  event.target.value as InvoiceProviderDraft["mode"],
                )
              }
            >
              <option value="test">测试</option>
              <option value="production">生产</option>
            </select>
          </label>
          <label>
            <span>secret reference</span>
            <input
              className="min-h-11"
              required={providerMode === "production"}
              value={providerCredentialRef}
              onChange={(event) => setProviderCredentialRef(event.target.value)}
              placeholder="file:///run/secrets/invoice/provider.token"
            />
          </label>
          <label>
            <span>settings（JSON）</span>
            <textarea
              required
              value={providerSettings}
              onChange={(event) => setProviderSettings(event.target.value)}
              rows={4}
              spellCheck={false}
            />
          </label>
          <Button
            className="min-h-11"
            size="md"
            type="submit"
            variant="primary"
            disabled={
              controller.mutation !== null ||
              !providerWritable ||
              !providerName.trim()
            }
          >
            {controller.mutation === "provider" ? "保存中…" : "保存 provider"}
          </Button>
        </form>
      ) : null}

      {resourceStaleText(controller.setting, "发票模式") ? (
        <p className="invoice-configuration-stale" role="status">
          {resourceStaleText(controller.setting, "发票模式")}
        </p>
      ) : null}

      <div className="invoice-mode-card">
        <div>
          <p className="eyebrow">发票运行模式</p>
          <strong>{settingLabel(controller.setting, displayedSetting)}</strong>
          <small>
            {providerBindingLabel(displayedProviders, displayedSetting)}
          </small>
        </div>
        {freshSetting ? (
          <form
            className="invoice-mode-switch"
            aria-label="切换发票运行模式"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedTargetProvider) {
                onNotice("请选择目标模式下当前启用的发票 provider");
                return;
              }
              setModeDialogOpen(true);
            }}
          >
            <label>
              <span>{targetMode === "test" ? "测试" : "生产"} provider</span>
              <select
                className="min-h-11"
                required
                value={targetProviderId}
                disabled={!modeWritable}
                onChange={(event) => setTargetProviderId(event.target.value)}
              >
                <option value="">选择目标 provider</option>
                {targetProviders.map((provider) => (
                  <option
                    key={provider.provider_id}
                    value={provider.provider_id}
                  >
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              className="min-h-11"
              size="md"
              type="submit"
              variant="primary"
              disabled={
                controller.mutation !== null ||
                !modeWritable ||
                !selectedTargetProvider
              }
            >
              切换模式
            </Button>
          </form>
        ) : null}
      </div>

      <ModeDialog
        open={modeDialogOpen}
        currentMode={freshSetting?.active_mode ?? "test"}
        resourceLabel="发票"
        onClose={() => setModeDialogOpen(false)}
        onConfirm={() => void confirmModeChange()}
      />
    </div>
  );
}

function InvoiceConfigurationNotice({
  controller,
}: Pick<PlatformInvoiceConfigurationPanelProps, "controller">) {
  const failures: Array<{ label: string; message: string }> = [];
  if (controller.providers.status === "error")
    failures.push({
      label: "发票 provider",
      message: controller.providers.message,
    });
  if (controller.setting.status === "error")
    failures.push({ label: "发票模式", message: controller.setting.message });
  if (failures.length) {
    return (
      <div className="invoice-configuration-alert" role="alert">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>部分发票配置暂时不可用</strong>
          <ul>
            {failures.map((failure) => (
              <li key={failure.label}>
                {failure.label}：{failure.message}
              </li>
            ))}
          </ul>
        </div>
        <Button
          className="min-h-11"
          size="sm"
          type="button"
          variant="outline"
          disabled={!controller.retryAvailable}
          onClick={() => void controller.retryFailed()}
        >
          <RefreshCw aria-hidden="true" size={14} />
          重试失败项
        </Button>
      </div>
    );
  }

  const loading = [controller.providers, controller.setting].filter(
    (resource) => resource.status === "loading",
  ).length;
  return loading ? (
    <p className="invoice-configuration-status" role="status">
      正在验证{loading === 2 ? "发票 provider 与运行模式" : "部分发票配置"}
      ；已完成的状态保持可用。
    </p>
  ) : null;
}

function settingLabel(
  resource: PlatformInvoiceConfigurationController["setting"],
  setting: InvoiceSetting | undefined,
): string {
  if (setting) return setting.active_mode === "test" ? "测试模式" : "生产模式";
  return resource.status === "loading" ? "读取中…" : "状态暂不可用";
}

function providerBindingLabel(
  providers: InvoiceProviderRecord[] | undefined,
  setting: InvoiceSetting | undefined,
): string {
  if (!setting) return "绑定状态待验证";
  if (!setting.provider_id) return "尚未绑定默认 provider";
  const provider = providers?.find(
    (item) => item.provider_id === setting.provider_id,
  );
  return provider ? `已绑定 ${provider.name}` : "已绑定 provider（名称待验证）";
}

function resourceStaleText(
  resource:
    | PlatformInvoiceConfigurationController["providers"]
    | PlatformInvoiceConfigurationController["setting"],
  label: string,
): string | null {
  if (resource.status === "ready" || resource.previous === undefined)
    return null;
  return resource.status === "loading"
    ? `${label} 正在重新验证；当前展示上次结果。`
    : `${label} 当前待验证；仅展示上次结果，配置操作已暂停。`;
}
