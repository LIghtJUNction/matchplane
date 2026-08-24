import { useEffect, useState } from "react";
import {
  Archive,
  BanknoteArrowDown,
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
  getInvoiceAdminRecords,
  getInvoiceSetting,
  getInvoiceProviders,
  getPaymentAdminRecords,
  getPaymentGateways,
  getPaymentRoutes,
  getPlatformSetupStatus,
  getPlatformAiStatus,
  getSubplatformOrganizations,
  getRefundAdminRecords,
  createAdminRefund,
  createRootPlatformOrganization,
  isLiveMarketplaceEnabled,
  activateSubplatform,
  discoverSubplatformSource,
  getPlatformDomains,
  getSubplatformSourceIntake,
  registerSubplatform,
  saveInvoiceProvider,
  savePaymentGateway,
  savePaymentRoute,
  switchInvoiceMode,
  uploadSubplatformArchive,
  type InvoiceProviderRecord,
  type InvoiceAdminRecord,
  type InvoiceSetting,
  type PaymentAdminRecord,
  type PaymentGatewayRecord,
  type PaymentRouteRecord,
  type PlatformSetupStatus,
  type PlatformAiStatus,
  type PlatformDomainRecord,
  type RefundAdminRecord,
  type SubplatformArchiveUpload,
  type SubplatformOrganizationRecord,
} from "../api";
import { LoginMethodsPanel } from "./LoginMethodsPanel";
import { ModeDialog } from "./Overlays";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { PlatformSiteSettingsPanel } from "./PlatformSiteSettingsPanel";
import { RootEmailConfigPanel } from "./RootEmailConfigPanel";
import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";
import { NationalIdentityConfigPanel } from "./NationalIdentityConfigPanel";
import { WeChatLoginConfigPanel } from "./WeChatLoginConfigPanel";
import { PhoneLoginConfigPanel } from "./PhoneLoginConfigPanel";
import { MallCatalogModeration } from "./MallCatalogModeration";
import { MallBrandPanel } from "./MallBrandPanel";
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
  const [setup, setSetup] = useState<PlatformSetupStatus | null>(null);
  const [activeSection, setActiveSection] = useState<PlatformSection>("home");
  const [aiStatus, setAiStatus] = useState<PlatformAiStatus | null>(null);
  const [domains, setDomains] = useState<PlatformDomainRecord[]>([]);
  const [subplatforms, setSubplatforms] = useState<
    SubplatformOrganizationRecord[]
  >([]);
  const [gateways, setGateways] = useState<PaymentGatewayRecord[]>([]);
  const [paymentRoutes, setPaymentRoutes] = useState<PaymentRouteRecord[]>([]);
  const [invoiceProviders, setInvoiceProviders] = useState<
    InvoiceProviderRecord[]
  >([]);
  const [invoiceSetting, setInvoiceSetting] = useState<InvoiceSetting | null>(
    null,
  );
  const [payments, setPayments] = useState<PaymentAdminRecord[]>([]);
  const [refunds, setRefunds] = useState<RefundAdminRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAdminRecord[]>([]);
  const [financeView, setFinanceView] = useState<"invoices" | "refunds">(
    "invoices",
  );
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundSaving, setRefundSaving] = useState(false);
  const [gatewayEditorOpen, setGatewayEditorOpen] = useState(false);
  const [routeEditorOpen, setRouteEditorOpen] = useState(false);
  const [invoiceEditorOpen, setInvoiceEditorOpen] = useState(false);
  const [invoiceModeDialogOpen, setInvoiceModeDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayKind, setGatewayKind] =
    useState<PaymentGatewayRecord["kind"]>("test");
  const [gatewayMode, setGatewayMode] = useState<"test" | "production">("test");
  const [gatewaySettings, setGatewaySettings] = useState("{}");
  const [gatewayCredentialRef, setGatewayCredentialRef] = useState("");
  const [routeGatewayId, setRouteGatewayId] = useState("");
  const [routeMethodCode, setRouteMethodCode] = useState("");
  const [routeCurrency, setRouteCurrency] = useState("");
  const [routePriority, setRoutePriority] = useState("100");
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
    ...(setup?.root.organization
      ? [
          {
            id: setup.root.organization.id,
            isRoot: true,
            name: setup.root.organization.name,
            slug: setup.root.organization.slug,
            parentOrganizationId: null,
            tenantId: setup.root.organization.tenantId,
            domainId: setup.root.organization.domainId,
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
      (organization) => organization.id !== setup?.root.organization?.id,
    ),
  ];

  useEffect(() => {
    if (!rootRole) return;
    let mounted = true;
    void Promise.allSettled([
      getPlatformSetupStatus(),
      getPlatformDomains(),
      getPlatformAiStatus(),
    ]).then(([statusResult, domainsResult, aiResult]) => {
      if (!mounted) return;
      if (statusResult.status === "fulfilled") {
        setSetup(statusResult.value);
      }
      // A fresh deployment can report its bounded setup state before a root tenant exists.
      // Keep that useful state visible instead of turning the whole admin panel into a generic
      // error just because the domain endpoint correctly returned 503.
      setDomains(
        domainsResult.status === "fulfilled" ? domainsResult.value : [],
      );
      if (aiResult.status === "fulfilled") setAiStatus(aiResult.value);
    });
    return () => {
      mounted = false;
    };
  }, [rootRole]);

  useEffect(() => {
    if (!rootRole || !isLiveMarketplaceEnabled()) return;
    let mounted = true;
    void Promise.allSettled([
      getPaymentGateways(),
      getPaymentRoutes(),
      getInvoiceProviders(),
      getInvoiceSetting(),
      getPaymentAdminRecords(),
      getRefundAdminRecords(),
      getInvoiceAdminRecords(),
      getSubplatformOrganizations(),
    ]).then(
      ([
        gatewayResult,
        routeResult,
        invoiceResult,
        invoiceSettingResult,
        paymentResult,
        refundResult,
        invoiceRecordResult,
        subplatformResult,
      ]) => {
        if (!mounted) return;
        // Payment administration is intentionally allowed to be unavailable while the first
        // Better Auth session is still settling; the setup card remains useful in that state.
        if (gatewayResult.status === "fulfilled")
          setGateways(gatewayResult.value);
        if (routeResult.status === "fulfilled")
          setPaymentRoutes(routeResult.value);
        if (invoiceResult.status === "fulfilled")
          setInvoiceProviders(invoiceResult.value);
        if (invoiceSettingResult.status === "fulfilled")
          setInvoiceSetting(invoiceSettingResult.value);
        if (paymentResult.status === "fulfilled")
          setPayments(paymentResult.value);
        if (refundResult.status === "fulfilled") setRefunds(refundResult.value);
        if (invoiceRecordResult.status === "fulfilled")
          setInvoices(invoiceRecordResult.value);
        if (subplatformResult.status === "fulfilled")
          setSubplatforms(subplatformResult.value);
      },
    );
    return () => {
      mounted = false;
    };
  }, [rootRole]);

  useEffect(() => {
    if (!subplatformDomainId && setup?.domains[0])
      setSubplatformDomainId(setup.domains[0].id);
  }, [setup, subplatformDomainId]);

  const refreshPaymentAdministration = async () => {
    const [
      nextGateways,
      nextRoutes,
      nextInvoiceProviders,
      nextInvoiceSetting,
      nextPayments,
      nextRefunds,
      nextInvoices,
    ] = await Promise.all([
      getPaymentGateways(),
      getPaymentRoutes(),
      getInvoiceProviders(),
      getInvoiceSetting(),
      getPaymentAdminRecords(),
      getRefundAdminRecords(),
      getInvoiceAdminRecords(),
    ]);
    setGateways(nextGateways);
    setPaymentRoutes(nextRoutes);
    setInvoiceProviders(nextInvoiceProviders);
    setInvoiceSetting(nextInvoiceSetting);
    setPayments(nextPayments);
    setRefunds(nextRefunds);
    setInvoices(nextInvoices);
  };

  const submitRefund = async () => {
    const tenantId = setup?.root.tenantId;
    if (
      !tenantId ||
      !refundPaymentId ||
      !refundAmount.trim() ||
      !refundReason.trim()
    ) {
      onNotice("请选择可退款支付单，并填写退款金额和原因");
      return;
    }
    setRefundSaving(true);
    try {
      await createAdminRefund({
        tenantId,
        paymentId: refundPaymentId,
        amount: refundAmount.trim(),
        reason: refundReason.trim(),
      });
      await refreshPaymentAdministration();
      setRefundAmount("");
      setRefundReason("");
      onNotice("退款请求已提交；最终状态以支付网关回调和对账为准");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "退款请求提交失败");
    } finally {
      setRefundSaving(false);
    }
  };

  const refreshSubplatforms = async () => {
    setSubplatforms(await getSubplatformOrganizations());
  };

  const refreshDomains = async () => {
    const [status, records] = await Promise.all([
      getPlatformSetupStatus(),
      getPlatformDomains(),
    ]);
    setSetup(status);
    setDomains(records);
  };

  const initializeRootOrganization = async () => {
    if (!setup?.root.tenantExists || !setup.root.tenant) {
      onNotice("根商城尚未由部署工具创建，暂时不能在网页中继续初始化");
      return;
    }
    if (rootRole !== "rootSuperAdmin") {
      onNotice("只有商城负责人可以创建根商城组织");
      return;
    }
    setSaving(true);
    try {
      const organization = await createRootPlatformOrganization({
        name: setup.root.tenant.name,
        slug: setup.root.tenant.slug,
      });
      await refreshDomains();
      onNotice(`商城组织“${organization.name}”已创建`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "商城组织创建失败");
    } finally {
      setSaving(false);
    }
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
    if (!setup?.root.tenantId) {
      onNotice("商城尚未完成初始化，暂时不能接入店铺");
      return;
    }
    if (!subplatformDomainId) {
      onNotice("商城内部数据尚未初始化，请先完成商城初始化");
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

      if (!hasManualRegistration) {
        setSubplatformDiscoveryState("正在提交到隔离构建器…");
        const intake = await discoverSubplatformSource({
          domainId: subplatformDomainId,
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
      } else {
        try {
          const parsed = JSON.parse(subplatformManifest);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          manifest = parsed as Record<string, unknown>;
        } catch {
          onNotice("manifest 必须是 JSON 对象");
          return;
        }
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
        tenantId: setup.root.tenantId,
        domainId: subplatformDomainId,
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
    setSubplatformDomainId(
      organization.domainId || setup?.domains[0]?.id || "",
    );
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

  const submitPaymentRoute = async () => {
    const priority = Number.parseInt(routePriority, 10);
    if (!routeGatewayId) {
      onNotice("请先选择一个已保存的支付网关");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._:-]{1,63}$/i.test(routeMethodCode.trim())) {
      onNotice("支付方式编码只能包含字母、数字、点、下划线、冒号或短横线");
      return;
    }
    if (!/^[A-Z]{3}$/.test(routeCurrency.trim().toUpperCase())) {
      onNotice("币种必须是 3 位 ISO 4217 编码");
      return;
    }
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 10_000) {
      onNotice("优先级必须是 0 到 10000 的整数");
      return;
    }
    setSaving(true);
    try {
      await savePaymentRoute({
        gatewayId: routeGatewayId,
        methodCode: routeMethodCode.trim(),
        currency: routeCurrency.trim().toUpperCase(),
        priority,
        enabled: true,
        reason: "platform dashboard create payment route",
      });
      await refreshPaymentAdministration();
      setRouteEditorOpen(false);
      setRouteMethodCode("");
      setRouteCurrency("");
      setRoutePriority("100");
      onNotice("支付路由已保存；切换生产模式前请完成网关健康检查");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "支付路由保存失败");
    } finally {
      setSaving(false);
    }
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

  const submitGateway = async () => {
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(gatewaySettings);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch {
      onNotice("支付网关 settings 必须是 JSON 对象");
      return;
    }
    if (!gatewayName.trim()) {
      onNotice("请填写支付网关名称");
      return;
    }
    if (gatewayMode === "production" && !gatewayCredentialRef.trim()) {
      onNotice("生产网关必须填写 secret reference；不接受明文密钥");
      return;
    }
    setSaving(true);
    try {
      await savePaymentGateway({
        name: gatewayName.trim(),
        kind: gatewayKind,
        mode: gatewayMode,
        settings,
        credentialSecretRef: gatewayCredentialRef.trim() || undefined,
        enabled: true,
        reason: "platform dashboard create gateway",
      });
      await refreshPaymentAdministration();
      setGatewayEditorOpen(false);
      setGatewayName("");
      setGatewayCredentialRef("");
      setGatewaySettings("{}");
      onNotice("支付网关已保存；请继续配置支付路由后再切换生产模式");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "支付网关保存失败");
    } finally {
      setSaving(false);
    }
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
      await refreshPaymentAdministration();
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
          <div className="platform-layout">
            <section
              id="platform-panel-home"
              className="platform-component-panel"
              role="tabpanel"
              aria-labelledby="platform-tab-home"
              hidden={activeSection !== "home"}
            >
              <MallInitializationPanel
                setup={setup}
                rootRole={rootRole}
                aiStatus={aiStatus}
                saving={saving}
                onInitializeRoot={() => void initializeRootOrganization()}
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
              <WeChatLoginConfigPanel
                rootRole={rootRole}
                onNotice={onNotice}
              />
              <PhoneLoginConfigPanel rootRole={rootRole} onNotice={onNotice} />
              <PlatformSiteSettingsPanel
                organizationId={setup?.root.organization?.id}
                platformPath="/"
                platformName={setup?.root.organization?.name || "商城"}
                onNotice={onNotice}
              />
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
                    !setup?.root.organization?.id ||
                    !setup.domains.length
                  }
                  title={
                    !setup?.root.organization?.id
                      ? "商城尚未完成初始化"
                      : !setup.domains.length
                        ? "商城数据尚未准备好"
                        : undefined
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
                          disabled={saving}
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
                          disabled={saving}
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
                        !setup?.root.tenantId ||
                        !setup.root.organization?.id ||
                        !setup?.domains.length
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
              <RemoteStoreOnboarding domains={domains} onNotice={onNotice} />
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
              <SectionHeading
                eyebrow="可选能力"
                title="线上支付网关"
                action="配置网关"
                onAction={() => setGatewayEditorOpen(true)}
              />
              <div className="gateway-list">
                {gateways.length ? (
                  gateways.map((gateway) => (
                    <div className="gateway-row" key={gateway.gateway_id}>
                      <span className="gateway-row-icon">
                        <CreditCard size={18} aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{gateway.name}</strong>
                        <small>
                          {gateway.kind} · {gateway.mode} · v{gateway.version}
                        </small>
                      </span>
                      <b
                        className={
                          gateway.enabled ? "status-chip is-on" : "status-chip"
                        }
                      >
                        {gateway.enabled ? "启用" : "停用"}
                      </b>
                    </div>
                  ))
                ) : (
                  <div className="gateway-empty">
                    <CreditCard size={24} aria-hidden="true" />
                    <strong>暂不使用线上支付</strong>
                    <p>
                      这不会阻断撮合。默认在双方同意后交换微信和手机号；需要平台内收款时再配置网关。
                    </p>
                    <button
                      type="button"
                      onClick={() => setGatewayEditorOpen(true)}
                    >
                      打开配置
                    </button>
                  </div>
                )}
              </div>
              {gatewayEditorOpen ? (
                <div className="admin-editor" aria-label="支付网关配置">
                  <div className="admin-editor-heading">
                    <strong>新增支付网关</strong>
                    <button
                      type="button"
                      onClick={() => setGatewayEditorOpen(false)}
                    >
                      关闭
                    </button>
                  </div>
                  <label>
                    <span>名称</span>
                    <input
                      value={gatewayName}
                      onChange={(event) => setGatewayName(event.target.value)}
                      placeholder="例如：微信支付主商户"
                    />
                  </label>
                  <label>
                    <span>协议</span>
                    <select
                      value={gatewayKind}
                      onChange={(event) =>
                        setGatewayKind(
                          event.target.value as PaymentGatewayRecord["kind"],
                        )
                      }
                    >
                      <option value="test">测试网关</option>
                      <option value="epay">EPay</option>
                      <option value="waffo_pancake">Waffo Pancake</option>
                      <option value="wechat_pay_v3">微信支付 API v3</option>
                      <option value="alipay_openapi">支付宝 OpenAPI</option>
                    </select>
                  </label>
                  <label>
                    <span>模式</span>
                    <select
                      value={gatewayMode}
                      onChange={(event) =>
                        setGatewayMode(
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
                      value={gatewayCredentialRef}
                      onChange={(event) =>
                        setGatewayCredentialRef(event.target.value)
                      }
                      placeholder="file:///run/secrets/payment/wechat.json"
                    />
                  </label>
                  <label>
                    <span>settings（JSON）</span>
                    <textarea
                      value={gatewaySettings}
                      onChange={(event) =>
                        setGatewaySettings(event.target.value)
                      }
                      rows={4}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    className="button button-dark"
                    type="button"
                    disabled={saving}
                    onClick={() => void submitGateway()}
                  >
                    {saving ? "保存中…" : "保存网关"}
                  </button>
                </div>
              ) : null}
              <div className="route-manager">
                <div className="subsection-heading">
                  <div>
                    <p className="eyebrow">路由矩阵</p>
                    <strong>支付方式与币种</strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRouteEditorOpen((open) => !open)}
                  >
                    {routeEditorOpen ? "关闭配置" : "配置路由"}
                  </button>
                </div>
                {paymentRoutes.length ? (
                  <div className="route-list" aria-label="已配置支付路由">
                    {paymentRoutes.map((route) => {
                      const gateway = gateways.find(
                        (item) => item.gateway_id === route.gateway_id,
                      );
                      return (
                        <div className="route-row" key={route.route_id}>
                          <span>
                            <strong>{route.method_code}</strong>
                            <small>
                              {gateway?.name || route.gateway_id} ·{" "}
                              {route.currency} · 优先级 {route.priority}
                            </small>
                          </span>
                          <b
                            className={
                              route.enabled
                                ? "status-chip is-on"
                                : "status-chip"
                            }
                          >
                            {route.enabled ? "启用" : "停用"}
                          </b>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="route-empty">
                    线上支付为可选；添加网关后，再为微信支付、支付宝或其他协议指定币种。
                  </p>
                )}
                {routeEditorOpen ? (
                  <div
                    className="admin-editor route-editor"
                    aria-label="支付路由配置"
                  >
                    <div className="admin-editor-heading">
                      <strong>新增支付路由</strong>
                      <button
                        type="button"
                        onClick={() => setRouteEditorOpen(false)}
                      >
                        关闭
                      </button>
                    </div>
                    <label>
                      <span>支付网关</span>
                      <select
                        value={routeGatewayId}
                        onChange={(event) =>
                          setRouteGatewayId(event.target.value)
                        }
                      >
                        <option value="">选择已保存的网关</option>
                        {gateways.map((gateway) => (
                          <option
                            key={gateway.gateway_id}
                            value={gateway.gateway_id}
                          >
                            {gateway.name} · {gateway.kind}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>方式编码</span>
                      <input
                        value={routeMethodCode}
                        onChange={(event) =>
                          setRouteMethodCode(event.target.value)
                        }
                        placeholder="由网关协议定义"
                      />
                    </label>
                    <div className="route-editor-grid">
                      <label>
                        <span>币种</span>
                        <input
                          value={routeCurrency}
                          onChange={(event) =>
                            setRouteCurrency(event.target.value.toUpperCase())
                          }
                          maxLength={3}
                          placeholder="ISO 4217"
                        />
                      </label>
                      <label>
                        <span>优先级</span>
                        <input
                          value={routePriority}
                          onChange={(event) =>
                            setRoutePriority(event.target.value)
                          }
                          inputMode="numeric"
                        />
                      </label>
                    </div>
                    <button
                      className="button button-dark"
                      type="button"
                      disabled={saving || !gateways.length}
                      onClick={() => void submitPaymentRoute()}
                    >
                      {saving ? "保存中…" : "保存路由"}
                    </button>
                  </div>
                ) : null}
              </div>
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
              <div className="finance-empty">
                <ReceiptText size={22} aria-hidden="true" />
                {payments.length || invoices.length || refunds.length ? (
                  <p>
                    最近记录：{payments.length} 笔支付、{invoices.length}{" "}
                    张发票、{refunds.length} 笔退款。
                  </p>
                ) : (
                  <p>暂无财务记录；接入支付服务后，这里会显示真实事件。</p>
                )}
              </div>
              {(financeView === "invoices" ? invoices : refunds).length ? (
                <div
                  className="finance-record-list"
                  aria-label={
                    financeView === "invoices" ? "最近发票" : "最近退款"
                  }
                >
                  {(financeView === "invoices" ? invoices : refunds)
                    .slice(0, 5)
                    .map((record) => {
                      const invoice =
                        financeView === "invoices"
                          ? (record as InvoiceAdminRecord)
                          : null;
                      const refund =
                        financeView === "refunds"
                          ? (record as RefundAdminRecord)
                          : null;
                      return (
                        <div
                          className="finance-record-row"
                          key={invoice?.invoice_id ?? refund?.refund_id}
                        >
                          <span>
                            <strong>
                              {invoice
                                ? invoice.invoice_number || invoice.kind
                                : `退款 ${refund?.payment_id.slice(0, 8)}`}
                            </strong>
                            <small>
                              {invoice
                                ? `${invoice.status} · ${invoice.amount} ${invoice.currency}`
                                : `${refund?.status} · ${refund?.amount} ${refund?.currency}`}
                            </small>
                          </span>
                          <time
                            dateTime={invoice?.updated_at ?? refund?.updated_at}
                          >
                            {new Date(
                              invoice?.updated_at ??
                                refund?.updated_at ??
                                Date.now(),
                            ).toLocaleDateString("zh-CN")}
                          </time>
                        </div>
                      );
                    })}
                </div>
              ) : null}
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
              <div className="finance-actions">
                <button
                  type="button"
                  onClick={() => setInvoiceEditorOpen(true)}
                >
                  <ReceiptText size={18} aria-hidden="true" />
                  <span>
                    <strong>发票管理</strong>
                    <small>配置与切换真实 provider</small>
                  </span>
                </button>
                <button type="button" onClick={() => setFinanceView("refunds")}>
                  <BanknoteArrowDown size={18} aria-hidden="true" />
                  <span>
                    <strong>退款管理</strong>
                    <small>选择支付单后执行退款</small>
                  </span>
                </button>
              </div>
              {financeView === "refunds" ? (
                <div
                  className="admin-editor refund-editor"
                  aria-label="创建退款"
                >
                  <div className="admin-editor-heading">
                    <strong>提交退款</strong>
                    <small>
                      支持全额或部分退款；网关能力不足时会明确返回失败
                    </small>
                  </div>
                  {payments.some((payment) => payment.status === "captured") ? (
                    <>
                      <label>
                        <span>支付单</span>
                        <select
                          value={refundPaymentId}
                          onChange={(event) =>
                            setRefundPaymentId(event.target.value)
                          }
                        >
                          <option value="">选择已捕获支付</option>
                          {payments
                            .filter((payment) => payment.status === "captured")
                            .map((payment) => (
                              <option
                                key={payment.payment_id}
                                value={payment.payment_id}
                              >
                                {payment.merchant_order_id ||
                                  payment.payment_id}{" "}
                                · {payment.captured_amount} {payment.currency}
                              </option>
                            ))}
                        </select>
                      </label>
                      <div className="subplatform-form-grid">
                        <label>
                          <span>退款金额</span>
                          <input
                            value={refundAmount}
                            onChange={(event) =>
                              setRefundAmount(event.target.value)
                            }
                            inputMode="decimal"
                            placeholder="按支付单币种填写"
                          />
                        </label>
                        <label>
                          <span>退款原因</span>
                          <input
                            value={refundReason}
                            onChange={(event) =>
                              setRefundReason(event.target.value)
                            }
                            maxLength={2000}
                            placeholder="说明退款原因"
                          />
                        </label>
                      </div>
                      <button
                        className="button button-dark"
                        type="button"
                        disabled={refundSaving}
                        onClick={() => void submitRefund()}
                      >
                        {refundSaving ? "提交中…" : "提交退款"}
                      </button>
                    </>
                  ) : (
                    <p className="platform-access-empty">
                      暂无已捕获且可退款的支付单。
                    </p>
                  )}
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

function MallInitializationPanel({
  setup,
  rootRole,
  aiStatus,
  saving,
  onInitializeRoot,
  onOpenStores,
  onOpenSettings,
  onOpenAi,
}: {
  setup: PlatformSetupStatus | null;
  rootRole?: string | null;
  aiStatus: PlatformAiStatus | null;
  saving: boolean;
  onInitializeRoot: () => void;
  onOpenStores: (openScope: boolean) => void;
  onOpenSettings: () => void;
  onOpenAi: () => void;
}) {
  const rootReady = Boolean(setup?.root.organization);
  const scopeReady = Boolean(setup?.domains.length);
  const firstStoreReady = (setup?.routing.activeChildren ?? 0) > 0;
  const aiReady = aiStatus?.router.configured === true;

  return (
    <section
      className="surface mall-initialization"
      aria-labelledby="mall-initialization-title"
    >
      <h2 id="mall-initialization-title">开始配置商城</h2>
      <p>按顺序完成下面几项，访客就能浏览店铺并使用 AI 导购。</p>
      <ol className="mall-initialization-list">
        <li className={rootReady ? "is-complete" : ""}>
          <div>
            <strong>商城组织</strong>
            <small>{rootReady ? "已就绪" : "建立商城团队和管理边界"}</small>
          </div>
          {rootReady ? (
            <span>已完成</span>
          ) : setup?.root.tenantExists && rootRole === "rootSuperAdmin" ? (
            <button type="button" disabled={saving} onClick={onInitializeRoot}>
              {saving ? "创建中…" : "创建"}
            </button>
          ) : (
            <span>
              {setup?.root.tenantExists
                ? "需要商城负责人"
                : "请先完成服务器初始化"}
            </span>
          )}
        </li>
        <li className={scopeReady ? "is-complete" : ""}>
          <div>
            <strong>商城数据</strong>
            <small>
              {scopeReady
                ? "店铺与商品数据已准备好"
                : "完成初始化后即可接入店铺"}
            </small>
          </div>
          {scopeReady ? (
            <button type="button" onClick={() => onOpenStores(true)}>
              管理
            </button>
          ) : (
            <button
              type="button"
              disabled={!rootReady}
              onClick={() => onOpenStores(true)}
            >
              创建
            </button>
          )}
        </li>
        <li>
          <div>
            <strong>商城设置</strong>
            <small>品牌、用户协议、隐私政策和账号邮件。</small>
          </div>
          <button type="button" disabled={!rootReady} onClick={onOpenSettings}>
            配置
          </button>
        </li>
        <li className={aiReady ? "is-complete" : ""}>
          <div>
            <strong>AI 导购</strong>
            <small>
              {aiReady ? "已连接模型服务" : "连接模型后，访客即可询问和选购"}
            </small>
          </div>
          <button type="button" onClick={onOpenAi}>
            {aiReady ? "查看" : "配置"}
          </button>
        </li>
        <li className={firstStoreReady ? "is-complete" : ""}>
          <div>
            <strong>第一家店铺</strong>
            <small>
              {firstStoreReady
                ? "已有公开可浏览的店铺"
                : "接入本地或远程店铺，并审核商品"}
            </small>
          </div>
          <button
            type="button"
            disabled={!scopeReady}
            onClick={() => onOpenStores(false)}
          >
            {firstStoreReady ? "管理" : "接入"}
          </button>
        </li>
      </ol>
    </section>
  );
}
