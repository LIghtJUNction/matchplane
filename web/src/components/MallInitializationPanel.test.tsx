import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlatformAiStatus,
  PlatformDomainRecord,
  PlatformSetupStatus,
} from "../api";
import { MallInitializationPanel } from "./MallInitializationPanel";

const callbacks = {
  onInitializeRoot: vi.fn(),
  onOpenStores: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenAi: vi.fn(),
};

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockClear());
});

describe("MallInitializationPanel", () => {
  it("shows initialization actions only after verified setup absence", () => {
    renderPanel({
      setupResource: { status: "ready", data: setupStatus() },
      domainsResource: { status: "ready", data: [] },
      aiResource: { status: "ready", data: readyAiStatus },
    });

    expect(screen.getByLabelText("下一步：创建商城组织")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: "创建" })
        .filter((button) => !button.hasAttribute("disabled")),
    ).toHaveLength(1);
  });

  it("moves the next action to the first store after verified core setup", () => {
    renderPanel({
      setupResource: {
        status: "ready",
        data: readyCoreSetup(),
      },
      domainsResource: { status: "ready", data: [domain] },
      aiResource: { status: "ready", data: readyAiStatus },
    });

    expect(screen.getByLabelText("下一步：接入第一家店铺")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接入" })).toBeEnabled();
  });

  it("does not turn a setup failure into uninitialized actions or duplicate the error notice", () => {
    renderPanel({
      setupResource: {
        status: "error",
        message: "初始化状态服务不可用",
      },
      domainsResource: {
        status: "error",
        message: "数据范围服务不可用",
      },
      aiResource: { status: "ready", data: readyAiStatus },
    });

    expect(
      screen.getByLabelText("下一步：确认商城初始化状态"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("状态暂时不可用")).toHaveLength(2);
    expect(screen.queryByText("请先完成服务器初始化")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待验证" })).toBeDisabled();
  });

  it("keeps verified setup actions while AI status is unavailable", () => {
    renderPanel({
      setupResource: { status: "ready", data: readyCoreSetup() },
      domainsResource: { status: "ready", data: [domain] },
      aiResource: { status: "error", message: "AI 状态服务不可用" },
    });

    expect(
      screen.getByLabelText("下一步：确认 AI 导购状态"),
    ).toBeInTheDocument();
    expect(screen.getByText("状态暂时不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待验证" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "管理" })[0]).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "配置 AI" }),
    ).not.toBeInTheDocument();
  });

  it("renders stale setup as read-only context and keeps mutations disabled", () => {
    renderPanel({
      setupResource: {
        status: "error",
        message: "初始化状态重新验证失败",
        previous: setupStatus(),
      },
      domainsResource: {
        status: "error",
        message: "数据范围重新验证失败",
        previous: [],
      },
      aiResource: { status: "ready", data: readyAiStatus },
    });

    expect(screen.getAllByText(/上次状态：未完成；当前待验证/)).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "创建" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待验证" })).toBeDisabled();
  });

  it("does not report scope readiness from setup when domain verification fails", () => {
    renderPanel({
      setupResource: { status: "ready", data: readyCoreSetup() },
      domainsResource: {
        status: "error",
        message: "数据范围暂时不可用",
        previous: [domain],
      },
      aiResource: { status: "ready", data: readyAiStatus },
    });

    expect(
      screen.getByLabelText("下一步：确认商城数据状态"),
    ).toBeInTheDocument();
    expect(screen.getByText("商城数据").closest("li")).not.toHaveClass(
      "is-complete",
    );
    expect(
      screen.getByText("上次状态：已就绪；当前待验证"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待验证" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "接入" })).toBeDisabled();
  });
});

function renderPanel({
  setupResource,
  domainsResource,
  aiResource,
}: Pick<
  ComponentProps<typeof MallInitializationPanel>,
  "setupResource" | "domainsResource" | "aiResource"
>) {
  return render(
    <MallInitializationPanel
      setupResource={setupResource}
      domainsResource={domainsResource}
      aiResource={aiResource}
      rootRole="rootSuperAdmin"
      saving={false}
      {...callbacks}
    />,
  );
}

function readyCoreSetup(): PlatformSetupStatus {
  return setupStatus({
    root: {
      ...setupStatus().root,
      organization: {
        id: "root",
        slug: "root",
        name: "Root",
        tenantId: "tenant",
        domainId: null,
      },
    },
    domains: [{ id: "domain", slug: "market", name: "Market" }],
  });
}

function setupStatus(
  overrides: Partial<PlatformSetupStatus> = {},
): PlatformSetupStatus {
  return {
    status: "ok",
    root: {
      tenantConfigured: true,
      tenantExists: true,
      tenantId: "tenant",
      tenant: { slug: "matchplane", name: "MatchPlane" },
      organization: null,
      rootAdminConfigured: true,
      identityAccounts: 1,
      rootAdminAccounts: 1,
    },
    domains: [],
    registrations: {},
    routing: { activeChildren: 0, ready: false },
    hostedAgent: { configured: false, status: "fallback" },
    builder: { configured: false, status: "unconfigured" },
    firstRun: { needsRootAccount: false, readyForAdmin: true },
    ...overrides,
  };
}

const domain: PlatformDomainRecord = {
  id: "domain",
  slug: "market",
  name: "Market",
  status: "active",
  version: 1,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};

const readyAiStatus: PlatformAiStatus = {
  router: {
    configured: true,
    aiReady: true,
    protocol: "openai-compatible",
    model: "model",
    endpointOrigin: "https://router.example.com",
    source: "managed",
    managedOverridesEnvironment: false,
    conflicts: { endpoint: false, model: false, protocol: false },
    credentialConfigured: true,
    policyCode: "ready",
    policyIssues: [],
    originAllowlistApplied: true,
    toolMode: "auto",
    maxInputCharacters: 24_000,
    maxOutputTokens: 320,
    totalTimeoutMs: 20_000,
    maxSteps: 4,
    maxFanout: 4,
    requestsPerHour: 60,
    globalRequestsPerHour: 600,
  },
  auth: {
    primary: [],
    fallback: [],
    password: true,
    emailOtp: false,
    phoneOtp: false,
    magicLink: false,
    passkey: true,
  },
};
