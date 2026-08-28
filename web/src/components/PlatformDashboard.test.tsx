import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isLiveMarketplaceEnabled: vi.fn(() => true),
  getPaymentGateways: vi.fn(),
  getPaymentRoutes: vi.fn(),
  getInvoiceProviders: vi.fn(),
  getInvoiceSetting: vi.fn(),
  getSubplatformOrganizations: vi.fn(),
  getPaymentAdminRecords: vi.fn(),
  getRefundAdminRecords: vi.fn(),
  getInvoiceAdminRecords: vi.fn(),
  getPlatformOidcClients: vi.fn(),
  getFederationBindings: vi.fn(),
  getPlatformDomains: vi.fn(),
  getPlatformAccounts: vi.fn(),
  getPlatformMembers: vi.fn(),
  getPlatformApiKeys: vi.fn(),
}));
const bootstrapMock = vi.hoisted(() => ({ current: undefined as unknown }));
const settingsModuleRequests = vi.hoisted(() => ({
  brand: vi.fn(),
  currency: vi.fn(),
  email: vi.fn(),
  identity: vi.fn(),
  filing: vi.fn(),
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
vi.mock("./LoginMethodsPanel", async () => {
  const { useEffect } = await import("react");
  return {
    LoginMethodsPanel: () => {
      useEffect(() => {
        settingsModuleRequests.identity();
      }, []);
      return <div data-testid="login-methods-panel" />;
    },
  };
});
vi.mock("./PlatformBootstrapNotice", () => ({
  PlatformBootstrapNotice: () => null,
}));
vi.mock("./PlatformInvoiceConfigurationPanel", () => ({
  PlatformInvoiceConfigurationPanel: () => (
    <div data-testid="invoice-configuration-panel" />
  ),
}));
vi.mock("./PlatformLocalStorePanel", () => ({
  PlatformLocalStorePanel: ({ hidden }: { hidden?: boolean }) => (
    <section
      id="platform-panel-tree"
      role="tabpanel"
      aria-labelledby="platform-tab-tree"
      hidden={hidden}
      data-testid="local-store-panel"
    />
  ),
}));
vi.mock("./PlatformPaymentRoutingPanel", () => ({
  PlatformPaymentRoutingPanel: () => (
    <div data-testid="payment-routing-panel" />
  ),
}));
vi.mock("./PlatformSiteSettingsPanel", async () => {
  const { useEffect } = await import("react");
  return {
    PlatformSiteSettingsPanel: () => {
      useEffect(() => {
        settingsModuleRequests.filing();
      }, []);
      return <div data-testid="site-settings-panel" />;
    },
  };
});
vi.mock("./RootEmailConfigPanel", async () => {
  const { useEffect } = await import("react");
  return {
    RootEmailConfigPanel: () => {
      useEffect(() => {
        settingsModuleRequests.email();
      }, []);
      return <div data-testid="email-config-panel" />;
    },
  };
});
vi.mock("./PlatformAiConfigPanel", () => ({
  PlatformAiConfigPanel: () => <div data-testid="ai-panel-content" />,
}));
vi.mock("./NationalIdentityConfigPanel", () => ({
  NationalIdentityConfigPanel: () => (
    <div data-testid="national-identity-config-panel" />
  ),
}));
vi.mock("./WeChatLoginConfigPanel", () => ({
  WeChatLoginConfigPanel: () => <div data-testid="wechat-config-panel" />,
}));
vi.mock("./PhoneLoginConfigPanel", () => ({
  PhoneLoginConfigPanel: () => <div data-testid="phone-config-panel" />,
}));
vi.mock("./MallCatalogModeration", () => ({
  MallCatalogModeration: () => null,
}));
vi.mock("./MallBrandPanel", async () => {
  const { useEffect } = await import("react");
  return {
    MallBrandPanel: () => {
      useEffect(() => {
        settingsModuleRequests.brand();
      }, []);
      return <div data-testid="brand-panel-content" />;
    },
  };
});
vi.mock("./MallCurrencySettingsPanel", async () => {
  const { useEffect } = await import("react");
  return {
    MallCurrencySettingsPanel: () => {
      useEffect(() => {
        settingsModuleRequests.currency();
      }, []);
      return <div data-testid="currency-panel-content" />;
    },
  };
});
vi.mock("./MallInitializationPanel", () => ({
  MallInitializationPanel: ({
    onOpenStores,
    onOpenSettings,
    onOpenAi,
  }: {
    onOpenStores: (openScope: boolean) => void;
    onOpenSettings: () => void;
    onOpenAi: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenStores(true)}>
        初始化跳转：店铺
      </button>
      <button type="button" onClick={onOpenSettings}>
        初始化跳转：设置
      </button>
      <button type="button" onClick={onOpenAi}>
        初始化跳转：AI
      </button>
    </div>
  ),
}));
vi.mock("./StoreCommercialTermsPanel", () => ({
  StoreCommercialTermsPanel: () => null,
}));
vi.mock("./RemoteStoreOnboarding", () => ({
  RemoteStoreOnboarding: () => null,
}));
vi.mock("./Primitives", () => ({ SectionHeading: () => null }));

import type {
  InvoiceSetting,
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
  vi.clearAllMocks();
  bootstrapMock.current = resources({ status: "ready", data: [domain("a")] });
  api.isLiveMarketplaceEnabled.mockReturnValue(true);
  api.getPaymentGateways.mockResolvedValue([]);
  api.getPaymentRoutes.mockResolvedValue([]);
  api.getInvoiceProviders.mockResolvedValue([]);
  api.getInvoiceSetting.mockResolvedValue(invoiceSetting);
  api.getSubplatformOrganizations.mockResolvedValue([]);
  api.getPaymentAdminRecords.mockResolvedValue([]);
  api.getRefundAdminRecords.mockResolvedValue([]);
  api.getInvoiceAdminRecords.mockResolvedValue([]);
  api.getPlatformOidcClients.mockResolvedValue([]);
  api.getFederationBindings.mockResolvedValue([]);
  api.getPlatformDomains.mockResolvedValue([]);
  api.getPlatformAccounts.mockResolvedValue([]);
  api.getPlatformMembers.mockResolvedValue({
    organizationId: "root",
    organizationName: "Root",
    members: [],
  });
  api.getPlatformApiKeys.mockResolvedValue([]);
});

describe("PlatformDashboard deferred sections", () => {
  it.each([320, 390])(
    "contains both tab strips without document overflow at %ipx",
    async (width) => {
      const user = userEvent.setup();
      const { container } = render(
        <div style={{ width }}>
          <PlatformDashboard {...dashboardProps} />
        </div>,
      );

      await user.click(screen.getByRole("tab", { name: "商城设置" }));

      const scrollers = container.querySelectorAll(
        '[data-horizontal-tab-scroller="true"]',
      );
      const viewports = container.querySelectorAll(
        '[data-horizontal-tab-scroller-viewport="true"]',
      );
      expect(scrollers).toHaveLength(2);
      expect(viewports).toHaveLength(2);
      for (const scroller of scrollers) {
        expect(scroller).toHaveClass("min-w-0", "w-full");
      }
      for (const viewport of viewports) {
        expect(viewport).toHaveClass("min-w-0", "overflow-x-auto");
      }
      expect(viewports[0]).toContainElement(
        screen.getByRole("tablist", { name: "商城管理分区" }),
      );
      expect(viewports[1]).toContainElement(
        screen.getByRole("tablist", { name: "商城设置模块" }),
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    },
  );

  it("lazily mounts marketplace settings modules once and preserves their tabpanels", async () => {
    const user = userEvent.setup();
    render(<PlatformDashboard {...dashboardProps} />);

    expect(screen.queryByTestId("brand-panel-content")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "商城设置" }));

    const outerTab = screen.getByRole("tab", { name: "商城设置" });
    const outerPanel = document.getElementById("platform-panel-brand");
    expect(outerTab).toHaveAttribute("id", "platform-tab-brand");
    expect(outerTab).toHaveAttribute("aria-controls", "platform-panel-brand");
    expect(outerPanel).toHaveAttribute("role", "tabpanel");
    expect(outerPanel).toHaveAttribute("aria-labelledby", "platform-tab-brand");

    const moduleLabels = [
      "品牌",
      "货币与汇率",
      "邮件",
      "登录与身份",
      "备案",
    ] as const;
    for (const label of moduleLabels) {
      expect(screen.getByRole("tab", { name: label })).toHaveClass("min-h-11");
    }
    expect(screen.getByRole("tab", { name: "品牌" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("brand-panel-content")).toBeVisible();
    expect(screen.queryByTestId("email-config-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("login-methods-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("site-settings-panel")).not.toBeInTheDocument();
    expect(settingsModuleRequests.brand).toHaveBeenCalledOnce();
    expect(settingsModuleRequests.currency).not.toHaveBeenCalled();
    expect(settingsModuleRequests.email).not.toHaveBeenCalled();
    expect(settingsModuleRequests.identity).not.toHaveBeenCalled();
    expect(settingsModuleRequests.filing).not.toHaveBeenCalled();

    const brandPanel = document.getElementById(
      "marketplace-settings-panel-brand",
    );
    const brandContent = screen.getByTestId("brand-panel-content");
    expect(screen.getByRole("tab", { name: "品牌" })).toHaveAttribute(
      "aria-controls",
      brandPanel?.id,
    );
    expect(brandPanel).toHaveAttribute(
      "aria-labelledby",
      "marketplace-settings-tab-brand",
    );
    expect(brandPanel).toHaveAttribute("role", "tabpanel");

    await user.click(screen.getByRole("tab", { name: "货币与汇率" }));
    const currencyPanel = document.getElementById(
      "marketplace-settings-panel-currency",
    );
    const currencyContent = screen.getByTestId("currency-panel-content");
    expect(currencyContent).toBeVisible();
    expect(settingsModuleRequests.currency).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("tab", { name: "邮件" }));
    const emailPanel = document.getElementById(
      "marketplace-settings-panel-email",
    );
    const emailContent = screen.getByTestId("email-config-panel");
    expect(screen.getByRole("tab", { name: "邮件" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "品牌" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(emailContent).toBeVisible();
    expect(brandPanel).not.toBeVisible();

    await user.click(screen.getByRole("tab", { name: "登录与身份" }));
    const identityPanel = document.getElementById(
      "marketplace-settings-panel-identity",
    );
    const identityContent = screen.getByTestId("login-methods-panel");
    expect(identityContent).toBeVisible();
    expect(screen.getByTestId("national-identity-config-panel")).toBeVisible();
    expect(screen.getByTestId("wechat-config-panel")).toBeVisible();
    expect(screen.getByTestId("phone-config-panel")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "备案" }));
    const filingPanel = document.getElementById(
      "marketplace-settings-panel-filing",
    );
    const filingContent = screen.getByTestId("site-settings-panel");
    expect(filingContent).toBeVisible();

    for (const [label, panelId, tabId] of [
      [
        "邮件",
        "marketplace-settings-panel-email",
        "marketplace-settings-tab-email",
      ],
      [
        "登录与身份",
        "marketplace-settings-panel-identity",
        "marketplace-settings-tab-identity",
      ],
      [
        "备案",
        "marketplace-settings-panel-filing",
        "marketplace-settings-tab-filing",
      ],
    ] as const) {
      const tab = screen.getByRole("tab", { name: label });
      const panel = document.getElementById(panelId);
      expect(tab).toHaveAttribute("aria-controls", panelId);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tabId);
    }

    await user.click(screen.getByRole("tab", { name: "品牌" }));
    expect(screen.getByTestId("brand-panel-content")).toBe(brandContent);
    await user.click(screen.getByRole("tab", { name: "货币与汇率" }));
    expect(screen.getByTestId("currency-panel-content")).toBe(currencyContent);
    expect(currencyPanel).toBeVisible();
    expect(settingsModuleRequests.currency).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("tab", { name: "邮件" }));
    expect(screen.getByTestId("email-config-panel")).toBe(emailContent);
    await user.click(screen.getByRole("tab", { name: "登录与身份" }));
    expect(screen.getByTestId("login-methods-panel")).toBe(identityContent);
    await user.click(screen.getByRole("tab", { name: "备案" }));
    expect(screen.getByTestId("site-settings-panel")).toBe(filingContent);
    expect(emailPanel).not.toBeVisible();
    expect(identityPanel).not.toBeVisible();
    expect(filingPanel).toBeVisible();
    expect(settingsModuleRequests.brand).toHaveBeenCalledOnce();
    expect(settingsModuleRequests.currency).toHaveBeenCalledOnce();
    expect(settingsModuleRequests.email).toHaveBeenCalledOnce();
    expect(settingsModuleRequests.identity).toHaveBeenCalledOnce();
    expect(settingsModuleRequests.filing).toHaveBeenCalledOnce();
  });

  it("defers the 11 identified offscreen GETs and loads each resource group once", async () => {
    const user = userEvent.setup();
    render(<PlatformDashboard {...dashboardProps} />);

    expect(identifiedDeferredGetCount()).toBe(0);
    expect(financeRecordGetCount()).toBe(0);
    expect(screen.queryByTestId("brand-panel-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-panel-content")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-store-panel")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("payment-routing-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("invoice-configuration-panel"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    await waitFor(() => expect(paymentGetCount()).toBe(2));
    const paymentPanel = document.getElementById("platform-panel-payments");
    expect(paymentPanel).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "首页" }));
    expect(paymentPanel).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    expect(document.getElementById("platform-panel-payments")).toBe(
      paymentPanel,
    );
    expect(paymentGetCount()).toBe(2);

    await user.click(screen.getByRole("tab", { name: "财务与退款" }));
    await waitFor(() => {
      expect(invoiceGetCount()).toBe(2);
      expect(financeRecordGetCount()).toBe(3);
    });
    await user.click(screen.getByRole("tab", { name: "首页" }));
    await user.click(screen.getByRole("tab", { name: "财务与退款" }));
    expect(invoiceGetCount()).toBe(2);
    expect(financeRecordGetCount()).toBe(3);

    await user.click(screen.getByRole("tab", { name: "店铺与商品" }));
    await waitFor(() =>
      expect(api.getSubplatformOrganizations).toHaveBeenCalledOnce(),
    );
    await user.click(screen.getByRole("tab", { name: "用户与团队" }));
    await waitFor(() => expect(accessGetCount()).toBe(6));

    expect(identifiedDeferredGetCount()).toBe(11);
    expect(financeRecordGetCount()).toBe(3);

    await user.click(screen.getByRole("tab", { name: "首页" }));
    await user.click(screen.getByRole("tab", { name: "用户与团队" }));
    expect(identifiedDeferredGetCount()).toBe(11);
    expect(financeRecordGetCount()).toBe(3);
  });

  it("keeps every visited tabpanel mounted with its ARIA relationship", async () => {
    const user = userEvent.setup();
    render(<PlatformDashboard {...dashboardProps} />);

    const sections = [
      ["home", "首页"],
      ["tree", "店铺与商品"],
      ["access", "用户与团队"],
      ["ai", "AI"],
      ["brand", "商城设置"],
      ["payments", "支付（可选）"],
      ["finance", "财务与退款"],
    ] as const;

    for (const [section, label] of sections) {
      const tab = screen.getByRole("tab", { name: label });
      await user.click(tab);
      const panel = document.getElementById(`platform-panel-${section}`);
      expect(tab).toHaveAttribute("aria-controls", panel?.id);
      expect(tab).toHaveAttribute("aria-selected", "true");
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
      expect(panel).toBeVisible();
    }

    for (const [section] of sections.slice(0, -1)) {
      expect(document.getElementById(`platform-panel-${section}`)).toBeTruthy();
      expect(
        document.getElementById(`platform-panel-${section}`),
      ).not.toBeVisible();
    }
  });

  it("uses the same lazy activation path for initialization shortcuts", async () => {
    const user = userEvent.setup();
    render(<PlatformDashboard {...dashboardProps} />);

    await user.click(screen.getByRole("button", { name: "初始化跳转：店铺" }));

    expect(screen.getByRole("tab", { name: "店铺与商品" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("local-store-panel")).toBeVisible();
    await waitFor(() =>
      expect(api.getSubplatformOrganizations).toHaveBeenCalledOnce(),
    );
  });
});

function paymentGetCount() {
  return (
    api.getPaymentGateways.mock.calls.length +
    api.getPaymentRoutes.mock.calls.length
  );
}

function invoiceGetCount() {
  return (
    api.getInvoiceProviders.mock.calls.length +
    api.getInvoiceSetting.mock.calls.length
  );
}

function accessGetCount() {
  return [
    api.getPlatformOidcClients,
    api.getFederationBindings,
    api.getPlatformDomains,
    api.getPlatformAccounts,
    api.getPlatformMembers,
    api.getPlatformApiKeys,
  ].reduce((total, request) => total + request.mock.calls.length, 0);
}

function identifiedDeferredGetCount() {
  return (
    paymentGetCount() +
    invoiceGetCount() +
    api.getSubplatformOrganizations.mock.calls.length +
    accessGetCount()
  );
}

function financeRecordGetCount() {
  return (
    api.getPaymentAdminRecords.mock.calls.length +
    api.getRefundAdminRecords.mock.calls.length +
    api.getInvoiceAdminRecords.mock.calls.length
  );
}

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

const invoiceSetting: InvoiceSetting = {
  tenant_id: "tenant",
  active_mode: "test",
  provider_id: null,
  updated_by: "admin",
  version: 1,
  updated_at: "2026-08-26T00:00:00.000Z",
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
