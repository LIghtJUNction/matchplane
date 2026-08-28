import { useCallback, useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@appica/ui-react/tabs";
import {
  Bot,
  ChevronLeft,
  CreditCard,
  GitBranch,
  HandCoins,
  Palette,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";

import {
  isLiveMarketplaceEnabled,
  type SubplatformOrganizationRecord,
} from "../api";
import { HorizontalTabScroller } from "./HorizontalTabScroller";
import { LoginMethodsPanel } from "./LoginMethodsPanel";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { PlatformBootstrapNotice } from "./PlatformBootstrapNotice";
import { PlatformFinanceRecordsPanel } from "./PlatformFinanceRecordsPanel";
import { PlatformInvoiceConfigurationPanel } from "./PlatformInvoiceConfigurationPanel";
import { PlatformLocalStorePanel } from "./PlatformLocalStorePanel";
import { PlatformPaymentRoutingPanel } from "./PlatformPaymentRoutingPanel";
import { PlatformSiteSettingsPanel } from "./PlatformSiteSettingsPanel";
import {
  freshBootstrapResourceData,
  usePlatformBootstrapResources,
} from "../hooks/usePlatformBootstrapResources";
import { usePlatformInvoiceConfigurationResources } from "../hooks/usePlatformInvoiceConfigurationResources";
import { usePlatformLocalStoreResources } from "../hooks/usePlatformLocalStoreResources";
import { usePlatformPaymentRoutingResources } from "../hooks/usePlatformPaymentRoutingResources";
import { RootEmailConfigPanel } from "./RootEmailConfigPanel";
import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";
import { NationalIdentityConfigPanel } from "./NationalIdentityConfigPanel";
import { WeChatLoginConfigPanel } from "./WeChatLoginConfigPanel";
import { PhoneLoginConfigPanel } from "./PhoneLoginConfigPanel";
import { MallCatalogModeration } from "./MallCatalogModeration";
import { MallBrandPanel } from "./MallBrandPanel";
import { MallCurrencySettingsPanel } from "./MallCurrencySettingsPanel";
import { MallInitializationPanel } from "./MallInitializationPanel";
import { StoreCommercialTermsPanel } from "./StoreCommercialTermsPanel";
import { RemoteStoreOnboarding } from "./RemoteStoreOnboarding";
import { SectionHeading } from "./Primitives";

interface PlatformDashboardProps {
  paymentMode: "test" | "production";
  rootRole?: string | null;
  onRequestModeChange: () => void;
  onBrandUpdated?: (brand: { name: string; logoUrl: string | null }) => void;
  onNotice: (message: string) => void;
}

type PlatformSection =
  | "home"
  | "ai"
  | "brand"
  | "tree"
  | "access"
  | "payments"
  | "finance";

type MarketplaceSettingsModule =
  | "brand"
  | "currency"
  | "email"
  | "identity"
  | "filing";

interface MarketplaceSettingsModulesProps {
  organizationId?: string;
  platformName?: string;
  rootRole?: string | null;
  setupStatus: string;
  onBrandUpdated?: (brand: { name: string; logoUrl: string | null }) => void;
  onNotice: (message: string) => void;
}

export function PlatformDashboard({
  paymentMode,
  rootRole,
  onRequestModeChange,
  onBrandUpdated,
  onNotice,
}: PlatformDashboardProps) {
  const [activeSection, setActiveSection] = useState<PlatformSection>("home");
  const [visitedSections, setVisitedSections] = useState<
    ReadonlySet<PlatformSection>
  >(() => new Set(["home"]));
  const activateSection = useCallback((section: PlatformSection) => {
    setActiveSection(section);
    setVisitedSections((current) => {
      if (current.has(section)) return current;
      const next = new Set(current);
      next.add(section);
      return next;
    });
  }, []);
  const bootstrapAuthorized =
    rootRole === "rootSuperAdmin" || rootRole === "rootAdmin";
  const bootstrap = usePlatformBootstrapResources({
    authorized: bootstrapAuthorized,
    rootRole,
    onNotice,
  });
  const verifiedSetup = freshBootstrapResourceData(bootstrap.setup);
  const marketplaceApiAvailable = isLiveMarketplaceEnabled();
  const paymentRouting = usePlatformPaymentRoutingResources({
    authorized: bootstrapAuthorized && visitedSections.has("payments"),
    apiAvailable: marketplaceApiAvailable,
    tenant:
      bootstrap.setup.status === "ready"
        ? {
            status: "verified",
            tenantId: bootstrap.setup.data.root.tenantId,
          }
        : { status: "unverified" },
    onNotice,
  });
  const invoiceConfiguration = usePlatformInvoiceConfigurationResources({
    authorized: bootstrapAuthorized && visitedSections.has("finance"),
    apiAvailable: marketplaceApiAvailable,
    tenant:
      bootstrap.setup.status === "ready"
        ? {
            status: "verified",
            tenantId: bootstrap.setup.data.root.tenantId,
          }
        : { status: "unverified" },
    onNotice,
  });
  const localStores = usePlatformLocalStoreResources({
    authorized:
      bootstrapAuthorized &&
      (visitedSections.has("tree") || visitedSections.has("access")),
    apiAvailable: marketplaceApiAvailable,
    rootRole,
    setup: bootstrap.setup,
    domains: bootstrap.domains,
    onNotice,
  });
  const freshSubplatforms =
    localStores.organizations.status === "ready"
      ? localStores.organizations.data
      : [];
  const accessOrganizations: SubplatformOrganizationRecord[] = [
    ...(verifiedSetup?.root.organization
      ? [
          {
            id: verifiedSetup.root.organization.id,
            isRoot: true,
            name: verifiedSetup.root.organization.name,
            slug: verifiedSetup.root.organization.slug,
            parentOrganizationId: null,
            tenantId: verifiedSetup.root.organization.tenantId,
            domainId: verifiedSetup.root.organization.domainId,
            sourceRepository: null,
            createdAt: "",
            registrationId: null,
            registrationState: null,
            buildDigest: null,
            manifestDigest: null,
          } satisfies SubplatformOrganizationRecord,
        ]
      : []),
    ...freshSubplatforms.filter(
      (organization) =>
        organization.id !== verifiedSetup?.root.organization?.id,
    ),
  ];

  return (
    <div className="dashboard platform-dashboard">
      <section className="workspace-heading platform-heading">
        <div>
          <a className="platform-back-link" href="/">
            <ChevronLeft size={16} aria-hidden="true" />
            返回商城
          </a>
          <h1>商城后台</h1>
          <p>管理商城、店铺、商品、团队与 AI 服务。</p>
        </div>
      </section>

      <div className="platform-admin-shell">
        <HorizontalTabScroller
          activeKey={activeSection}
          className="w-full min-[48.0625rem]:sticky min-[48.0625rem]:top-[4.75rem]"
          locale="zh"
        >
          <nav
            className="platform-admin-nav !static min-w-max !overflow-visible"
            role="tablist"
            aria-label="商城管理分区"
          >
            <button
              id="platform-tab-home"
              type="button"
              role="tab"
              aria-selected={activeSection === "home"}
              aria-controls="platform-panel-home"
              className={activeSection === "home" ? "is-active" : ""}
              onClick={() => activateSection("home")}
            >
              <ShieldCheck size={17} aria-hidden="true" />
              <span>首页</span>
            </button>
            <button
              id="platform-tab-tree"
              type="button"
              role="tab"
              aria-selected={activeSection === "tree"}
              aria-controls="platform-panel-tree"
              className={activeSection === "tree" ? "is-active" : ""}
              onClick={() => activateSection("tree")}
            >
              <GitBranch size={17} aria-hidden="true" />
              <span>店铺与商品</span>
            </button>
            <button
              id="platform-tab-access"
              type="button"
              role="tab"
              aria-selected={activeSection === "access"}
              aria-controls="platform-panel-access"
              className={activeSection === "access" ? "is-active" : ""}
              onClick={() => activateSection("access")}
            >
              <ShieldCheck size={17} aria-hidden="true" />
              <span>用户与团队</span>
            </button>
            <button
              id="platform-tab-ai"
              type="button"
              role="tab"
              aria-selected={activeSection === "ai"}
              aria-controls="platform-panel-ai"
              className={activeSection === "ai" ? "is-active" : ""}
              onClick={() => activateSection("ai")}
            >
              <Bot size={17} aria-hidden="true" />
              <span>AI</span>
            </button>
            <button
              id="platform-tab-brand"
              type="button"
              role="tab"
              aria-selected={activeSection === "brand"}
              aria-controls="platform-panel-brand"
              className={activeSection === "brand" ? "is-active" : ""}
              onClick={() => activateSection("brand")}
            >
              <Palette size={17} aria-hidden="true" />
              <span>商城设置</span>
            </button>
            <button
              id="platform-tab-payments"
              type="button"
              role="tab"
              aria-selected={activeSection === "payments"}
              aria-controls="platform-panel-payments"
              className={activeSection === "payments" ? "is-active" : ""}
              onClick={() => activateSection("payments")}
            >
              <CreditCard size={17} aria-hidden="true" />
              <span>支付（可选）</span>
            </button>
            <button
              id="platform-tab-finance"
              type="button"
              role="tab"
              aria-selected={activeSection === "finance"}
              aria-controls="platform-panel-finance"
              className={activeSection === "finance" ? "is-active" : ""}
              onClick={() => activateSection("finance")}
            >
              <ReceiptText size={17} aria-hidden="true" />
              <span>财务与退款</span>
            </button>
          </nav>
        </HorizontalTabScroller>

        <div className="platform-admin-content">
          <PlatformBootstrapNotice
            authorized={bootstrapAuthorized}
            setup={bootstrap.setup}
            domains={bootstrap.domains}
            ai={bootstrap.ai}
            onRetryFailed={() => void bootstrap.retryFailed()}
          />
          <div className="platform-layout">
            <section
              id="platform-panel-home"
              className="platform-component-panel"
              role="tabpanel"
              aria-labelledby="platform-tab-home"
              hidden={activeSection !== "home"}
            >
              <MallInitializationPanel
                setupResource={bootstrap.setup}
                domainsResource={bootstrap.domains}
                aiResource={bootstrap.ai}
                rootRole={rootRole}
                saving={Boolean(bootstrap.rootInitializing)}
                onInitializeRoot={() =>
                  void bootstrap.initializeRootOrganization()
                }
                onOpenStores={() => activateSection("tree")}
                onOpenSettings={() => activateSection("brand")}
                onOpenAi={() => activateSection("ai")}
              />
            </section>
            {visitedSections.has("brand") ? (
              <div
                id="platform-panel-brand"
                className="platform-component-panel"
                role="tabpanel"
                aria-labelledby="platform-tab-brand"
                hidden={activeSection !== "brand"}
              >
                <MarketplaceSettingsModules
                  organizationId={verifiedSetup?.root.organization?.id}
                  platformName={verifiedSetup?.root.organization?.name}
                  rootRole={rootRole}
                  setupStatus={bootstrap.setup.status}
                  onBrandUpdated={onBrandUpdated}
                  onNotice={onNotice}
                />
              </div>
            ) : null}
            {visitedSections.has("ai") ? (
              <section
                id="platform-panel-ai"
                className="platform-component-panel"
                role="tabpanel"
                aria-labelledby="platform-tab-ai"
                hidden={activeSection !== "ai"}
              >
                <PlatformAiConfigPanel
                  rootRole={rootRole}
                  onNotice={onNotice}
                />
              </section>
            ) : null}

            {visitedSections.has("tree") ? (
              <>
                <PlatformLocalStorePanel
                  controller={localStores}
                  domainsResource={bootstrap.domains}
                  hidden={activeSection !== "tree"}
                  onNotice={onNotice}
                />

                <div
                  className="platform-component-panel"
                  hidden={activeSection !== "tree"}
                >
                  <RemoteStoreOnboarding
                    domainsResource={bootstrap.domains}
                    onNotice={onNotice}
                  />
                </div>

                <div
                  className="platform-component-panel"
                  hidden={activeSection !== "tree"}
                >
                  <MallCatalogModeration onNotice={onNotice} />
                </div>
              </>
            ) : null}

            {visitedSections.has("access") ? (
              <div
                id="platform-panel-access"
                className="platform-component-panel"
                role="tabpanel"
                aria-labelledby="platform-tab-access"
                hidden={activeSection !== "access"}
              >
                <PlatformAccessPanel
                  organizations={accessOrganizations}
                  rootRole={rootRole}
                  onNotice={onNotice}
                />
              </div>
            ) : null}

            {visitedSections.has("payments") ? (
              <section
                id="platform-panel-payments"
                className="surface gateway-panel"
                role="tabpanel"
                aria-labelledby="platform-tab-payments"
                hidden={activeSection !== "payments"}
              >
                <StoreCommercialTermsPanel
                  rootRole={rootRole}
                  onNotice={onNotice}
                />
                <div className={`payment-mode-control mode-${paymentMode}`}>
                  <div>
                    <span className="status-orb" aria-hidden="true" />
                    <span>
                      <small>可选线上支付</small>
                      <strong>
                        {paymentMode === "test" ? "测试模式" : "生产模式"}
                      </strong>
                    </span>
                  </div>
                  <button type="button" onClick={onRequestModeChange}>
                    切换支付模式
                  </button>
                </div>
                <PlatformPaymentRoutingPanel
                  controller={paymentRouting}
                  onNotice={onNotice}
                />
              </section>
            ) : null}

            {visitedSections.has("finance") ? (
              <>
                <section
                  id="platform-panel-finance"
                  className="surface commission-panel"
                  role="tabpanel"
                  aria-labelledby="platform-tab-finance"
                  hidden={activeSection !== "finance"}
                >
                  <SectionHeading eyebrow="提成模型" title="本月收入构成" />
                  <div className="commission-total">
                    <span>已确认净收入</span>
                    <strong>—</strong>
                    <small>等待 API 返回成交与服务费数据</small>
                  </div>
                  <div className="commission-empty">
                    <HandCoins size={23} aria-hidden="true" />
                    <p>收入构成会按真实成交、线下撮合和增值服务数据生成。</p>
                  </div>
                  <div className="commission-note">
                    <ShieldCheck size={18} aria-hidden="true" />
                    <p>
                      提成按双方确认的最终成交价精确计算，退款时按比例冲回并生成发票更正。
                    </p>
                  </div>
                </section>

                <section
                  className="surface finance-activity"
                  aria-labelledby="finance-activity-title"
                  hidden={activeSection !== "finance"}
                >
                  <SectionHeading eyebrow="财务动态" title="支付、发票与退款" />
                  <PlatformFinanceRecordsPanel
                    authorized={
                      bootstrapAuthorized && visitedSections.has("finance")
                    }
                    apiAvailable={marketplaceApiAvailable}
                    tenant={
                      bootstrap.setup.status === "ready"
                        ? {
                            status: "verified",
                            tenantId: bootstrap.setup.data.root.tenantId,
                          }
                        : { status: "unverified" }
                    }
                    onNotice={onNotice}
                  />
                  <PlatformInvoiceConfigurationPanel
                    controller={invoiceConfiguration}
                    onNotice={onNotice}
                  />
                </section>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MarketplaceSettingsModules({
  organizationId,
  platformName,
  rootRole,
  setupStatus,
  onBrandUpdated,
  onNotice,
}: MarketplaceSettingsModulesProps) {
  const [activeModule, setActiveModule] =
    useState<MarketplaceSettingsModule>("brand");
  const [visitedModules, setVisitedModules] = useState<
    ReadonlySet<MarketplaceSettingsModule>
  >(() => new Set(["brand"]));
  const activateModule = useCallback((module: MarketplaceSettingsModule) => {
    setActiveModule(module);
    setVisitedModules((current) => {
      if (current.has(module)) return current;
      const next = new Set(current);
      next.add(module);
      return next;
    });
  }, []);

  return (
    <Tabs
      value={activeModule}
      onValueChange={(value) =>
        activateModule(value as MarketplaceSettingsModule)
      }
      variant="pill"
      size="md"
      className="min-w-0"
    >
      <HorizontalTabScroller
        activeKey={activeModule}
        className="w-full"
        locale="zh"
      >
        <TabsList aria-label="商城设置模块" className="w-max min-w-max">
          <TabsTrigger
            id="marketplace-settings-tab-brand"
            value="brand"
            className="min-h-11"
            aria-controls="marketplace-settings-panel-brand"
          >
            品牌
          </TabsTrigger>
          <TabsTrigger
            id="marketplace-settings-tab-currency"
            value="currency"
            className="min-h-11"
            aria-controls="marketplace-settings-panel-currency"
          >
            货币与汇率
          </TabsTrigger>
          <TabsTrigger
            id="marketplace-settings-tab-email"
            value="email"
            className="min-h-11"
            aria-controls="marketplace-settings-panel-email"
          >
            邮件
          </TabsTrigger>
          <TabsTrigger
            id="marketplace-settings-tab-identity"
            value="identity"
            className="min-h-11"
            aria-controls="marketplace-settings-panel-identity"
          >
            登录与身份
          </TabsTrigger>
          <TabsTrigger
            id="marketplace-settings-tab-filing"
            value="filing"
            className="min-h-11"
            aria-controls="marketplace-settings-panel-filing"
          >
            备案
          </TabsTrigger>
        </TabsList>
      </HorizontalTabScroller>

      {visitedModules.has("brand") ? (
        <TabsContent
          id="marketplace-settings-panel-brand"
          value="brand"
          aria-labelledby="marketplace-settings-tab-brand"
          className="min-w-0"
          keepMounted
        >
          <MallBrandPanel
            rootRole={rootRole}
            onBrandUpdated={onBrandUpdated}
            onNotice={onNotice}
          />
        </TabsContent>
      ) : null}
      {visitedModules.has("currency") ? (
        <TabsContent
          id="marketplace-settings-panel-currency"
          value="currency"
          aria-labelledby="marketplace-settings-tab-currency"
          className="min-w-0"
          keepMounted
        >
          <MallCurrencySettingsPanel rootRole={rootRole} onNotice={onNotice} />
        </TabsContent>
      ) : null}
      {visitedModules.has("email") ? (
        <TabsContent
          id="marketplace-settings-panel-email"
          value="email"
          aria-labelledby="marketplace-settings-tab-email"
          className="min-w-0"
          keepMounted
        >
          <RootEmailConfigPanel rootRole={rootRole} onNotice={onNotice} />
        </TabsContent>
      ) : null}
      {visitedModules.has("identity") ? (
        <TabsContent
          id="marketplace-settings-panel-identity"
          value="identity"
          aria-labelledby="marketplace-settings-tab-identity"
          className="min-w-0"
          keepMounted
        >
          <LoginMethodsPanel />
          <NationalIdentityConfigPanel
            rootRole={rootRole}
            onNotice={onNotice}
          />
          <WeChatLoginConfigPanel
            rootRole={rootRole}
            onNotice={onNotice}
          />
          <PhoneLoginConfigPanel rootRole={rootRole} onNotice={onNotice} />
        </TabsContent>
      ) : null}
      {visitedModules.has("filing") ? (
        <TabsContent
          id="marketplace-settings-panel-filing"
          value="filing"
          aria-labelledby="marketplace-settings-tab-filing"
          className="min-w-0"
          keepMounted
        >
          {organizationId ? (
            <PlatformSiteSettingsPanel
              organizationId={organizationId}
              platformPath="/"
              platformName={platformName ?? "商城"}
              onNotice={onNotice}
            />
          ) : (
            <p className="platform-access-empty" role="status">
              {setupStatus === "ready"
                ? "商城组织已确认为未创建；创建后才能保存站点设置。"
                : "商城组织状态尚未验证，站点设置保存已暂停。"}
            </p>
          )}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
