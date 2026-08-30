"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getPaymentGateways,
  getPaymentRoutes,
  savePaymentGateway,
  savePaymentRoute,
  type PaymentGatewayRecord,
  type PaymentRouteRecord,
} from "../api";

export type PaymentRoutingTenantState =
  | { status: "unverified" }
  | { status: "verified"; tenantId: string | null };

export type PaymentRoutingResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; previous?: T };

export interface PaymentGatewayDraft {
  name: string;
  kind: PaymentGatewayRecord["kind"];
  mode: "test" | "production";
  settings: Record<string, unknown>;
  credentialSecretRef?: string;
}

interface PaymentRouteDraft {
  gatewayId: string;
  methodCode: string;
  currency: string;
  priority: number;
}

export interface PlatformPaymentRoutingController {
  gateways: PaymentRoutingResourceState<PaymentGatewayRecord[]>;
  routes: PaymentRoutingResourceState<PaymentRouteRecord[]>;
  mutation: "gateway" | "route" | null;
  writeBlockReason: string | null;
  retryAvailable: boolean;
  retryFailed: () => Promise<void>;
  refreshGateways: () => Promise<void>;
  refreshRoutes: () => Promise<void>;
  commitGateway: (draft: PaymentGatewayDraft) => Promise<boolean>;
  commitRoute: (draft: PaymentRouteDraft) => Promise<boolean>;
}

interface UsePlatformPaymentRoutingResourcesOptions {
  authorized: boolean;
  apiAvailable: boolean;
  tenant: PaymentRoutingTenantState;
  onNotice: (message: string) => void;
}

export function usePlatformPaymentRoutingResources({
  authorized,
  apiAvailable,
  tenant,
  onNotice,
}: UsePlatformPaymentRoutingResourcesOptions): PlatformPaymentRoutingController {
  const [gateways, setGateways] = useState<
    PaymentRoutingResourceState<PaymentGatewayRecord[]>
  >({ status: "loading" });
  const [routes, setRoutes] = useState<
    PaymentRoutingResourceState<PaymentRouteRecord[]>
  >({ status: "loading" });
  const [mutation, setMutation] = useState<"gateway" | "route" | null>(null);
  const mountedRef = useRef(false);
  const mutationRef = useRef<"gateway" | "route" | null>(null);
  const requestVersions = useRef({ gateways: 0, routes: 0 });
  const stateRef = useRef({ gateways, routes });
  const contextRef = useRef({ authorized, apiAvailable, tenant });
  stateRef.current = { gateways, routes };
  contextRef.current = { authorized, apiAvailable, tenant };

  const refreshGateways = useCallback(async () => {
    const requestVersion = ++requestVersions.current.gateways;
    setGateways((current) => loadingState(current));
    try {
      const data = await getPaymentGateways();
      if (
        mountedRef.current &&
        requestVersions.current.gateways === requestVersion
      ) {
        setGateways({ status: "ready", data });
      }
    } catch (error) {
      if (
        mountedRef.current &&
        requestVersions.current.gateways === requestVersion
      ) {
        setGateways((current) =>
          errorState(current, errorMessage(error, "支付网关读取失败")),
        );
      }
    }
  }, []);

  const refreshRoutes = useCallback(async () => {
    const requestVersion = ++requestVersions.current.routes;
    setRoutes((current) => loadingState(current));
    try {
      const data = await getPaymentRoutes();
      if (
        mountedRef.current &&
        requestVersions.current.routes === requestVersion
      ) {
        setRoutes({ status: "ready", data });
      }
    } catch (error) {
      if (
        mountedRef.current &&
        requestVersions.current.routes === requestVersion
      ) {
        setRoutes((current) =>
          errorState(current, errorMessage(error, "支付路由读取失败")),
        );
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!authorized || !apiAvailable) {
      requestVersions.current.gateways += 1;
      requestVersions.current.routes += 1;
      const message = authorized
        ? "当前部署未启用支付管理 API"
        : "当前账号无权读取支付配置";
      setGateways((current) => errorState(current, message));
      setRoutes((current) => errorState(current, message));
    } else {
      void Promise.all([refreshGateways(), refreshRoutes()]);
    }
    return () => {
      mountedRef.current = false;
      requestVersions.current.gateways += 1;
      requestVersions.current.routes += 1;
    };
  }, [apiAvailable, authorized, refreshGateways, refreshRoutes]);

  const retryFailed = useCallback(async () => {
    const context = contextRef.current;
    if (!context.authorized || !context.apiAvailable) return;
    const current = stateRef.current;
    const retries: Promise<void>[] = [];
    if (current.gateways.status === "error") retries.push(refreshGateways());
    if (current.routes.status === "error") retries.push(refreshRoutes());
    await Promise.all(retries);
  }, [refreshGateways, refreshRoutes]);

  const commitGateway = useCallback(
    async (draft: PaymentGatewayDraft): Promise<boolean> => {
      const context = contextRef.current;
      const tenantId = writableTenantId(context, onNotice);
      if (!tenantId) return false;
      if (stateRef.current.gateways.status !== "ready") {
        onNotice("支付网关状态尚未验证，请重新读取后再保存");
        return false;
      }
      if (mutationRef.current) return false;

      mutationRef.current = "gateway";
      if (mountedRef.current) setMutation("gateway");
      try {
        await savePaymentGateway({
          tenantId,
          ...draft,
          enabled: true,
          reason: "platform dashboard create gateway",
        });
        onNotice("支付网关已保存；请继续配置支付路由后再切换生产模式");
        return true;
      } catch (error) {
        onNotice(errorMessage(error, "支付网关保存失败"));
        return false;
      } finally {
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
      }
    },
    [onNotice],
  );

  const commitRoute = useCallback(
    async (draft: PaymentRouteDraft): Promise<boolean> => {
      const context = contextRef.current;
      const tenantId = writableTenantId(context, onNotice);
      if (!tenantId) return false;
      const current = stateRef.current;
      if (current.routes.status !== "ready") {
        onNotice("支付路由状态尚未验证，请重新读取后再保存");
        return false;
      }
      if (current.gateways.status !== "ready") {
        onNotice("支付网关状态尚未验证，请重新读取后再保存路由");
        return false;
      }
      const gateway = current.gateways.data.find(
        (item) => item.gateway_id === draft.gatewayId,
      );
      if (!gateway?.enabled || gateway.tenant_id !== tenantId) {
        onNotice("所选支付网关已失效或停用，请重新选择");
        return false;
      }
      if (mutationRef.current) return false;

      mutationRef.current = "route";
      if (mountedRef.current) setMutation("route");
      try {
        await savePaymentRoute({
          tenantId,
          gatewayId: gateway.gateway_id,
          methodCode: draft.methodCode,
          currency: draft.currency,
          priority: draft.priority,
          enabled: true,
          reason: "platform dashboard create payment route",
        });
        onNotice("支付路由已保存；切换生产模式前请完成网关健康检查");
        return true;
      } catch (error) {
        onNotice(errorMessage(error, "支付路由保存失败"));
        return false;
      } finally {
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
      }
    },
    [onNotice],
  );

  return {
    gateways,
    routes,
    mutation,
    writeBlockReason: paymentWriteBlockReason({
      authorized,
      apiAvailable,
      tenant,
    }),
    retryAvailable: authorized && apiAvailable,
    retryFailed,
    refreshGateways,
    refreshRoutes,
    commitGateway,
    commitRoute,
  };
}

export function paymentRoutingResourceData<T>(
  state: PaymentRoutingResourceState<T>,
): T | undefined {
  return state.status === "ready" ? state.data : state.previous;
}

function paymentWriteBlockReason(context: {
  authorized: boolean;
  apiAvailable: boolean;
  tenant: PaymentRoutingTenantState;
}): string | null {
  if (!context.authorized) return "当前账号无权修改支付配置";
  if (!context.apiAvailable) return "当前部署未启用支付管理 API";
  if (context.tenant.status !== "verified")
    return "商城租户状态尚未验证，支付配置当前只读";
  if (!context.tenant.tenantId)
    return "商城已确认尚未完成初始化，支付配置当前只读";
  return null;
}

function writableTenantId(
  context: {
    authorized: boolean;
    apiAvailable: boolean;
    tenant: PaymentRoutingTenantState;
  },
  onNotice: (message: string) => void,
): string | null {
  const reason = paymentWriteBlockReason(context);
  if (reason) {
    onNotice(reason);
    return null;
  }
  return context.tenant.status === "verified" ? context.tenant.tenantId : null;
}

function loadingState<T>(
  current: PaymentRoutingResourceState<T>,
): PaymentRoutingResourceState<T> {
  const previous = paymentRoutingResourceData(current);
  return previous === undefined
    ? { status: "loading" }
    : { status: "loading", previous };
}

function errorState<T>(
  current: PaymentRoutingResourceState<T>,
  message: string,
): PaymentRoutingResourceState<T> {
  const previous = paymentRoutingResourceData(current);
  return previous === undefined
    ? { status: "error", message }
    : { status: "error", message, previous };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
