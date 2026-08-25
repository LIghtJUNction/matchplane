import { useEffect, useState } from "react";
import {
  Archive,
  Bot,
  ChevronLeft,
  CreditCard,
  GitBranch,
  HandCoins,
  Palette,
  ReceiptText,
  ShieldCheck,
  Upload,
} from "lucide-react";

import {
  getInvoiceSetting,
  getInvoiceProviders,
  getSubplatformOrganizations,
  isLiveMarketplaceEnabled,
  activateSubplatform,
  discoverSubplatformSource,
  getSubplatformSourceIntake,
  registerSubplatform,
  saveInvoiceProvider,
  switchInvoiceMode,
  uploadSubplatformArchive,
  type InvoiceProviderRecord,
  type InvoiceSetting,
  type SubplatformArchiveUpload,
  type SubplatformOrganizationRecord,
} from "../api";
import { LoginMethodsPanel } from "./LoginMethodsPanel";
import { ModeDialog } from "./Overlays";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { PlatformBootstrapNotice } from "./PlatformBootstrapNotice";
import { PlatformFinanceRecordsPanel } from "./PlatformFinanceRecordsPanel";
import { PlatformPaymentRoutingPanel } from "./PlatformPaymentRoutingPanel";
import { PlatformSiteSettingsPanel } from "./PlatformSiteSettingsPanel";
import {
  freshBootstrapResourceData,
  usePlatformBootstrapResources,
} from "../hooks/usePlatformBootstrapResources";
import { usePlatformPaymentRoutingResources } from "../hooks/usePlatformPaymentRoutingResources";
import { RootEmailConfigPanel } from "./RootEmailConfigPanel";
import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";
import { NationalIdentityConfigPanel } from "./NationalIdentityConfigPanel";
import { WeChatLoginConfigPanel } from "./WeChatLoginConfigPanel";
import { PhoneLoginConfigPanel } from "./PhoneLoginConfigPanel";
import { MallCatalogModeration } from "./MallCatalogModeration";
import { MallBrandPanel } from "./MallBrandPanel";
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

export function PlatformDashboard({
  paymentMode,
  rootRole,
  onRequestModeChange,
  onBrandUpdated,
  onNotice,
}: PlatformDashboardProps) {
  const bootstrapAuthorized =
    rootRole === "rootSuperAdmin" || rootRole === "rootAdmin";
  const bootstrap = usePlatformBootstrapResources({
    authorized: bootstrapAuthorized,
    rootRole,
    onNotice,
  });
  const verifiedSetup = freshBootstrapResourceData(bootstrap.setup);
  const verifiedDomains = freshBootstrapResourceData(bootstrap.domains);
  const marketplaceApiAvailable = isLiveMarketplaceEnabled();
  const paymentRouting = usePlatformPaymentRoutingResources({
    authorized: bootstrapAuthorized,
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
  const [activeSection, setActiveSection] = useState<PlatformSection>("home");
  const [subplatforms, setSubplatforms] = useState<
    SubplatformOrganizationRecord[]
  >([]);
  const [invoiceProviders, setInvoiceProviders] = useState<
    InvoiceProviderRecord[]
  >([]);
  const [invoiceSetting, setInvoiceSetting] = useState<InvoiceSetting | null>(
    null,
  );
  const [invoiceEditorOpen, setInvoiceEditorOpen] = useState(false);
  const [invoiceModeDialogOpen, setInvoiceModeDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invoiceName, setInvoiceName] = useState("");
  const [invoiceProviderKey, setInvoiceProviderKey] = useState("");
  const [invoiceMode, setInvoiceMode] = useState<"test" | "production">("test");
  const [invoiceSettings, setInvoiceSettings] = useState("{}");
  const [invoiceCredentialRef, setInvoiceCredentialRef] = useState("");
  const [subplatformEditorOpen, setSubplatformEditorOpen] = useState(false);
  const [subplatformSourceKind, setSubplatformSourceKind] = useState<
    "git" | "archive"
  >("git");
  const [subplatformDomainId, setSubplatformDomainId] = useState("");
  const [subplatformPackageId, setSubplatformPackageId] = useState("");
  const [subplatformSlug, setSubplatformSlug] = useState("");
  const [subplatformSourceLocator, setSubplatformSourceLocator] = useState("");
  const [subplatformPinnedRevision, setSubplatformPinnedRevision] =
    useState("");
  const [subplatformSourceDigest, setSubplatformSourceDigest] = useState("");
  // The root platform never ships a sample market manifest. Operators paste or upload the
  // manifest that belongs to the package they are registering; domain data stays in that package.
  const [subplatformManifest, setSubplatformManifest] = useState("");
  const [subplatformScopes, setSubplatformScopes] = useState("");
  const [subplatformMembershipPolicy, setSubplatformMembershipPolicy] =
    useState<"public" | "invite">("public");
  const [subplatformArchive, setSubplatformArchive] = useState<File | null>(
    null,
  );
  const [subplatformUpload, setSubplatformUpload] =
    useState<SubplatformArchiveUpload | null>(null);
  const [subplatformDiscoveryState, setSubplatformDiscoveryState] =
    useState("");
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
    ...subplatforms.filter(
      (organization) =>
        organization.id !== verifiedSetup?.root.organization?.id,
    ),
  ];

  useEffect(() => {
    if (!rootRole || !marketplaceApiAvailable) return;
    let mounted = true;
    void Promise.allSettled([
      getInvoiceProviders(),
      getInvoiceSetting(),
      getSubplatformOrganizations(),
    ]).then(([invoiceResult, invoiceSettingResult, subplatformResult]) => {
      if (!mounted) return;
      // Invoice administration and subplatform loading remain independent from payment routing.
      if (invoiceResult.status === "fulfilled")
        setInvoiceProviders(invoiceResult.value);
      if (invoiceSettingResult.status === "fulfilled")
        setInvoiceSetting(invoiceSettingResult.value);
      if (subplatformResult.status === "fulfilled")
        setSubplatforms(subplatformResult.value);
    });
    return () => {
      mounted = false;
    };
  }, [marketplaceApiAvailable, rootRole]);

  useEffect(() => {
    const currentDomains = verifiedDomains ?? [];
    setSubplatformDomainId((current) => {
      if (current && !currentDomains.some((domain) => domain.id === current))
        return "";
      if (!current && currentDomains.length === 1)
        return currentDomains[0]?.id ?? "";
      return current;
    });
  }, [verifiedDomains]);

  const refreshInvoiceConfiguration = async () => {
    const [nextInvoiceProviders, nextInvoiceSetting] = await Promise.all([
      getInvoiceProviders(),
      getInvoiceSetting(),
    ]);
    setInvoiceProviders(nextInvoiceProviders);
    setInvoiceSetting(nextInvoiceSetting);
  };

  const refreshSubplatforms = async () => {
    setSubplatforms(await getSubplatformOrganizations());
  };

  const resetSubplatformEditor = () => {
    setSubplatformSourceKind("git");
    setSubplatformPackageId("");
    setSubplatformSlug("");
    setSubplatformSourceLocator("");
    setSubplatformPinnedRevision("");
    setSubplatformSourceDigest("");
    setSubplatformManifest("");
    setSubplatformScopes("");
    setSubplatformMembershipPolicy("public");
    setSubplatformArchive(null);
    setSubplatformUpload(null);
    setSubplatformDiscoveryState("");
  };

  const submitSubplatform = async () => {
    if (bootstrap.setup.status !== "ready") {
      onNotice("商城初始化状态尚未验证，请重新读取后再接入店铺");
      return;
    }
    const currentSetup = bootstrap.setup.data;
    if (!currentSetup.root.tenantId) {
      onNotice("商城已确认尚未完成初始化，暂时不能接入店铺");
      return;
    }
    if (bootstrap.domains.status !== "ready") {
      onNotice("商城数据范围尚未验证，请重新读取后再接入店铺");
      return;
    }
    const selectedDomain = bootstrap.domains.data.find(
      (domain) => domain.id === subplatformDomainId,
    );
    if (!selectedDomain) {
      onNotice("请选择一个已验证的商城数据范围后再接入店铺");
      return;
    }
    let packageId = subplatformPackageId.trim();
    let slug = subplatformSlug.trim();
    let manifest: Record<string, unknown> | null = null;
    let sourceLocator = subplatformSourceLocator.trim();
    let sourceDigest = subplatformSourceDigest.trim().toLowerCase();
    let pinnedRevision = subplatformPinnedRevision.trim().toLowerCase();
    const requestedScopes = [
      ...new Set(
        subplatformScopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ];
    // Supplying the source URL/archive is enough. The isolated builder will read and validate
    // package id, slug, immutable revision, digest and manifest. Manual metadata remains
    // supported for operators who already have a builder-verified package record.
    const hasManualRegistration = Boolean(
      packageId &&
        slug &&
        subplatformManifest.trim() &&
        pinnedRevision &&
        sourceDigest,
    );
    setSubplatformDiscoveryState("");
    setSaving(true);
    try {
      if (subplatformSourceKind === "archive") {
        if (!subplatformArchive) {
          onNotice("请选择 .tar.gz、.tgz、.tar.zst 或 .tzst 店铺接入包");
          return;
        }
        const uploaded = await uploadSubplatformArchive(subplatformArchive);
        sourceLocator = uploaded.sourceLocator;
        sourceDigest = uploaded.sourceDigest;
        pinnedRevision = pinnedRevision || uploaded.sourceDigest;
        setSubplatformUpload(uploaded);
        setSubplatformSourceLocator(sourceLocator);
        setSubplatformSourceDigest(sourceDigest);
        setSubplatformPinnedRevision(pinnedRevision);
      }
      if (!sourceLocator) {
        onNotice("请填写 Git HTTPS 地址或先上传压缩包");
        return;
      }

      if (hasManualRegistration) {
        try {
          const parsed = JSON.parse(subplatformManifest);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          manifest = parsed as Record<string, unknown>;
        } catch {
          onNotice("manifest 必须是 JSON 对象");
          return;
        }
      } else {
        setSubplatformDiscoveryState("正在提交到隔离构建器…");
        const intake = await discoverSubplatformSource({
          domainId: selectedDomain.id,
          sourceKind: subplatformSourceKind,
          sourceLocator,
          sourceDigest: sourceDigest || undefined,
          requestedScopes: requestedScopes.length ? requestedScopes : undefined,
          membershipPolicy: subplatformMembershipPolicy,
        });
        let discovered = null;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          discovered = await getSubplatformSourceIntake(intake.intakeId);
          if (discovered.state === "ready") break;
          if (discovered.state === "rejected") {
            throw new Error(discovered.error || "隔离构建器拒绝了这个店铺来源");
          }
          setSubplatformDiscoveryState(
            discovered.state === "discovering"
              ? "隔离构建器正在读取 manifest…"
              : "等待隔离构建器接单…",
          );
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        }
        if (!discovered || discovered.state !== "ready") {
          throw new Error(
            `隔离构建器尚未完成，请稍后重试（任务 ${intake.intakeId}）`,
          );
        }
        if (
          !discovered.manifest ||
          typeof discovered.manifest !== "object" ||
          Array.isArray(discovered.manifest)
        ) {
          throw new Error("隔离构建器没有返回有效 manifest");
        }
        manifest = discovered.manifest;
        packageId = discovered.packageId || String(manifest.id || "");
        slug = discovered.slug || String(manifest.slug || "");
        sourceDigest = discovered.sourceDigest?.toLowerCase() || sourceDigest;
        pinnedRevision =
          discovered.pinnedRevision?.toLowerCase() || pinnedRevision;
        setSubplatformDiscoveryState("manifest 已验证，正在登记店铺…");
      }

      if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(packageId)) {
        onNotice("package id 只能使用小写字母、数字、点、下划线或短横线");
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
        onNotice("slug 只能使用小写字母、数字和短横线");
        return;
      }
      if (!manifest || manifest.id !== packageId || manifest.slug !== slug) {
        onNotice("构建器返回的 manifest.id/slug 与店铺不一致");
        return;
      }
      if (!/^[0-9a-f]{7,128}$/i.test(pinnedRevision)) {
        onNotice("pinned revision 必须是不可变的 commit 或 digest");
        return;
      }
      if (!/^[0-9a-f]{64}$/i.test(sourceDigest)) {
        onNotice("source digest 必须是 64 位 SHA-256；不要提交未经验证的来源");
        return;
      }
      const result = await registerSubplatform({
        tenantId: currentSetup.root.tenantId,
        domainId: selectedDomain.id,
        packageId,
        slug,
        sourceKind: subplatformSourceKind,
        sourceLocator,
        pinnedRevision,
        sourceDigest,
        manifest,
        requestedScopes: requestedScopes.length ? requestedScopes : undefined,
        membershipPolicy: subplatformMembershipPolicy,
      });
      await refreshSubplatforms();
      setSubplatformEditorOpen(false);
      resetSubplatformEditor();
      onNotice(`店铺 ${result.slug} 已登记，等待隔离构建器完成构建`);
    } catch (error) {
      setSubplatformDiscoveryState(
        error instanceof Error ? error.message : "店铺来源读取失败",
      );
      onNotice(error instanceof Error ? error.message : "店铺接入失败");
    } finally {
      setSaving(false);
    }
  };

  const activateRegisteredSubplatform = async (
    organization: SubplatformOrganizationRecord,
  ) => {
    if (bootstrap.domains.status !== "ready") {
      onNotice("商城数据范围尚未验证，请重新读取后再上线店铺");
      return;
    }
    if (
      !organization.domainId ||
      !bootstrap.domains.data.some(
        (domain) => domain.id === organization.domainId,
      )
    ) {
      onNotice("店铺关联的数据范围已变化，请重新验证后再上线");
      return;
    }
    if (!organization.registrationId || !organization.buildDigest) {
      onNotice("该版本还没有隔离构建器签发的 build digest");
      return;
    }
    setSaving(true);
    try {
      await activateSubplatform({
        registrationId: organization.registrationId,
        buildDigest: organization.buildDigest,
      });
      await refreshSubplatforms();
      onNotice(`${organization.name} 已激活并加入平台路由`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "店铺启用失败");
    } finally {
      setSaving(false);
    }
  };

  const updateLocalStore = (organization: SubplatformOrganizationRecord) => {
    if (bootstrap.setup.status !== "ready") {
      onNotice("商城初始化状态尚未验证，请重新读取后再更新店铺");
      return;
    }
    if (bootstrap.domains.status !== "ready") {
      onNotice("商城数据范围尚未验证，请重新读取后再更新店铺");
      return;
    }
    if (
      !organization.domainId ||
      !bootstrap.domains.data.some(
        (domain) => domain.id === organization.domainId,
      )
    ) {
      onNotice("店铺关联的数据范围已变化，请重新验证后再更新");
      return;
    }
    const sourceKind =
      organization.sourceKind === "archive"
        ? "archive"
        : organization.sourceKind === "git"
          ? "git"
          : null;
    if (!sourceKind) {
      onNotice("只有本地部署的 Git 或压缩包店铺可以在这里更新");
      return;
    }
    setSubplatformEditorOpen(true);
    setSubplatformSourceKind(sourceKind);
    setSubplatformDomainId(organization.domainId);
    setSubplatformPackageId("");
    setSubplatformSlug("");
    setSubplatformManifest("");
    setSubplatformPinnedRevision("");
    setSubplatformSourceDigest("");
    setSubplatformScopes("");
    setSubplatformMembershipPolicy("public");
    setSubplatformArchive(null);
    setSubplatformUpload(null);
    setSubplatformSourceLocator(
      sourceKind === "git"
        ? organization.sourceLocator || organization.sourceRepository || ""
        : "",
    );
    setSubplatformDiscoveryState(
      sourceKind === "git"
        ? `准备检查 ${organization.name} 的 Git 更新`
        : `请选择 ${organization.name} 的新版本压缩包`,
    );
  };

  const confirmInvoiceModeChange = () => {
    if (!invoiceSetting) {
      setInvoiceModeDialogOpen(false);
      onNotice("发票模式尚未读取完成");
      return;
    }
    const nextMode =
      invoiceSetting.active_mode === "test" ? "production" : "test";
    void switchInvoiceMode({
      mode: nextMode,
      providerId: invoiceSetting.provider_id ?? undefined,
      expectedVersion: invoiceSetting.version,
      reason: `web-admin switch invoice mode to ${nextMode}`,
    })
      .then((setting) => {
        setInvoiceSetting(setting);
        setInvoiceModeDialogOpen(false);
        onNotice(
          `发票系统已切换为${setting.active_mode === "test" ? "测试" : "生产"}模式`,
        );
      })
      .catch((error) => {
        setInvoiceModeDialogOpen(false);
        onNotice(error instanceof Error ? error.message : "发票模式切换失败");
      });
  };

  const submitInvoiceProvider = async () => {
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(invoiceSettings);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch {
      onNotice("发票 provider settings 必须是 JSON 对象");
      return;
    }
    if (!invoiceName.trim()) {
      onNotice("请填写发票 provider 名称");
      return;
    }
    if (!invoiceProviderKey.trim()) {
      onNotice("请选择发票 provider 协议");
      return;
    }
    if (invoiceMode === "production" && !invoiceCredentialRef.trim()) {
      onNotice("生产发票 provider 必须填写 secret reference");
      return;
    }
    setSaving(true);
    try {
      await saveInvoiceProvider({
        name: invoiceName.trim(),
        providerKey: invoiceProviderKey,
        mode: invoiceMode,
        settings,
        credentialSecretRef: invoiceCredentialRef.trim() || undefined,
        enabled: true,
        reason: "platform dashboard create invoice provider",
      });
      await refreshInvoiceConfiguration();
      setInvoiceEditorOpen(false);
      setInvoiceName("");
      setInvoiceCredentialRef("");
      setInvoiceSettings("{}");
      onNotice("发票 provider 已保存；切换生产模式前请完成真实税务服务校验");
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "发票 provider 保存失败",
      );
    } finally {
      setSaving(false);
    }
  };

  const subplatformStateLabel: Record<string, string> = {
    active: "已激活",
    ready: "构建完成",
    building: "构建中",
    validated: "已登记，待构建",
    rejected: "构建失败",
  };

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
        <nav
          className="platform-admin-nav"
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
            onClick={() => setActiveSection("home")}
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
            onClick={() => setActiveSection("tree")}
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
            onClick={() => setActiveSection("access")}
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
            onClick={() => setActiveSection("ai")}
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
            onClick={() => setActiveSection("brand")}
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
            onClick={() => setActiveSection("payments")}
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
            onClick={() => setActiveSection("finance")}
          >
            <ReceiptText size={17} aria-hidden="true" />
            <span>财务与退款</span>
          </button>
        </nav>

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
                saving={saving || bootstrap.rootInitializing}
                onInitializeRoot={() =>
                  void bootstrap.initializeRootOrganization()
                }
                onOpenStores={() => setActiveSection("tree")}
                onOpenSettings={() => setActiveSection("brand")}
                onOpenAi={() => setActiveSection("ai")}
              />
            </section>
            <div
              id="platform-panel-brand"
              className="platform-component-panel"
              role="tabpanel"
              aria-labelledby="platform-tab-brand"
              hidden={activeSection !== "brand"}
            >
              <MallBrandPanel
                rootRole={rootRole}
                onBrandUpdated={onBrandUpdated}
                onNotice={onNotice}
              />
              <LoginMethodsPanel />
              <section
                className="platform-component-panel"
                aria-label="商城账号邮件服务"
              >
                <RootEmailConfigPanel rootRole={rootRole} onNotice={onNotice} />
              </section>
              <NationalIdentityConfigPanel
                rootRole={rootRole}
                onNotice={onNotice}
              />
              <WeChatLoginConfigPanel rootRole={rootRole} onNotice={onNotice} />
              <PhoneLoginConfigPanel rootRole={rootRole} onNotice={onNotice} />
              {verifiedSetup?.root.organization?.id ? (
                <PlatformSiteSettingsPanel
                  organizationId={verifiedSetup.root.organization.id}
                  platformPath="/"
                  platformName={verifiedSetup.root.organization.name}
                  onNotice={onNotice}
                />
              ) : (
                <p className="platform-access-empty" role="status">
                  {bootstrap.setup.status === "ready"
                    ? "商城组织已确认为未创建；创建后才能保存站点设置。"
                    : "商城组织状态尚未验证，站点设置保存已暂停。"}
                </p>
              )}
            </div>
            <section
              id="platform-panel-ai"
              className="platform-component-panel"
              role="tabpanel"
              aria-labelledby="platform-tab-ai"
              hidden={activeSection !== "ai"}
            >
              <PlatformAiConfigPanel rootRole={rootRole} onNotice={onNotice} />
            </section>

            <section
              id="platform-panel-tree"
              className="surface subplatform-panel"
              role="tabpanel"
              aria-labelledby="platform-tab-tree"
              hidden={activeSection !== "tree"}
            >
              <div className="subplatform-header">
                <div>
                  <h2 id="subplatform-title">本地店铺</h2>
                  <p className="subplatform-intro">
                    从 Git 仓库或压缩包下载、构建并托管在商城服务器上的店铺。
                  </p>
                </div>
                <button
                  className="button button-dark"
                  type="button"
                  disabled={
                    saving ||
                    !verifiedSetup?.root.organization?.id ||
                    !verifiedDomains?.length
                  }
                  title={
                    bootstrap.setup.status !== "ready"
                      ? "商城初始化状态尚未验证"
                      : !verifiedSetup?.root.organization?.id
                        ? "商城尚未完成初始化"
                        : bootstrap.domains.status !== "ready"
                          ? "商城数据范围尚未验证"
                          : verifiedDomains?.length
                            ? undefined
                            : "商城数据尚未准备好"
                  }
                  onClick={() => setSubplatformEditorOpen((open) => !open)}
                >
                  {subplatformEditorOpen ? "关闭" : "接入本地店铺"}
                </button>
              </div>
              {subplatforms.length ? (
                <div className="subplatform-list" aria-label="本地店铺列表">
                  {subplatforms.map((organization) => (
                    <div className="subplatform-row" key={organization.id}>
                      <span className="subplatform-row-icon" aria-hidden="true">
                        <Archive size={18} />
                      </span>
                      <span className="subplatform-row-copy">
                        <strong>{organization.name}</strong>
                        <small>
                          /{organization.slug} ·{" "}
                          {organization.sourceKind === "git"
                            ? "Git 本地部署"
                            : organization.sourceKind === "archive"
                              ? "压缩包本地部署"
                              : "其他接入"}
                        </small>
                      </span>
                      <span
                        className={`subplatform-state state-${organization.registrationState || "unknown"}`}
                      >
                        {subplatformStateLabel[
                          organization.registrationState || ""
                        ] || "未登记"}
                      </span>
                      {organization.buildError ? (
                        <small
                          className="subplatform-build-error"
                          title={organization.buildError}
                        >
                          最近失败：{organization.buildError.slice(0, 120)}
                        </small>
                      ) : null}
                      {organization.registrationState === "ready" &&
                      organization.buildDigest ? (
                        <button
                          className="button button-dark subplatform-activate"
                          type="button"
                          disabled={
                            saving ||
                            !organization.domainId ||
                            !verifiedDomains?.some(
                              (domain) => domain.id === organization.domainId,
                            )
                          }
                          onClick={() =>
                            void activateRegisteredSubplatform(organization)
                          }
                        >
                          上线店铺
                        </button>
                      ) : null}
                      {organization.registrationState === "active" &&
                      (organization.sourceKind === "git" ||
                        organization.sourceKind === "archive") ? (
                        <button
                          className="button button-light subplatform-activate"
                          type="button"
                          disabled={
                            saving ||
                            !organization.domainId ||
                            !verifiedDomains?.some(
                              (domain) => domain.id === organization.domainId,
                            )
                          }
                          onClick={() => updateLocalStore(organization)}
                        >
                          {organization.sourceKind === "git"
                            ? "检查更新"
                            : "上传新版本"}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="subplatform-empty">
                  <GitBranch size={22} aria-hidden="true" />
                  <p>还没有本地店铺。</p>
                </div>
              )}
              {subplatformEditorOpen ? (
                <div
                  className="admin-editor subplatform-editor"
                  aria-label="接入本地店铺"
                >
                  <div className="admin-editor-heading">
                    <div>
                      <strong>接入本地店铺</strong>
                      <small>
                        填写 Git 地址或上传压缩包，商城会在本地构建并托管它。
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSubplatformEditorOpen(false)}
                    >
                      关闭
                    </button>
                  </div>
                  <div
                    className="subplatform-source-switch"
                    role="group"
                    aria-label="本地店铺来源"
                  >
                    <button
                      type="button"
                      className={
                        subplatformSourceKind === "git" ? "is-selected" : ""
                      }
                      aria-pressed={subplatformSourceKind === "git"}
                      onClick={() => setSubplatformSourceKind("git")}
                    >
                      <GitBranch size={16} aria-hidden="true" />
                      Git 仓库
                    </button>
                    <button
                      type="button"
                      className={
                        subplatformSourceKind === "archive" ? "is-selected" : ""
                      }
                      aria-pressed={subplatformSourceKind === "archive"}
                      onClick={() => setSubplatformSourceKind("archive")}
                    >
                      <Upload size={16} aria-hidden="true" />
                      上传压缩包
                    </button>
                  </div>
                  <div className="subplatform-form-grid">
                    <label className="subplatform-form-wide">
                      <span>商城数据范围</span>
                      <select
                        required
                        value={subplatformDomainId}
                        disabled={bootstrap.domains.status !== "ready"}
                        onChange={(event) =>
                          setSubplatformDomainId(event.target.value)
                        }
                      >
                        <option value="">明确选择数据范围</option>
                        {(verifiedDomains ?? []).map((domain) => (
                          <option key={domain.id} value={domain.id}>
                            {domain.name} · /{domain.slug}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {subplatformSourceKind === "git" ? (
                    <div className="subplatform-form-grid">
                      <label className="subplatform-form-wide">
                        <span>Git HTTPS 地址（不含凭据）</span>
                        <input
                          value={subplatformSourceLocator}
                          onChange={(event) =>
                            setSubplatformSourceLocator(event.target.value)
                          }
                          placeholder="https://github.com/example/market.git"
                          inputMode="url"
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="subplatform-upload-box">
                      <label className="file-picker">
                        <Upload size={18} aria-hidden="true" />
                        <span>
                          {subplatformArchive?.name || "选择本地店铺压缩包"}
                        </span>
                        <input
                          type="file"
                          accept=".tar.gz,.tgz,.tar.zst,.tzst"
                          onChange={(event) =>
                            setSubplatformArchive(
                              event.target.files?.[0] ?? null,
                            )
                          }
                        />
                      </label>
                      <p>
                        {subplatformUpload
                          ? `已上传 ${subplatformUpload.originalName} · ${(subplatformUpload.size / 1024 / 1024).toFixed(1)} MiB · digest ${subplatformUpload.sourceDigest.slice(0, 12)}…`
                          : "限制 64 MiB；服务端只保存随机 locator，隔离构建器负责解包与验证。"}
                      </p>
                    </div>
                  )}
                  <div className="subplatform-editor-footer">
                    <p>
                      <ShieldCheck size={16} aria-hidden="true" />
                      本地店铺通过隔离构建与校验后上线。
                    </p>
                    {subplatformDiscoveryState ? (
                      <small
                        className="subplatform-discovery-state"
                        role="status"
                      >
                        {subplatformDiscoveryState}
                      </small>
                    ) : null}
                    <button
                      className="button button-dark"
                      type="button"
                      disabled={
                        saving ||
                        bootstrap.domains.status !== "ready" ||
                        !verifiedSetup?.root.tenantId ||
                        !verifiedSetup.root.organization?.id ||
                        !subplatformDomainId
                      }
                      onClick={() => void submitSubplatform()}
                    >
                      {saving ? "处理中…" : "构建本地店铺"}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

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
              <SectionHeading
                eyebrow="财务动态"
                title="支付、发票与退款"
                action="配置发票"
                onAction={() => setInvoiceEditorOpen(true)}
              />
              <PlatformFinanceRecordsPanel
                authorized={bootstrapAuthorized}
                apiAvailable={isLiveMarketplaceEnabled()}
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
              {invoiceProviders.length ? (
                <div className="provider-list">
                  {invoiceProviders.map((provider) => (
                    <div className="provider-row" key={provider.provider_id}>
                      <span>
                        <strong>{provider.name}</strong>
                        <small>
                          {provider.provider_key} · {provider.mode}
                        </small>
                      </span>
                      <b>{provider.enabled ? "启用" : "停用"}</b>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="invoice-mode-card">
                <div>
                  <p className="eyebrow">发票运行模式</p>
                  <strong>
                    {invoiceSetting
                      ? invoiceSetting.active_mode === "test"
                        ? "测试模式"
                        : "生产模式"
                      : "读取中…"}
                  </strong>
                  <small>
                    {invoiceSetting?.provider_id
                      ? "已绑定发票 provider"
                      : "尚未绑定默认 provider"}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={!invoiceSetting}
                  onClick={() => setInvoiceModeDialogOpen(true)}
                >
                  切换模式
                </button>
              </div>
              {invoiceEditorOpen ? (
                <div className="admin-editor" aria-label="发票 provider 配置">
                  <div className="admin-editor-heading">
                    <strong>新增发票 provider</strong>
                    <button
                      type="button"
                      onClick={() => setInvoiceEditorOpen(false)}
                    >
                      关闭
                    </button>
                  </div>
                  <label>
                    <span>名称</span>
                    <input
                      value={invoiceName}
                      onChange={(event) => setInvoiceName(event.target.value)}
                      placeholder="例如：电子发票服务"
                    />
                  </label>
                  <label>
                    <span>provider</span>
                    <select
                      value={invoiceProviderKey}
                      onChange={(event) =>
                        setInvoiceProviderKey(event.target.value)
                      }
                    >
                      <option value="">选择 provider 协议</option>
                      <option value="local_test">测试协议</option>
                      <option value="http_json">HTTP JSON</option>
                      <option value="fapiao_http">Fapiao HTTP</option>
                    </select>
                  </label>
                  <label>
                    <span>模式</span>
                    <select
                      value={invoiceMode}
                      onChange={(event) =>
                        setInvoiceMode(
                          event.target.value as "test" | "production",
                        )
                      }
                    >
                      <option value="test">测试</option>
                      <option value="production">生产</option>
                    </select>
                  </label>
                  <label>
                    <span>secret reference</span>
                    <input
                      value={invoiceCredentialRef}
                      onChange={(event) =>
                        setInvoiceCredentialRef(event.target.value)
                      }
                      placeholder="file:///run/secrets/invoice/provider.token"
                    />
                  </label>
                  <label>
                    <span>settings（JSON）</span>
                    <textarea
                      value={invoiceSettings}
                      onChange={(event) =>
                        setInvoiceSettings(event.target.value)
                      }
                      rows={4}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    className="button button-dark"
                    type="button"
                    disabled={saving}
                    onClick={() => void submitInvoiceProvider()}
                  >
                    {saving ? "保存中…" : "保存 provider"}
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
      <ModeDialog
        open={invoiceModeDialogOpen}
        currentMode={invoiceSetting?.active_mode ?? "test"}
        resourceLabel="发票"
        onClose={() => setInvoiceModeDialogOpen(false)}
        onConfirm={confirmInvoiceModeChange}
      />
    </div>
  );
}
