import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateFederationBinding: vi.fn(),
  createFederationInvite: vi.fn(),
  getFederationBindings: vi.fn(),
  probeFederationBinding: vi.fn(),
  revokeFederationBinding: vi.fn(),
}));

vi.mock("../api", () => api);

import type { FederationBindingRecord, PlatformDomainRecord } from "../api";
import { RemoteStoreOnboarding } from "./RemoteStoreOnboarding";

const enrollment = {
  inviteId: "invite",
  domainId: "domain-a",
  parentOrganizationId: "root",
  expiresAt: "2026-08-22T00:00:00.000Z",
  enrollmentToken: "mpf_token",
  enrollmentUrl: "https://mall.test/api/platform/federation/enroll",
};

beforeEach(() => {
  api.activateFederationBinding.mockReset();
  api.createFederationInvite.mockReset().mockResolvedValue(enrollment);
  api.getFederationBindings.mockReset().mockResolvedValue([]);
  api.probeFederationBinding.mockReset();
  api.revokeFederationBinding.mockReset();
});

describe("RemoteStoreOnboarding", () => {
  it("shows truthful binding loading and error states with a working retry", async () => {
    const initialRequest = deferred<FederationBindingRecord[]>();
    api.getFederationBindings.mockReset().mockReturnValueOnce(initialRequest.promise);
    render(
      <RemoteStoreOnboarding
        domainsResource={{ status: "ready", data: [domain("domain-a")] }}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "正在读取远程店铺",
    );
    expect(screen.queryByText("还没有接入远程店铺。")).not.toBeInTheDocument();

    await act(async () => initialRequest.reject(new Error("连接超时")));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接超时");
    expect(screen.queryByText("还没有接入远程店铺。")).not.toBeInTheDocument();

    api.getFederationBindings.mockResolvedValueOnce([binding]);
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("华东家电店")).toBeInTheDocument();
  });

  it("keeps the newest binding response when requests finish out of order", async () => {
    const firstRequest = deferred<FederationBindingRecord[]>();
    const secondRequest = deferred<FederationBindingRecord[]>();
    api.getFederationBindings
      .mockReset()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const props = {
      domainsResource: {
        status: "ready" as const,
        data: [domain("domain-a")],
      },
    };
    const { rerender } = render(
      <RemoteStoreOnboarding {...props} onNotice={vi.fn()} />,
    );
    rerender(<RemoteStoreOnboarding {...props} onNotice={vi.fn()} />);

    await act(async () => secondRequest.resolve([binding]));
    expect(await screen.findByText("华东家电店")).toBeInTheDocument();
    await act(async () => firstRequest.resolve([]));
    expect(screen.getByText("华东家电店")).toBeInTheDocument();
    expect(screen.queryByText("还没有接入远程店铺。")).not.toBeInTheDocument();
  });

  it("auto-selects the only fresh active domain for controlled enrollment", async () => {
    const user = userEvent.setup();
    render(
      <RemoteStoreOnboarding
        domainsResource={{ status: "ready", data: [domain("domain-a")] }}
        onNotice={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("商城数据范围")).toHaveValue("domain-a");
    await user.click(
      await screen.findByRole("button", { name: "生成一次性连接链接" }),
    );

    expect(api.createFederationInvite).toHaveBeenCalledWith({
      domainId: "domain-a",
      expiresInHours: 168,
    });
    expect(await screen.findByText("一次性连接信息")).toBeInTheDocument();
    expect(screen.getByText("mpf_token")).toBeInTheDocument();
  });

  it("keeps binding results visible while stale domains pause new enrollment", async () => {
    api.getFederationBindings.mockResolvedValueOnce([binding]);
    render(
      <RemoteStoreOnboarding
        domainsResource={{
          status: "error",
          message: "数据范围暂时不可用",
          previous: [domain("domain-a")],
        }}
        onNotice={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/保留的 1 条旧记录不能用于接入/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/商城数据范围已确认为空/),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("华东家电店")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "生成一次性连接链接" }),
    ).not.toBeInTheDocument();
  });

  it("shows verified-empty only after a fresh empty domain result", () => {
    render(
      <RemoteStoreOnboarding
        domainsResource={{ status: "ready", data: [] }}
        onNotice={vi.fn()}
      />,
    );

    expect(
      screen.getByText("商城数据范围已确认为空，暂时不能接入远程店铺。"),
    ).toBeInTheDocument();
  });

  it("clears an invalid refreshed selection instead of silently remapping it", async () => {
    const user = userEvent.setup();
    const props = { onNotice: vi.fn() };
    const { rerender } = render(
      <RemoteStoreOnboarding
        domainsResource={{
          status: "ready",
          data: [domain("domain-a"), domain("domain-b")],
        }}
        {...props}
      />,
    );
    const select = screen.getByLabelText("商城数据范围");
    expect(select).toHaveValue("");
    await user.selectOptions(select, "domain-a");
    expect(select).toHaveValue("domain-a");

    rerender(
      <RemoteStoreOnboarding
        domainsResource={{ status: "ready", data: [domain("domain-b")] }}
        {...props}
      />,
    );

    expect(select).toHaveValue("");
    expect(select).not.toHaveValue("domain-b");
    expect(
      screen.getByRole("button", { name: "生成一次性连接链接" }),
    ).toBeDisabled();
    expect(api.createFederationInvite).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function domain(id: string): PlatformDomainRecord {
  return {
    id,
    slug: id,
    name: id === "domain-a" ? "商城商品" : "第二商城",
    status: "active",
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

const binding: FederationBindingRecord = {
  id: "binding-1",
  inviteId: "invite-1",
  organizationId: "organization-1",
  registrationId: "registration-1",
  nodeId: "node-1",
  slug: "east-appliances",
  displayName: "华东家电店",
  endpoint: "https://east.example.com",
  mcpServerKey: "remote-store",
  tokenEnv: "MATCHPLANE_EAST_APPLIANCES_MCP_TOKEN",
  status: "active",
  registrationState: "active",
  lastHealthAt: "2026-08-26T00:00:00.000Z",
  lastError: null,
};
