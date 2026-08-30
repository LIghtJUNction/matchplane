import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentGateways: vi.fn(),
  getPaymentRoutes: vi.fn(),
  savePaymentGateway: vi.fn(),
  savePaymentRoute: vi.fn(),
}));

vi.mock("../api", () => api);

import type { PaymentGatewayRecord, PaymentRouteRecord } from "../api";
import {
  usePlatformPaymentRoutingResources,
  type PaymentRoutingTenantState,
} from "./usePlatformPaymentRoutingResources";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getPaymentGateways.mockResolvedValue([]);
  api.getPaymentRoutes.mockResolvedValue([]);
  api.savePaymentGateway.mockResolvedValue(gateway("gateway-created"));
  api.savePaymentRoute.mockResolvedValue(route("route-created", "gateway-a"));
});

describe("usePlatformPaymentRoutingResources", () => {
  it("does not read before authorization and loads once when authorization is retained", async () => {
    const { rerender } = renderHook(
      ({ authorized }: { authorized: boolean }) =>
        usePlatformPaymentRoutingResources({
          authorized,
          apiAvailable: true,
          tenant: verifiedTenant,
          onNotice,
        }),
      { initialProps: { authorized: false } },
    );

    expect(api.getPaymentGateways).not.toHaveBeenCalled();
    expect(api.getPaymentRoutes).not.toHaveBeenCalled();

    rerender({ authorized: true });
    await waitFor(() => {
      expect(api.getPaymentGateways).toHaveBeenCalledOnce();
      expect(api.getPaymentRoutes).toHaveBeenCalledOnce();
    });

    rerender({ authorized: true });
    expect(api.getPaymentGateways).toHaveBeenCalledOnce();
    expect(api.getPaymentRoutes).toHaveBeenCalledOnce();
  });

  it("keeps a fresh sibling when one initial request fails and retries only the failure", async () => {
    api.getPaymentGateways.mockResolvedValue([gateway("gateway-a")]);
    api.getPaymentRoutes
      .mockRejectedValueOnce(new Error("路由服务暂时不可用"))
      .mockResolvedValueOnce([route("route-a", "gateway-a")]);
    const { result } = renderResources({ status: "unverified" });

    await waitFor(() => {
      expect(result.current.gateways.status).toBe("ready");
      expect(result.current.routes.status).toBe("error");
    });
    expect(result.current.gateways).toMatchObject({
      status: "ready",
      data: [{ gateway_id: "gateway-a" }],
    });

    await act(async () => {
      await result.current.retryFailed();
    });

    expect(api.getPaymentGateways).toHaveBeenCalledOnce();
    expect(api.getPaymentRoutes).toHaveBeenCalledTimes(2);
    expect(result.current.routes).toMatchObject({
      status: "ready",
      data: [{ route_id: "route-a" }],
    });
    expect(api.savePaymentGateway).not.toHaveBeenCalled();
    expect(api.savePaymentRoute).not.toHaveBeenCalled();
  });

  it("preserves prior gateway data as stale when a focused refresh fails", async () => {
    api.getPaymentGateways.mockResolvedValueOnce([gateway("gateway-a")]);
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => expect(result.current.gateways.status).toBe("ready"));

    api.getPaymentGateways.mockRejectedValueOnce(new Error("网关读取失败"));
    await act(async () => {
      await result.current.refreshGateways();
    });

    expect(result.current.gateways).toMatchObject({
      status: "error",
      message: "网关读取失败",
      previous: [{ gateway_id: "gateway-a" }],
    });
    expect(result.current.routes.status).toBe("ready");
  });

  it("lets only the latest gateway refresh update state", async () => {
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => expect(result.current.gateways.status).toBe("ready"));
    const older = deferred<PaymentGatewayRecord[]>();
    const newer = deferred<PaymentGatewayRecord[]>();
    api.getPaymentGateways
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;
    act(() => {
      firstRefresh = result.current.refreshGateways();
      secondRefresh = result.current.refreshGateways();
    });
    await act(async () => {
      newer.resolve([gateway("gateway-new")]);
      await secondRefresh;
    });
    await act(async () => {
      older.resolve([gateway("gateway-old")]);
      await firstRefresh;
    });

    expect(result.current.gateways).toMatchObject({
      status: "ready",
      data: [{ gateway_id: "gateway-new" }],
    });
  });

  it("rechecks tenant and gateway freshness, then never replays a committed POST", async () => {
    const { result, rerender } = renderResources({ status: "unverified" });
    await waitFor(() => expect(result.current.gateways.status).toBe("ready"));

    await act(async () => {
      expect(await result.current.commitGateway(gatewayDraft)).toBe(false);
    });
    expect(api.savePaymentGateway).not.toHaveBeenCalled();

    rerender({ tenant: verifiedTenant });
    await act(async () => {
      expect(await result.current.commitGateway(gatewayDraft)).toBe(true);
    });
    expect(api.savePaymentGateway).toHaveBeenCalledOnce();
    expect(api.savePaymentGateway).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant", name: "主网关" }),
    );
    expect(onNotice).toHaveBeenLastCalledWith(
      "支付网关已保存；请继续配置支付路由后再切换生产模式",
    );

    api.getPaymentGateways.mockRejectedValueOnce(new Error("重新读取失败"));
    await act(async () => {
      await result.current.refreshGateways();
    });
    expect(result.current.gateways).toMatchObject({
      status: "error",
      previous: [],
    });
    expect(onNotice).toHaveBeenLastCalledWith(
      "支付网关已保存；请继续配置支付路由后再切换生产模式",
    );

    api.getPaymentGateways.mockResolvedValueOnce([gateway("gateway-created")]);
    await act(async () => {
      await result.current.retryFailed();
    });
    expect(api.savePaymentGateway).toHaveBeenCalledOnce();
    expect(result.current.gateways.status).toBe("ready");
  });

  it("requires a current enabled gateway from fresh data when committing a route", async () => {
    api.getPaymentGateways.mockResolvedValueOnce([gateway("gateway-a")]);
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => {
      expect(result.current.gateways.status).toBe("ready");
      expect(result.current.routes.status).toBe("ready");
    });

    await act(async () => {
      expect(await result.current.commitRoute(routeDraft)).toBe(true);
    });
    expect(api.savePaymentRoute).toHaveBeenCalledOnce();
    expect(api.savePaymentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant", gatewayId: "gateway-a" }),
    );

    api.getPaymentGateways.mockResolvedValueOnce([
      { ...gateway("gateway-a"), enabled: false },
    ]);
    await act(async () => {
      await result.current.refreshGateways();
    });
    await act(async () => {
      expect(await result.current.commitRoute(routeDraft)).toBe(false);
    });
    expect(api.savePaymentRoute).toHaveBeenCalledOnce();
    expect(onNotice).toHaveBeenLastCalledWith(
      "所选支付网关已失效或停用，请重新选择",
    );
  });
});

function renderResources(tenant: PaymentRoutingTenantState) {
  return renderHook(
    ({ tenant: nextTenant }: { tenant: PaymentRoutingTenantState }) =>
      usePlatformPaymentRoutingResources({
        authorized: true,
        apiAvailable: true,
        tenant: nextTenant,
        onNotice,
      }),
    { initialProps: { tenant } },
  );
}

const verifiedTenant: PaymentRoutingTenantState = {
  status: "verified",
  tenantId: "tenant",
};

const gatewayDraft = {
  name: "主网关",
  kind: "test",
  mode: "test" as const,
  settings: {},
};

const routeDraft = {
  gatewayId: "gateway-a",
  methodCode: "card",
  currency: "CNY",
  priority: 100,
};

function gateway(id: string): PaymentGatewayRecord {
  return {
    gateway_id: id,
    tenant_id: "tenant",
    name: id,
    kind: "test",
    mode: "test",
    settings: {},
    credential_configured: true,
    enabled: true,
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

function route(id: string, gatewayId: string): PaymentRouteRecord {
  return {
    route_id: id,
    tenant_id: "tenant",
    gateway_id: gatewayId,
    method_code: "card",
    currency: "CNY",
    priority: 100,
    enabled: true,
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
