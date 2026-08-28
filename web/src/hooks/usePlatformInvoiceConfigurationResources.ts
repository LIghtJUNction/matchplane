"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getInvoiceProviders,
  getInvoiceSetting,
  saveInvoiceProvider,
  switchInvoiceMode,
  type InvoiceProviderRecord,
  type InvoiceSetting,
} from "../api";

export type InvoiceConfigurationTenantState =
  | { status: "unverified" }
  | { status: "verified"; tenantId: string | null };

export type InvoiceConfigurationResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; previous?: T };

export interface InvoiceProviderDraft {
  name: string;
  providerKey: string;
  mode: "test" | "production";
  settings: Record<string, unknown>;
  credentialSecretRef?: string;
}

interface InvoiceModeDraft {
  mode: "test" | "production";
  providerId: string;
}

export interface PlatformInvoiceConfigurationController {
  providers: InvoiceConfigurationResourceState<InvoiceProviderRecord[]>;
  setting: InvoiceConfigurationResourceState<InvoiceSetting>;
  mutation: "provider" | "mode" | null;
  writeBlockReason: string | null;
  retryAvailable: boolean;
  retryFailed: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshSetting: () => Promise<void>;
  commitProvider: (draft: InvoiceProviderDraft) => Promise<boolean>;
  commitMode: (draft: InvoiceModeDraft) => Promise<boolean>;
}

interface UsePlatformInvoiceConfigurationResourcesOptions {
  authorized: boolean;
  apiAvailable: boolean;
  tenant: InvoiceConfigurationTenantState;
  onNotice: (message: string) => void;
}

export function usePlatformInvoiceConfigurationResources({
  authorized,
  apiAvailable,
  tenant,
  onNotice,
}: UsePlatformInvoiceConfigurationResourcesOptions): PlatformInvoiceConfigurationController {
  const [providers, setProviders] = useState<
    InvoiceConfigurationResourceState<InvoiceProviderRecord[]>
  >({ status: "loading" });
  const [setting, setSetting] = useState<
    InvoiceConfigurationResourceState<InvoiceSetting>
  >({ status: "loading" });
  const [mutation, setMutation] = useState<"provider" | "mode" | null>(null);
  const mountedRef = useRef(false);
  const mutationRef = useRef<"provider" | "mode" | null>(null);
  const requestVersions = useRef({ providers: 0, setting: 0 });
  const stateRef = useRef({ providers, setting });
  const contextRef = useRef({ authorized, apiAvailable, tenant });
  stateRef.current = { providers, setting };
  contextRef.current = { authorized, apiAvailable, tenant };

  const refreshProviders = useCallback(async () => {
    const requestVersion = ++requestVersions.current.providers;
    setProviders((current) => loadingState(current));
    try {
      const data = await getInvoiceProviders();
      if (
        mountedRef.current &&
        requestVersions.current.providers === requestVersion
      ) {
        setProviders({ status: "ready", data });
      }
    } catch (error) {
      if (
        mountedRef.current &&
        requestVersions.current.providers === requestVersion
      ) {
        setProviders((current) =>
          errorState(current, errorMessage(error, "发票 provider 读取失败")),
        );
      }
    }
  }, []);

  const refreshSetting = useCallback(async () => {
    const requestVersion = ++requestVersions.current.setting;
    setSetting((current) => loadingState(current));
    try {
      const data = await getInvoiceSetting();
      if (
        mountedRef.current &&
        requestVersions.current.setting === requestVersion
      ) {
        setSetting({ status: "ready", data });
      }
    } catch (error) {
      if (
        mountedRef.current &&
        requestVersions.current.setting === requestVersion
      ) {
        setSetting((current) =>
          errorState(current, errorMessage(error, "发票模式读取失败")),
        );
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!authorized || !apiAvailable) {
      requestVersions.current.providers += 1;
      requestVersions.current.setting += 1;
      const message = authorized
        ? "当前部署未启用支付管理 API"
        : "当前账号无权读取发票配置";
      setProviders((current) => errorState(current, message));
      setSetting((current) => errorState(current, message));
    } else {
      void Promise.all([refreshProviders(), refreshSetting()]);
    }
    return () => {
      mountedRef.current = false;
      requestVersions.current.providers += 1;
      requestVersions.current.setting += 1;
    };
  }, [apiAvailable, authorized, refreshProviders, refreshSetting]);

  const retryFailed = useCallback(async () => {
    const context = contextRef.current;
    if (!context.authorized || !context.apiAvailable) return;
    const current = stateRef.current;
    const retries: Promise<void>[] = [];
    if (current.providers.status === "error") retries.push(refreshProviders());
    if (current.setting.status === "error") retries.push(refreshSetting());
    await Promise.all(retries);
  }, [refreshProviders, refreshSetting]);

  const commitProvider = useCallback(
    async (draft: InvoiceProviderDraft): Promise<boolean> => {
      const context = contextRef.current;
      const tenantId = writableTenantId(context, onNotice);
      if (!tenantId) return false;
      if (stateRef.current.providers.status !== "ready") {
        onNotice("发票 provider 状态尚未验证，请重新读取后再保存");
        return false;
      }
      if (mutationRef.current) return false;

      mutationRef.current = "provider";
      if (mountedRef.current) setMutation("provider");
      try {
        await saveInvoiceProvider({
          tenantId,
          ...draft,
          enabled: true,
          reason: "platform dashboard create invoice provider",
        });
        onNotice("发票 provider 已保存；切换生产模式前请完成真实税务服务校验");
        return true;
      } catch (error) {
        onNotice(errorMessage(error, "发票 provider 保存失败"));
        return false;
      } finally {
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
      }
    },
    [onNotice],
  );

  const commitMode = useCallback(
    async (draft: InvoiceModeDraft): Promise<boolean> => {
      const context = contextRef.current;
      const tenantId = writableTenantId(context, onNotice);
      if (!tenantId) return false;
      const current = stateRef.current;
      if (current.setting.status !== "ready") {
        onNotice("发票模式状态尚未验证，请重新读取后再切换");
        return false;
      }
      if (current.providers.status !== "ready") {
        onNotice("发票 provider 状态尚未验证，请重新读取后再切换");
        return false;
      }
      if (current.setting.data.tenant_id !== tenantId) {
        onNotice("发票模式所属租户已变化，请重新读取后再切换");
        return false;
      }
      if (current.setting.data.active_mode === draft.mode) {
        onNotice("发票系统已经处于目标模式");
        return false;
      }
      const provider = current.providers.data.find(
        (item) => item.provider_id === draft.providerId,
      );
      if (
        !provider?.enabled ||
        provider.mode !== draft.mode ||
        provider.tenant_id !== tenantId
      ) {
        onNotice("所选发票 provider 已失效、停用或不属于目标模式");
        return false;
      }
      if (mutationRef.current) return false;

      mutationRef.current = "mode";
      if (mountedRef.current) setMutation("mode");
      try {
        const nextSetting = await switchInvoiceMode({
          tenantId,
          mode: draft.mode,
          providerId: provider.provider_id,
          expectedVersion: current.setting.data.version,
          reason: `web-admin switch invoice mode to ${draft.mode}`,
        });
        requestVersions.current.setting += 1;
        if (mountedRef.current)
          setSetting({ status: "ready", data: nextSetting });
        onNotice(
          `发票系统已切换为${nextSetting.active_mode === "test" ? "测试" : "生产"}模式`,
        );
        return true;
      } catch (error) {
        onNotice(errorMessage(error, "发票模式切换失败"));
        return false;
      } finally {
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
      }
    },
    [onNotice],
  );

  return {
    providers,
    setting,
    mutation,
    writeBlockReason: invoiceWriteBlockReason({
      authorized,
      apiAvailable,
      tenant,
    }),
    retryAvailable: authorized && apiAvailable,
    retryFailed,
    refreshProviders,
    refreshSetting,
    commitProvider,
    commitMode,
  };
}

export function invoiceConfigurationResourceData<T>(
  state: InvoiceConfigurationResourceState<T>,
): T | undefined {
  return state.status === "ready" ? state.data : state.previous;
}

function invoiceWriteBlockReason(context: {
  authorized: boolean;
  apiAvailable: boolean;
  tenant: InvoiceConfigurationTenantState;
}): string | null {
  if (!context.authorized) return "当前账号无权修改发票配置";
  if (!context.apiAvailable) return "当前部署未启用支付管理 API";
  if (context.tenant.status !== "verified")
    return "商城租户状态尚未验证，发票配置当前只读";
  if (!context.tenant.tenantId)
    return "商城已确认尚未完成初始化，发票配置当前只读";
  return null;
}

function writableTenantId(
  context: {
    authorized: boolean;
    apiAvailable: boolean;
    tenant: InvoiceConfigurationTenantState;
  },
  onNotice: (message: string) => void,
): string | null {
  const reason = invoiceWriteBlockReason(context);
  if (reason) {
    onNotice(reason);
    return null;
  }
  return context.tenant.status === "verified" ? context.tenant.tenantId : null;
}

function loadingState<T>(
  current: InvoiceConfigurationResourceState<T>,
): InvoiceConfigurationResourceState<T> {
  const previous = invoiceConfigurationResourceData(current);
  return previous === undefined
    ? { status: "loading" }
    : { status: "loading", previous };
}

function errorState<T>(
  current: InvoiceConfigurationResourceState<T>,
  message: string,
): InvoiceConfigurationResourceState<T> {
  const previous = invoiceConfigurationResourceData(current);
  return previous === undefined
    ? { status: "error", message }
    : { status: "error", message, previous };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
