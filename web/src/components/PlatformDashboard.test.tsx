import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isLiveMarketplaceEnabled: vi.fn(() => false),
  registerSubplatform: vi.fn(),
}));
const bootstrapMock = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));
vi.mock("../hooks/usePlatformBootstrapResources", () => ({
  usePlatformBootstrapResources: () => bootstrapMock.current,
  freshBootstrapResourceData: (resource: { status: string; data?: unknown }) =>
    resource.status === "ready" ? resource.data : null,
}));
vi.mock("./LoginMethodsPanel", () => ({ LoginMethodsPanel: () => null }));
vi.mock("./Overlays", () => ({ ModeDialog: () => null }));
vi.mock("./PlatformAccessPanel", () => ({ PlatformAccessPanel: () => null }));
vi.mock("./PlatformBootstrapNotice", () => ({
  PlatformBootstrapNotice: () => null,
}));
vi.mock("./PlatformFinanceRecordsPanel", () => ({
  PlatformFinanceRecordsPanel: () => null,
}));
vi.mock("./PlatformSiteSettingsPanel", () => ({
  PlatformSiteSettingsPanel: () => null,
}));
vi.mock("./RootEmailConfigPanel", () => ({
  RootEmailConfigPanel: () => null,
}));
vi.mock("./PlatformAiConfigPanel", () => ({
  PlatformAiConfigPanel: () => null,
}));
vi.mock("./NationalIdentityConfigPanel", () => ({
  NationalIdentityConfigPanel: () => null,
}));
vi.mock("./WeChatLoginConfigPanel", () => ({
  WeChatLoginConfigPanel: () => null,
}));
vi.mock("./PhoneLoginConfigPanel", () => ({
  PhoneLoginConfigPanel: () => null,
}));
vi.mock("./MallCatalogModeration", () => ({
  MallCatalogModeration: () => null,
}));
vi.mock("./MallBrandPanel", () => ({ MallBrandPanel: () => null }));
vi.mock("./MallInitializationPanel", () => ({
  MallInitializationPanel: () => null,
}));
vi.mock("./StoreCommercialTermsPanel", () => ({
  StoreCommercialTermsPanel: () => null,
}));
vi.mock("./RemoteStoreOnboarding", () => ({
  RemoteStoreOnboarding: () => null,
}));
vi.mock("./Primitives", () => ({ SectionHeading: () => null }));

import type {
  PlatformAiStatus,
  PlatformDomainRecord,
  PlatformSetupStatus,
} from "../api";
import { PlatformDashboard } from "./PlatformDashboard";

const dashboardProps = {
  paymentMode: "test" as const,
  rootRole: "rootSuperAdmin",
  onRequestModeChange: vi.fn(),
  onNotice: vi.fn(),
};

beforeEach(() => {
  api.registerSubplatform.mockReset();
  dashboardProps.onNotice.mockReset();
});

describe("PlatformDashboard local store onboarding", () => {
  it("does not expose local onboarding when independent domain verification failed", async () => {
    bootstrapMock.current = resources({
      status: "error",
      message: "数据范围暂时不可用",
      previous: [domain("domain-a")],
    });
    const user = userEvent.setup();
    render(<PlatformDashboard {...dashboardProps} />);

    await user.click(screen.getByRole("tab", { name: "店铺与商品" }));

    const action = screen.getByRole("button", { name: "接入本地店铺" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("title", "商城数据范围尚未验证");
    expect(screen.queryByLabelText("接入本地店铺")).not.toBeInTheDocument();
  });

  it("invalidates stale selection and only auto-selects a recovered single fresh domain", async () => {
    const user = userEvent.setup();
    bootstrapMock.current = resources({
      status: "ready",
      data: [domain("domain-a"), domain("domain-b")],
    });
    const { rerender } = render(<PlatformDashboard {...dashboardProps} />);
    await user.click(screen.getByRole("tab", { name: "店铺与商品" }));
    await user.click(screen.getByRole("button", { name: "接入本地店铺" }));

    const select = screen.getByLabelText("商城数据范围");
    expect(select).toHaveValue("");
    await user.selectOptions(select, "domain-a");
    expect(select).toHaveValue("domain-a");

    bootstrapMock.current = resources({
      status: "error",
      message: "数据范围重新验证失败",
      previous: [domain("domain-a"), domain("domain-b")],
    });
    rerender(<PlatformDashboard {...dashboardProps} />);

    await waitFor(() => expect(select).toHaveValue(""));
    expect(select).toBeDisabled();
    expect(screen.getByRole("button", { name: "构建本地店铺" })).toBeDisabled();
    expect(api.registerSubplatform).not.toHaveBeenCalled();

    bootstrapMock.current = resources({
      status: "ready",
      data: [domain("domain-b")],
    });
    rerender(<PlatformDashboard {...dashboardProps} />);

    await waitFor(() => expect(select).toHaveValue("domain-b"));
    expect(select).toBeEnabled();
  });
});

function resources(domains: BootstrapDomainsState) {
  return {
    setup: { status: "ready" as const, data: setup },
    domains,
    ai: { status: "ready" as const, data: aiStatus },
    rootInitializing: false,
    initializeRootOrganization: vi.fn(),
    retryFailed: vi.fn(),
    refreshSetupAndDomains: vi.fn(),
  };
}

type BootstrapDomainsState =
  | { status: "ready"; data: PlatformDomainRecord[] }
  | {
      status: "error";
      message: string;
      previous?: PlatformDomainRecord[];
    };

function domain(id: string): PlatformDomainRecord {
  return {
    id,
    slug: id,
    name: id,
    status: "active",
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

const setup: PlatformSetupStatus = {
  status: "ok",
  root: {
    tenantConfigured: true,
    tenantExists: true,
    tenantId: "tenant",
    tenant: { slug: "matchplane", name: "MatchPlane" },
    organization: {
      id: "root",
      slug: "root",
      name: "Root",
      tenantId: "tenant",
      domainId: null,
    },
    rootAdminConfigured: true,
    identityAccounts: 1,
    rootAdminAccounts: 1,
  },
  domains: [{ id: "embedded-domain", slug: "embedded", name: "Embedded" }],
  registrations: {},
  routing: { activeChildren: 0, ready: false },
  hostedAgent: { configured: false, status: "fallback" },
  builder: { configured: false, status: "unconfigured" },
  firstRun: { needsRootAccount: false, readyForAdmin: true },
};

const aiStatus: PlatformAiStatus = {
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
