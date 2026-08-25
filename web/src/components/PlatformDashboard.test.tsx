import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isLiveMarketplaceEnabled: vi.fn(() => false),
}));
const bootstrapMock = vi.hoisted(() => ({ current: undefined as unknown }));
const invoiceConfigurationMock = vi.hoisted(() => ({
  use: vi.fn(),
  controller: {
    providers: { status: "ready", data: [] },
    setting: {
      status: "ready",
      data: {
        tenant_id: "tenant",
        active_mode: "test",
        provider_id: null,
        updated_by: "admin",
        version: 1,
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    },
    mutation: null,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(),
    refreshProviders: vi.fn(),
    refreshSetting: vi.fn(),
    commitProvider: vi.fn(),
    commitMode: vi.fn(),
  },
}));
const localStoreMock = vi.hoisted(() => ({
  use: vi.fn(),
  controller: {
    organizations: { status: "ready", data: [] },
    mutation: null,
    operationPhase: "",
    registrationCancellable: false,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(),
    refreshOrganizations: vi.fn(),
    cancelRegistration: vi.fn(),
    commitRegistration: vi.fn(),
    commitActivation: vi.fn(),
    prepareUpdate: vi.fn(),
  },
}));
const paymentRoutingMock = vi.hoisted(() => ({
  use: vi.fn(),
  controller: {
    gateways: { status: "ready", data: [] },
    routes: { status: "ready", data: [] },
    mutation: null,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(),
    refreshGateways: vi.fn(),
    refreshRoutes: vi.fn(),
    commitGateway: vi.fn(),
    commitRoute: vi.fn(),
  },
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));
vi.mock("../hooks/usePlatformBootstrapResources", () => ({
  usePlatformBootstrapResources: () => bootstrapMock.current,
  freshBootstrapResourceData: (resource: { status: string; data?: unknown }) =>
    resource.status === "ready" ? resource.data : null,
}));
vi.mock("../hooks/usePlatformInvoiceConfigurationResources", () => ({
  usePlatformInvoiceConfigurationResources: (options: unknown) => {
    invoiceConfigurationMock.use(options);
    return invoiceConfigurationMock.controller;
  },
}));
vi.mock("../hooks/usePlatformLocalStoreResources", () => ({
  usePlatformLocalStoreResources: (options: unknown) => {
    localStoreMock.use(options);
    return localStoreMock.controller;
  },
}));
vi.mock("../hooks/usePlatformPaymentRoutingResources", () => ({
  usePlatformPaymentRoutingResources: (options: unknown) => {
    paymentRoutingMock.use(options);
    return paymentRoutingMock.controller;
  },
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
vi.mock("./PlatformInvoiceConfigurationPanel", () => ({
  PlatformInvoiceConfigurationPanel: () => (
    <div data-testid="invoice-configuration-panel" />
  ),
}));
vi.mock("./PlatformLocalStorePanel", () => ({
  PlatformLocalStorePanel: () => <div data-testid="local-store-panel" />,
}));
vi.mock("./PlatformPaymentRoutingPanel", () => ({
  PlatformPaymentRoutingPanel: () => (
    <div data-testid="payment-routing-panel" />
  ),
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
  dashboardProps.onNotice.mockReset();
  invoiceConfigurationMock.use.mockClear();
  localStoreMock.use.mockClear();
  paymentRoutingMock.use.mockClear();
});

describe("PlatformDashboard local store boundary", () => {
  it("passes role plus raw setup and domain authority to the extracted controller", () => {
    const initial = resources({ status: "ready", data: [domain("a")] });
    bootstrapMock.current = initial;
    const { rerender } = render(<PlatformDashboard {...dashboardProps} />);

    expect(screen.getByTestId("local-store-panel")).toBeInTheDocument();
    expect(localStoreMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorized: true,
        apiAvailable: false,
        rootRole: "rootSuperAdmin",
        setup: initial.setup,
        domains: initial.domains,
      }),
    );

    const stale = {
      ...resources({ status: "error", message: "数据范围不可用" }),
      setup: {
        status: "error",
        message: "初始化状态不可用",
        previous: setup,
      },
    };
    bootstrapMock.current = stale;
    rerender(<PlatformDashboard {...dashboardProps} />);

    expect(localStoreMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({ setup: stale.setup, domains: stale.domains }),
    );
  });
});

describe("PlatformDashboard invoice configuration boundary", () => {
  it("keeps invoice reads independent while passing only a fresh setup tenant for writes", () => {
    bootstrapMock.current = resources({ status: "ready", data: [domain("a")] });
    const { rerender } = render(<PlatformDashboard {...dashboardProps} />);

    expect(
      screen.getByTestId("invoice-configuration-panel"),
    ).toBeInTheDocument();
    expect(invoiceConfigurationMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorized: true,
        apiAvailable: false,
        tenant: { status: "verified", tenantId: "tenant" },
      }),
    );

    bootstrapMock.current = {
      ...resources({ status: "ready", data: [domain("a")] }),
      setup: {
        status: "error",
        message: "初始化状态暂时不可用",
        previous: setup,
      },
    };
    rerender(<PlatformDashboard {...dashboardProps} />);

    expect(invoiceConfigurationMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorized: true,
        tenant: { status: "unverified" },
      }),
    );
  });
});

describe("PlatformDashboard payment routing boundary", () => {
  it("keeps reads independent while passing only a fresh setup tenant for writes", () => {
    bootstrapMock.current = resources({ status: "ready", data: [domain("a")] });
    const { rerender } = render(<PlatformDashboard {...dashboardProps} />);

    expect(screen.getByTestId("payment-routing-panel")).toBeInTheDocument();
    expect(paymentRoutingMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorized: true,
        apiAvailable: false,
        tenant: { status: "verified", tenantId: "tenant" },
      }),
    );

    bootstrapMock.current = {
      ...resources({ status: "ready", data: [domain("a")] }),
      setup: {
        status: "error",
        message: "初始化状态暂时不可用",
        previous: setup,
      },
    };
    rerender(<PlatformDashboard {...dashboardProps} />);

    expect(paymentRoutingMock.use).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorized: true,
        tenant: { status: "unverified" },
      }),
    );
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
