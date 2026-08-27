import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getInvoiceProviders: vi.fn(),
  getInvoiceSetting: vi.fn(),
  saveInvoiceProvider: vi.fn(),
  switchInvoiceMode: vi.fn(),
}));

vi.mock("../api", () => api);

import type { InvoiceProviderRecord, InvoiceSetting } from "../api";
import {
  usePlatformInvoiceConfigurationResources,
  type InvoiceConfigurationTenantState,
} from "./usePlatformInvoiceConfigurationResources";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getInvoiceProviders.mockResolvedValue([]);
  api.getInvoiceSetting.mockResolvedValue(setting());
  api.saveInvoiceProvider.mockResolvedValue(
    provider("provider-created", "test"),
  );
  api.switchInvoiceMode.mockResolvedValue(
    setting({
      active_mode: "production",
      provider_id: "provider-production",
      version: 8,
    }),
  );
});

describe("usePlatformInvoiceConfigurationResources", () => {
  it("does not read before authorization and loads once when authorization is retained", async () => {
    const { rerender } = renderHook(
      ({ authorized }: { authorized: boolean }) =>
        usePlatformInvoiceConfigurationResources({
          authorized,
          apiAvailable: true,
          tenant: verifiedTenant,
          onNotice,
        }),
      { initialProps: { authorized: false } },
    );

    expect(api.getInvoiceProviders).not.toHaveBeenCalled();
    expect(api.getInvoiceSetting).not.toHaveBeenCalled();

    rerender({ authorized: true });
    await waitFor(() => {
      expect(api.getInvoiceProviders).toHaveBeenCalledOnce();
      expect(api.getInvoiceSetting).toHaveBeenCalledOnce();
    });

    rerender({ authorized: true });
    expect(api.getInvoiceProviders).toHaveBeenCalledOnce();
    expect(api.getInvoiceSetting).toHaveBeenCalledOnce();
  });

  it("keeps a fresh provider sibling when setting fails and retries only the failure", async () => {
    api.getInvoiceProviders.mockResolvedValue([
      provider("provider-test", "test"),
    ]);
    api.getInvoiceSetting
      .mockRejectedValueOnce(new Error("模式服务暂时不可用"))
      .mockResolvedValueOnce(setting());
    const { result } = renderResources({ status: "unverified" });

    await waitFor(() => {
      expect(result.current.providers.status).toBe("ready");
      expect(result.current.setting.status).toBe("error");
    });
    expect(result.current.providers).toMatchObject({
      status: "ready",
      data: [{ provider_id: "provider-test" }],
    });

    await act(async () => {
      await result.current.retryFailed();
    });

    expect(api.getInvoiceProviders).toHaveBeenCalledOnce();
    expect(api.getInvoiceSetting).toHaveBeenCalledTimes(2);
    expect(result.current.setting.status).toBe("ready");
    expect(api.saveInvoiceProvider).not.toHaveBeenCalled();
    expect(api.switchInvoiceMode).not.toHaveBeenCalled();
  });

  it("preserves the prior setting as stale when focused revalidation fails", async () => {
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => expect(result.current.setting.status).toBe("ready"));

    api.getInvoiceSetting.mockRejectedValueOnce(new Error("模式重新读取失败"));
    await act(async () => {
      await result.current.refreshSetting();
    });

    expect(result.current.setting).toMatchObject({
      status: "error",
      message: "模式重新读取失败",
      previous: { active_mode: "test", version: 7 },
    });
    expect(result.current.providers.status).toBe("ready");
  });

  it("rechecks tenant and provider freshness without replaying a committed provider POST", async () => {
    const { result, rerender } = renderResources({ status: "unverified" });
    await waitFor(() => expect(result.current.providers.status).toBe("ready"));

    await act(async () => {
      expect(await result.current.commitProvider(providerDraft)).toBe(false);
    });
    expect(api.saveInvoiceProvider).not.toHaveBeenCalled();

    rerender({ tenant: verifiedTenant });
    await act(async () => {
      expect(await result.current.commitProvider(providerDraft)).toBe(true);
    });
    expect(api.saveInvoiceProvider).toHaveBeenCalledOnce();
    expect(api.saveInvoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant", name: "发票服务" }),
    );
    expect(onNotice).toHaveBeenLastCalledWith(
      "发票 provider 已保存；切换生产模式前请完成真实税务服务校验",
    );

    api.getInvoiceProviders.mockRejectedValueOnce(new Error("重新读取失败"));
    await act(async () => {
      await result.current.refreshProviders();
    });
    expect(result.current.providers).toMatchObject({
      status: "error",
      previous: [],
    });
    expect(onNotice).toHaveBeenLastCalledWith(
      "发票 provider 已保存；切换生产模式前请完成真实税务服务校验",
    );

    api.getInvoiceProviders.mockResolvedValueOnce([
      provider("provider-created", "test"),
    ]);
    await act(async () => {
      await result.current.retryFailed();
    });
    expect(api.saveInvoiceProvider).toHaveBeenCalledOnce();
    expect(result.current.providers.status).toBe("ready");
  });

  it("switches with the current version and fresh target provider, then trusts the response", async () => {
    api.getInvoiceProviders.mockResolvedValue([
      provider("provider-production", "production"),
    ]);
    const authoritative = setting({
      active_mode: "production",
      provider_id: "provider-production",
      version: 8,
    });
    api.switchInvoiceMode.mockResolvedValue(authoritative);
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => {
      expect(result.current.providers.status).toBe("ready");
      expect(result.current.setting.status).toBe("ready");
    });

    await act(async () => {
      expect(
        await result.current.commitMode({
          mode: "production",
          providerId: "provider-production",
        }),
      ).toBe(true);
    });

    expect(api.switchInvoiceMode).toHaveBeenCalledOnce();
    expect(api.switchInvoiceMode).toHaveBeenCalledWith({
      tenantId: "tenant",
      mode: "production",
      providerId: "provider-production",
      expectedVersion: 7,
      reason: "web-admin switch invoice mode to production",
    });
    expect(result.current.setting).toEqual({
      status: "ready",
      data: authoritative,
    });
    expect(api.getInvoiceSetting).toHaveBeenCalledOnce();
  });

  it("blocks disappeared, disabled, or mode-mismatched target providers", async () => {
    api.getInvoiceProviders.mockResolvedValue([
      { ...provider("disabled", "production"), enabled: false },
      provider("wrong-mode", "test"),
    ]);
    const { result } = renderResources(verifiedTenant);
    await waitFor(() => expect(result.current.providers.status).toBe("ready"));

    for (const providerId of ["missing", "disabled", "wrong-mode"]) {
      await act(async () => {
        expect(
          await result.current.commitMode({
            mode: "production",
            providerId,
          }),
        ).toBe(false);
      });
    }

    expect(api.switchInvoiceMode).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith(
      "所选发票 provider 已失效、停用或不属于目标模式",
    );
  });
});

function renderResources(tenant: InvoiceConfigurationTenantState) {
  return renderHook(
    ({ tenant: nextTenant }: { tenant: InvoiceConfigurationTenantState }) =>
      usePlatformInvoiceConfigurationResources({
        authorized: true,
        apiAvailable: true,
        tenant: nextTenant,
        onNotice,
      }),
    { initialProps: { tenant } },
  );
}

const verifiedTenant: InvoiceConfigurationTenantState = {
  status: "verified",
  tenantId: "tenant",
};

const providerDraft = {
  name: "发票服务",
  providerKey: "local_test",
  mode: "test" as const,
  settings: {},
};

function provider(
  id: string,
  mode: "test" | "production",
): InvoiceProviderRecord {
  return {
    provider_id: id,
    tenant_id: "tenant",
    name: id,
    provider_key: "local_test",
    mode,
    settings: {},
    credential_configured: true,
    enabled: true,
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

function setting(overrides: Partial<InvoiceSetting> = {}): InvoiceSetting {
  return {
    tenant_id: "tenant",
    active_mode: "test",
    provider_id: "provider-test",
    updated_by: "admin",
    version: 7,
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}
