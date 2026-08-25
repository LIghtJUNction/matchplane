import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InvoiceProviderRecord, InvoiceSetting } from "../api";
import type { PlatformInvoiceConfigurationController } from "../hooks/usePlatformInvoiceConfigurationResources";
import { PlatformInvoiceConfigurationPanel } from "./PlatformInvoiceConfigurationPanel";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlatformInvoiceConfigurationPanel", () => {
  it("shows only verified provider emptiness and never leaves a failed setting reading", async () => {
    const user = userEvent.setup();
    const retryFailed = vi.fn(async () => undefined);
    const { rerender } = render(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          providers: { status: "ready", data: [] },
          setting: { status: "error", message: "模式服务不可用" },
          retryFailed,
        })}
        onNotice={onNotice}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "发票模式：模式服务不可用",
    );
    expect(screen.getByText("尚未配置发票 provider。")).toBeInTheDocument();
    expect(screen.getByText("状态暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("读取中…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试失败项" }));
    expect(retryFailed).toHaveBeenCalledOnce();

    rerender(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          providers: {
            status: "error",
            message: "provider 服务不可用",
            previous: [],
          },
          setting: { status: "ready", data: setting() },
        })}
        onNotice={onNotice}
      />,
    );
    expect(
      screen.queryByText("尚未配置发票 provider。"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/发票 provider 当前待验证/)).toBeInTheDocument();
  });

  it("uses a required semantic provider form and refreshes only after commit", async () => {
    const user = userEvent.setup();
    const refresh = deferred<void>();
    const commitProvider = vi.fn(async () => true);
    const refreshProviders = vi.fn(() => refresh.promise);
    const refreshSetting = vi.fn(async () => undefined);
    render(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          commitProvider,
          refreshProviders,
          refreshSetting,
        })}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "配置 provider" }));
    expect(
      screen.getByRole("form", { name: "发票 provider 配置" }),
    ).toBeInTheDocument();
    const name = screen.getByLabelText("名称");
    const protocol = screen.getByLabelText("provider");
    const mode = screen.getByLabelText("模式");
    const secret = screen.getByLabelText("secret reference");
    expect(name).toBeRequired();
    expect(protocol).toBeRequired();
    expect(secret).not.toBeRequired();
    await user.selectOptions(mode, "production");
    expect(secret).toBeRequired();
    await user.selectOptions(mode, "test");
    await user.type(name, "发票服务");
    await user.selectOptions(protocol, "local_test");
    await user.click(screen.getByRole("button", { name: "保存 provider" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "发票 provider 配置" }),
      ).not.toBeInTheDocument(),
    );
    expect(commitProvider).toHaveBeenCalledOnce();
    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(refreshSetting).not.toHaveBeenCalled();
    await act(async () => refresh.resolve());
  });

  it("clears a disappeared or disabled target provider without remapping", async () => {
    const user = userEvent.setup();
    const commitMode = vi.fn(async () => true);
    const { rerender } = render(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          providers: {
            status: "ready",
            data: [provider("provider-a", "production")],
          },
          setting: { status: "ready", data: setting() },
          commitMode,
        })}
        onNotice={onNotice}
      />,
    );
    const select = screen.getByLabelText("生产 provider");
    await user.selectOptions(select, "provider-a");
    expect(select).toHaveValue("provider-a");

    rerender(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          providers: {
            status: "ready",
            data: [{ ...provider("provider-a", "production"), enabled: false }],
          },
          setting: { status: "ready", data: setting() },
          commitMode,
        })}
        onNotice={onNotice}
      />,
    );

    await waitFor(() => expect(select).toHaveValue(""));
    expect(screen.getByRole("button", { name: "切换模式" })).toBeDisabled();
    expect(commitMode).not.toHaveBeenCalled();
  });

  it("confirms a switch with the explicit fresh target provider", async () => {
    const user = userEvent.setup();
    const commitMode = vi.fn(async () => true);
    const refreshProviders = vi.fn(async () => undefined);
    const refreshSetting = vi.fn(async () => undefined);
    render(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({
          providers: {
            status: "ready",
            data: [provider("provider-production", "production")],
          },
          setting: { status: "ready", data: setting() },
          commitMode,
          refreshProviders,
          refreshSetting,
        })}
        onNotice={onNotice}
      />,
    );

    const form = screen.getByRole("form", { name: "切换发票运行模式" });
    const select = screen.getByLabelText("生产 provider");
    expect(select).toBeRequired();
    await user.selectOptions(select, "provider-production");
    await user.click(screen.getByRole("button", { name: "切换模式" }));
    expect(form).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认切换" }));

    await waitFor(() => expect(commitMode).toHaveBeenCalledOnce());
    expect(commitMode).toHaveBeenCalledWith({
      mode: "production",
      providerId: "provider-production",
    });
    expect(refreshProviders).not.toHaveBeenCalled();
    expect(refreshSetting).not.toHaveBeenCalled();
  });

  it("keeps provider input open when the POST is not committed", async () => {
    const user = userEvent.setup();
    const commitProvider = vi.fn(async () => false);
    const refreshProviders = vi.fn(async () => undefined);
    render(
      <PlatformInvoiceConfigurationPanel
        controller={makeController({ commitProvider, refreshProviders })}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "配置 provider" }));
    const name = screen.getByLabelText("名称");
    await user.type(name, "保留输入");
    await user.selectOptions(screen.getByLabelText("provider"), "local_test");
    await user.click(screen.getByRole("button", { name: "保存 provider" }));

    expect(
      screen.getByRole("form", { name: "发票 provider 配置" }),
    ).toBeInTheDocument();
    expect(name).toHaveValue("保留输入");
    expect(refreshProviders).not.toHaveBeenCalled();
  });
});

function makeController(
  overrides: Partial<PlatformInvoiceConfigurationController> = {},
): PlatformInvoiceConfigurationController {
  return {
    providers: { status: "ready", data: [] },
    setting: { status: "ready", data: setting() },
    mutation: null,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    refreshSetting: vi.fn(async () => undefined),
    commitProvider: vi.fn(async () => true),
    commitMode: vi.fn(async () => true),
    ...overrides,
  };
}

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
    provider_id: null,
    updated_by: "admin",
    version: 7,
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
