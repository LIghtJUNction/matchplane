import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PlatformAiStatus, PlatformSetupStatus } from "../api";
import { MallInitializationPanel } from "./MallInitializationPanel";

const callbacks = {
  onInitializeRoot: vi.fn(),
  onOpenStores: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenAi: vi.fn(),
};

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

describe("MallInitializationPanel", () => {
  it("names the first actionable setup step without inventing progress", () => {
    render(
      <MallInitializationPanel
        setup={setupStatus()}
        rootRole="rootSuperAdmin"
        aiStatus={null}
        saving={false}
        {...callbacks}
      />,
    );

    expect(screen.getByLabelText("下一步：创建商城组织")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: "创建" })
        .filter((button) => !button.hasAttribute("disabled")),
    ).toHaveLength(1);
  });

  it("moves the next action to the first store after core setup is ready", () => {
    render(
      <MallInitializationPanel
        setup={setupStatus({
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
        })}
        aiStatus={readyAiStatus}
        saving={false}
        {...callbacks}
      />,
    );

    expect(screen.getByLabelText("下一步：接入第一家店铺")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接入" })).toBeEnabled();
  });
});
