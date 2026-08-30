import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentGatewayRecord } from "../api";
import type { PlatformPaymentRoutingController } from "../hooks/usePlatformPaymentRoutingResources";
import { PlatformPaymentRoutingPanel } from "./PlatformPaymentRoutingPanel";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlatformPaymentRoutingPanel", () => {
  it("shows only verified empty resources as empty and retries failed siblings", async () => {
    const user = userEvent.setup();
    const retryFailed = vi.fn(async () => undefined);
    const { rerender } = render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: {
            status: "error",
            message: "网关服务不可用",
            previous: [],
          },
          routes: { status: "ready", data: [] },
          retryFailed,
        })}
        onNotice={onNotice}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "支付网关：网关服务不可用",
    );
    expect(screen.getByText(/支付网关当前待验证/)).toBeInTheDocument();
    expect(screen.queryByText("暂不使用线上支付")).not.toBeInTheDocument();
    expect(screen.getByText(/线上支付为可选/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试失败项" }));
    expect(retryFailed).toHaveBeenCalledOnce();

    rerender(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [] },
          routes: { status: "ready", data: [] },
        })}
        onNotice={onNotice}
      />,
    );
    expect(screen.getByText("暂不使用线上支付")).toBeInTheDocument();
  });

  it("clears a route selection when the fresh gateway disappears or is disabled", async () => {
    const user = userEvent.setup();
    const commitRoute = vi.fn(async () => true);
    const { rerender } = render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [gateway("gateway-a")] },
          routes: { status: "ready", data: [] },
          commitRoute,
        })}
        onNotice={onNotice}
      />,
    );
    await user.click(screen.getByRole("button", { name: "配置路由" }));
    expect(
      screen.getByRole("form", { name: "支付路由配置" }),
    ).toBeInTheDocument();
    const select = screen.getByLabelText("支付网关");
    expect(select).toBeRequired();
    expect(screen.getByLabelText("方式编码")).toBeRequired();
    expect(screen.getByLabelText("优先级")).toBeRequired();
    await user.selectOptions(select, "gateway-a");
    expect(select).toHaveValue("gateway-a");

    rerender(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: {
            status: "ready",
            data: [{ ...gateway("gateway-a"), enabled: false }],
          },
          routes: { status: "ready", data: [] },
          commitRoute,
        })}
        onNotice={onNotice}
      />,
    );

    await waitFor(() => expect(select).toHaveValue(""));
    expect(screen.getByRole("button", { name: "保存路由" })).toBeDisabled();
    expect(commitRoute).not.toHaveBeenCalled();
  });

  it("closes a committed gateway editor before refreshing only gateways", async () => {
    const user = userEvent.setup();
    const refresh = deferred<void>();
    const commitGateway = vi.fn(async () => true);
    const refreshGateways = vi.fn(() => refresh.promise);
    const refreshRoutes = vi.fn(async () => undefined);
    render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [] },
          routes: { status: "ready", data: [] },
          commitGateway,
          refreshGateways,
          refreshRoutes,
        })}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "配置网关" }));
    expect(
      screen.getByRole("form", { name: "支付网关配置" }),
    ).toBeInTheDocument();
    const name = screen.getByLabelText("名称");
    const mode = screen.getByLabelText("模式");
    const secret = screen.getByLabelText("secret reference");
    expect(name).toBeRequired();
    expect(secret).not.toBeRequired();
    await user.selectOptions(mode, "production");
    expect(secret).toBeRequired();
    await user.selectOptions(mode, "test");
    await user.type(name, "主网关");
    await user.click(screen.getByRole("button", { name: "保存网关" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("支付网关配置")).not.toBeInTheDocument(),
    );
    expect(commitGateway).toHaveBeenCalledOnce();
    expect(refreshGateways).toHaveBeenCalledOnce();
    expect(refreshRoutes).not.toHaveBeenCalled();

    await act(async () => refresh.resolve());
  });

  it("rejects trailing and exponent priority syntax instead of partially parsing it", async () => {
    const user = userEvent.setup();
    const commitRoute = vi.fn(async () => false);
    render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [gateway("gateway-a")] },
          routes: { status: "ready", data: [] },
          commitRoute,
        })}
        onNotice={onNotice}
      />,
    );
    await user.click(screen.getByRole("button", { name: "配置路由" }));
    await user.selectOptions(screen.getByLabelText("支付网关"), "gateway-a");
    await user.type(screen.getByLabelText("方式编码"), "card");
    await user.type(screen.getByLabelText("币种"), "CNY");
    const form = screen.getByRole("form", { name: "支付路由配置" });
    const priority = screen.getByLabelText("优先级");

    fireEvent.change(priority, { target: { value: "100abc" } });
    fireEvent.submit(form);
    expect(commitRoute).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith("优先级必须是 0 到 10000 的整数");

    fireEvent.change(priority, { target: { value: "1e3" } });
    fireEvent.submit(form);
    expect(commitRoute).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith("优先级必须是 0 到 10000 的整数");
  });

  it("accepts a one-character method code and rejects overlong or invalid codes", async () => {
    const user = userEvent.setup();
    const commitRoute = vi.fn(async () => false);
    render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [gateway("gateway-a")] },
          routes: { status: "ready", data: [] },
          commitRoute,
        })}
        onNotice={onNotice}
      />,
    );
    await user.click(screen.getByRole("button", { name: "配置路由" }));
    await user.selectOptions(screen.getByLabelText("支付网关"), "gateway-a");
    await user.type(screen.getByLabelText("币种"), "CNY");
    const form = screen.getByRole("form", { name: "支付路由配置" });
    const method = screen.getByLabelText("方式编码");

    fireEvent.change(method, { target: { value: "x" } });
    fireEvent.submit(form);
    await waitFor(() => expect(commitRoute).toHaveBeenCalledOnce());

    commitRoute.mockClear();
    fireEvent.change(method, { target: { value: "a".repeat(65) } });
    fireEvent.submit(form);
    expect(commitRoute).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith(
      "支付方式编码只能包含字母、数字、点、下划线、冒号或短横线",
    );

    fireEvent.change(method, { target: { value: "bad code" } });
    fireEvent.submit(form);
    expect(commitRoute).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith(
      "支付方式编码只能包含字母、数字、点、下划线、冒号或短横线",
    );
  });

  it("keeps gateway input open when the POST is not committed", async () => {
    const user = userEvent.setup();
    const commitGateway = vi.fn(async () => false);
    const refreshGateways = vi.fn(async () => undefined);
    render(
      <PlatformPaymentRoutingPanel
        controller={makeController({
          gateways: { status: "ready", data: [] },
          routes: { status: "ready", data: [] },
          commitGateway,
          refreshGateways,
        })}
        onNotice={onNotice}
      />,
    );

    await user.click(screen.getByRole("button", { name: "配置网关" }));
    const name = screen.getByLabelText("名称");
    await user.type(name, "保留输入");
    await user.click(screen.getByRole("button", { name: "保存网关" }));

    expect(screen.getByLabelText("支付网关配置")).toBeInTheDocument();
    expect(name).toHaveValue("保留输入");
    expect(refreshGateways).not.toHaveBeenCalled();
  });
});

function makeController(
  overrides: Partial<PlatformPaymentRoutingController> = {},
): PlatformPaymentRoutingController {
  return {
    gateways: { status: "ready", data: [] },
    routes: { status: "ready", data: [] },
    mutation: null,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(async () => undefined),
    refreshGateways: vi.fn(async () => undefined),
    refreshRoutes: vi.fn(async () => undefined),
    commitGateway: vi.fn(async () => true),
    commitRoute: vi.fn(async () => true),
    ...overrides,
  };
}

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
