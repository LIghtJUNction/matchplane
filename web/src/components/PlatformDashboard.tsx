import { useEffect, useState } from "react";
import {
  Archive,
  BanknoteArrowDown,
  CreditCard,
  FileCheck2,
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
  testPlatformAi,
  getSubplatformOrganizations,
  getRefundAdminRecords,
  createAdminRefund,
  isLiveMarketplaceEnabled,
  activateSubplatform,
  createPlatformDomain,
  discoverSubplatformSource,
  getPlatformDomains,
  getSubplatformSourceIntake,
  registerSubplatform,
  saveInvoiceProvider,
  savePaymentGateway,
  savePaymentRoute,
  switchInvoiceMode,
  updatePlatformDomain,
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
import { ModeDialog } from "./Overlays";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { PlatformSiteSettingsPanel } from "./PlatformSiteSettingsPanel";
import { RootEmailConfigPanel } from "./RootEmailConfigPanel";
import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";
import { MallCatalogModeration } from "./MallCatalogModeration";
import { MallBrandPanel } from "./MallBrandPanel";
import { StoreCommercialTermsPanel } from "./StoreCommercialTermsPanel";
import { SectionHeading } from "./Primitives";

interface PlatformDashboardProps {
  paymentMode: "test" | "production";
  rootRole?: string | null;
  onRequestModeChange: () => void;
  onBrandUpdated?: (brand: { name: string; logoUrl: string | null }) => void;
  onNotice: (message: string) => void;
}

type PlatformSection = "brand" | "tree" | "access" | "payments" | "finance" | "site";

export function PlatformDashboard({
  paymentMode,
  rootRole,
  onRequestModeChange,
  onBrandUpdated,
  onNotice,
}: PlatformDashboardProps) {
  const [setup, setSetup] = useState<PlatformSetupStatus | null>(null);
  const [activeSection, setActiveSection] = useState<PlatformSection>("access");
  const [aiStatus, setAiStatus] = useState<PlatformAiStatus | null>(null);
  const [domains, setDomains] = useState<PlatformDomainRecord[]>([]);
  const [subplatforms, setSubplatforms] = useState<SubplatformOrganizationRecord[]>([]);
  const [gateways, setGateways] = useState<PaymentGatewayRecord[]>([]);
  const [paymentRoutes, setPaymentRoutes] = useState<PaymentRouteRecord[]>([]);
  const [invoiceProviders, setInvoiceProviders] = useState<InvoiceProviderRecord[]>([]);
  const [invoiceSetting, setInvoiceSetting] = useState<InvoiceSetting | null>(null);
  const [payments, setPayments] = useState<PaymentAdminRecord[]>([]);
  const [refunds, setRefunds] = useState<RefundAdminRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAdminRecord[]>([]);
  const [financeView, setFinanceView] = useState<"invoices" | "refunds">("invoices");
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundSaving, setRefundSaving] = useState(false);
  const [gatewayEditorOpen, setGatewayEditorOpen] = useState(false);
  const [routeEditorOpen, setRouteEditorOpen] = useState(false);
  const [invoiceEditorOpen, setInvoiceEditorOpen] = useState(false);
  const [invoiceModeDialogOpen, setInvoiceModeDialogOpen] = useState(false);
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayKind, setGatewayKind] = useState<PaymentGatewayRecord["kind"]>("test");
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
  const [domainSlug, setDomainSlug] = useState("");
  const [domainName, setDomainName] = useState("");
  const [subplatformEditorOpen, setSubplatformEditorOpen] = useState(false);
  const [subplatformSourceKind, setSubplatformSourceKind] = useState<"git" | "archive">("git");
  const [subplatformDomainId, setSubplatformDomainId] = useState("");
  const [subplatformPackageId, setSubplatformPackageId] = useState("");
  const [subplatformSlug, setSubplatformSlug] = useState("");
  const [subplatformSourceLocator, setSubplatformSourceLocator] = useState("");
  const [subplatformPinnedRevision, setSubplatformPinnedRevision] = useState("");
  const [subplatformSourceDigest, setSubplatformSourceDigest] = useState("");
  // The root platform never ships a sample market manifest. Operators paste or upload the
  // manifest that belongs to the package they are registering; domain data stays in that package.
  const [subplatformManifest, setSubplatformManifest] = useState("");
  const [subplatformScopes, setSubplatformScopes] = useState("");
  const [subplatformMembershipPolicy, setSubplatformMembershipPolicy] = useState<"public" | "invite">("public");
  const [subplatformArchive, setSubplatformArchive] = useState<File | null>(null);
  const [subplatformUpload, setSubplatformUpload] = useState<SubplatformArchiveUpload | null>(null);
  const [subplatformDiscoveryState, setSubplatformDiscoveryState] = useState("");
  const accessOrganizations: SubplatformOrganizationRecord[] = [
    ...(setup?.root.organization ? [
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
    ] : []),
    ...subplatforms.filter((organization) => organization.id !== setup?.root.organization?.id),
  ];

  useEffect(() => {
    if (!rootRole) return;
    let mounted = true;
    void Promise.allSettled([getPlatformSetupStatus(), getPlatformDomains(), getPlatformAiStatus()])
      .then(([statusResult, domainsResult, aiResult]) => {
        if (!mounted) return;
        if (statusResult.status === "fulfilled") {
          setSetup(statusResult.value);
        }
        // A fresh deployment can report its bounded setup state before a root tenant exists.
        // Keep that useful state visible instead of turning the whole admin panel into a generic
        // error just because the domain endpoint correctly returned 503.
        setDomains(domainsResult.status === "fulfilled" ? domainsResult.value : []);
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
    ])
      .then(([gatewayResult, routeResult, invoiceResult, invoiceSettingResult, paymentResult, refundResult, invoiceRecordResult, subplatformResult]) => {
        if (!mounted) return;
        // Payment administration is intentionally allowed to be unavailable while the first
        // Better Auth session is still settling; the setup card remains useful in that state.
        if (gatewayResult.status === "fulfilled") setGateways(gatewayResult.value);
        if (routeResult.status === "fulfilled") setPaymentRoutes(routeResult.value);
        if (invoiceResult.status === "fulfilled") setInvoiceProviders(invoiceResult.value);
        if (invoiceSettingResult.status === "fulfilled") setInvoiceSetting(invoiceSettingResult.value);
        if (paymentResult.status === "fulfilled") setPayments(paymentResult.value);
        if (refundResult.status === "fulfilled") setRefunds(refundResult.value);
        if (invoiceRecordResult.status === "fulfilled") setInvoices(invoiceRecordResult.value);
        if (subplatformResult.status === "fulfilled") setSubplatforms(subplatformResult.value);
      });
    return () => {
      mounted = false;
    };
  }, [rootRole]);

  useEffect(() => {
    if (!subplatformDomainId && setup?.domains[0]) setSubplatformDomainId(setup.domains[0].id);
  }, [setup, subplatformDomainId]);

  const refreshPaymentAdministration = async () => {
    const [nextGateways, nextRoutes, nextInvoiceProviders, nextInvoiceSetting, nextPayments, nextRefunds, nextInvoices] = await Promise.all([
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

  const testAiConnection = async () => {
    setAiTesting(true);
    try {
      const result = await testPlatformAi();
      setAiStatus(await getPlatformAiStatus());
      onNotice(`${result.message}${result.latencyMs ? `（${result.latencyMs} ms）` : ""}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 连接测试失败");
    } finally {
      setAiTesting(false);
    }
  };

  const submitRefund = async () => {
    const tenantId = setup?.root.tenantId;
    if (!tenantId || !refundPaymentId || !refundAmount.trim() || !refundReason.trim()) {
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
    const [status, records] = await Promise.all([getPlatformSetupStatus(), getPlatformDomains()]);
    setSetup(status);
    setDomains(records);
  };

  const submitDomain = async () => {
    const slug = domainSlug.trim().toLowerCase();
    const name = domainName.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      onNotice("domain slug 只能使用小写字母、数字和短横线");
      return;
    }
    if (!name || name.length > 200) {
      onNotice("domain 名称必须为 1..200 个字符");
      return;
    }
    setSaving(true);
    try {
      await createPlatformDomain({ slug, name });
      await refreshDomains();
      setDomainSlug("");
      setDomainName("");
      setDomainEditorOpen(false);
      onNotice(`domain ${slug} 已创建`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "domain 创建失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleDomain = async (domain: PlatformDomainRecord) => {
    setSaving(true);
    try {
      await updatePlatformDomain({ id: domain.id, status: domain.status === "active" ? "disabled" : "active" });
      await refreshDomains();
      onNotice(`domain ${domain.slug} 已${domain.status === "active" ? "停用" : "启用"}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "domain 状态更新失败");
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
      onNotice("请先为商城配置一个可用的商品范围");
      return;
    }
    let packageId = subplatformPackageId.trim();
    let slug = subplatformSlug.trim();
    let manifest: Record<string, unknown> | null = null;
    let sourceLocator = subplatformSourceLocator.trim();
    let sourceDigest = subplatformSourceDigest.trim().toLowerCase();
    let pinnedRevision = subplatformPinnedRevision.trim().toLowerCase();
    const requestedScopes = [...new Set(subplatformScopes.split(",").map((scope) => scope.trim()).filter(Boolean))];
    // Supplying the source URL/archive is enough. The isolated builder will read and validate
    // package id, slug, immutable revision, digest and manifest. Manual metadata remains
    // supported for operators who already have a builder-verified package record.
    const hasManualRegistration = Boolean(
      packageId && slug && subplatformManifest.trim() && pinnedRevision && sourceDigest,
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
            discovered.state === "discovering" ? "隔离构建器正在读取 manifest…" : "等待隔离构建器接单…",
          );
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        }
        if (!discovered || discovered.state !== "ready") {
          throw new Error(`隔离构建器尚未完成，请稍后重试（任务 ${intake.intakeId}）`);
        }
        if (!discovered.manifest || typeof discovered.manifest !== "object" || Array.isArray(discovered.manifest)) {
          throw new Error("隔离构建器没有返回有效 manifest");
        }
        manifest = discovered.manifest;
        packageId = discovered.packageId || String(manifest.id || "");
        slug = discovered.slug || String(manifest.slug || "");
        sourceDigest = discovered.sourceDigest?.toLowerCase() || sourceDigest;
        pinnedRevision = discovered.pinnedRevision?.toLowerCase() || pinnedRevision;
        setSubplatformDiscoveryState("manifest 已验证，正在登记店铺…");
      } else {
        try {
          const parsed = JSON.parse(subplatformManifest);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
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
      setSubplatformDiscoveryState(error instanceof Error ? error.message : "店铺来源读取失败");
      onNotice(error instanceof Error ? error.message : "店铺接入失败");
    } finally {
      setSaving(false);
    }
  };

  const activateRegisteredSubplatform = async (organization: SubplatformOrganizationRecord) => {
    if (!organization.registrationId || !organization.buildDigest) {
      onNotice("该版本还没有隔离构建器签发的 build digest");
      return;
    }
    setSaving(true);
    try {
      await activateSubplatform({ registrationId: organization.registrationId, buildDigest: organization.buildDigest });
      await refreshSubplatforms();
      onNotice(`${organization.name} 已激活并加入平台路由`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "店铺启用失败");
    } finally {
      setSaving(false);
    }
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
    const nextMode = invoiceSetting.active_mode === "test" ? "production" : "test";
    void switchInvoiceMode({
      mode: nextMode,
      providerId: invoiceSetting.provider_id ?? undefined,
      expectedVersion: invoiceSetting.version,
      reason: `web-admin switch invoice mode to ${nextMode}`,
    })
      .then((setting) => {
        setInvoiceSetting(setting);
        setInvoiceModeDialogOpen(false);
        onNotice(`发票系统已切换为${setting.active_mode === "test" ? "测试" : "生产"}模式`);
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
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
      onNotice(error instanceof Error ? error.message : "发票 provider 保存失败");
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
          <p className="eyebrow">商城运营</p>
          <h1>商城控制台</h1>
          <p>管理店铺接入、团队、商城外观和可选的线上支付。</p>
        </div>
      </section>

      <div className="platform-admin-shell">
        <nav className="platform-admin-nav" role="tablist" aria-label="商城管理分区">
          <button id="platform-tab-brand" type="button" role="tab" aria-selected={activeSection === "brand"} aria-controls="platform-panel-brand" className={activeSection === "brand" ? "is-active" : ""} onClick={() => setActiveSection("brand")}><Palette size={17} aria-hidden="true" /><span>品牌</span></button>
          <button id="platform-tab-tree" type="button" role="tab" aria-selected={activeSection === "tree"} aria-controls="platform-panel-tree" className={activeSection === "tree" ? "is-active" : ""} onClick={() => setActiveSection("tree")}><GitBranch size={17} aria-hidden="true" /><span>店铺接入</span></button>
          <button id="platform-tab-access" type="button" role="tab" aria-selected={activeSection === "access"} aria-controls="platform-panel-access" className={activeSection === "access" ? "is-active" : ""} onClick={() => setActiveSection("access")}><ShieldCheck size={17} aria-hidden="true" /><span>团队与服务</span></button>
          <button id="platform-tab-payments" type="button" role="tab" aria-selected={activeSection === "payments"} aria-controls="platform-panel-payments" className={activeSection === "payments" ? "is-active" : ""} onClick={() => setActiveSection("payments")}><CreditCard size={17} aria-hidden="true" /><span>支付（可选）</span></button>
          <button id="platform-tab-finance" type="button" role="tab" aria-selected={activeSection === "finance"} aria-controls="platform-panel-finance" className={activeSection === "finance" ? "is-active" : ""} onClick={() => setActiveSection("finance")}><ReceiptText size={17} aria-hidden="true" /><span>财务与退款</span></button>
          <button id="platform-tab-site" type="button" role="tab" aria-selected={activeSection === "site"} aria-controls="platform-panel-site" className={activeSection === "site" ? "is-active" : ""} onClick={() => setActiveSection("site")}><FileCheck2 size={17} aria-hidden="true" /><span>网站与合规</span></button>
        </nav>

        <div className="platform-admin-content">
          <div className="platform-layout">
        <div id="platform-panel-brand" className="platform-component-panel" role="tabpanel" aria-labelledby="platform-tab-brand" hidden={activeSection !== "brand"}>
          <MallBrandPanel rootRole={rootRole} onBrandUpdated={onBrandUpdated} onNotice={onNotice} />
        </div>
        <section className="platform-component-panel" aria-label="AI 与登录配置" hidden={activeSection !== "access"}>
          <PlatformAiConfigPanel rootRole={rootRole} onNotice={onNotice} />
          <RootEmailConfigPanel rootRole={rootRole} onNotice={onNotice} />
        </section>

        <div id="platform-panel-site" className="platform-component-panel" role="tabpanel" aria-labelledby="platform-tab-site" hidden={activeSection !== "site"}>
          <PlatformSiteSettingsPanel
            organizationId={setup?.root.organization?.id}
            platformPath="/"
            platformName={setup?.root.organization?.name || "商城"}
            onNotice={onNotice}
          />
        </div>

        <section id="platform-panel-tree" className="surface subplatform-panel" role="tabpanel" aria-labelledby="platform-tab-tree" hidden={activeSection !== "tree"}>
          <div className="subplatform-header">
            <div>
              <p className="eyebrow">店铺</p>
              <h2 id="subplatform-title">接入一个店铺</h2>
              <p className="subplatform-intro">每个商家对应一个店铺。店铺可以托管在商城内，也可以通过受控接口接入并被 AI 导购检索。</p>
            </div>
            <button
              className="button button-dark"
              type="button"
              disabled={saving || !setup?.root.organization?.id || !setup.domains.length}
              title={!setup?.root.organization?.id ? "商城尚未完成初始化" : !setup.domains.length ? "商城还没有可用的商品范围" : undefined}
              onClick={() => setSubplatformEditorOpen((open) => !open)}
            >
              {subplatformEditorOpen ? "关闭" : "接入店铺"}
            </button>
          </div>
          {subplatforms.length ? (
            <div className="subplatform-list" aria-label="已接入店铺">
              {subplatforms.map((organization) => (
                <div className="subplatform-row" key={organization.id}>
                  <span className="subplatform-row-icon" aria-hidden="true"><Archive size={18} /></span>
                  <span className="subplatform-row-copy">
                    <strong>{organization.name}</strong>
                    <small>店铺地址 /{organization.slug}</small>
                  </span>
                  <span className={`subplatform-state state-${organization.registrationState || "unknown"}`}>
                    {subplatformStateLabel[organization.registrationState || ""] || "未登记"}
                  </span>
                  {organization.buildError ? <small className="subplatform-build-error" title={organization.buildError}>最近失败：{organization.buildError.slice(0, 120)}</small> : null}
                  {organization.registrationState === "ready" && organization.buildDigest ? (
                    <button className="button button-dark subplatform-activate" type="button" disabled={saving} onClick={() => void activateRegisteredSubplatform(organization)}>
                      上线店铺
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="subplatform-empty">
              <GitBranch size={22} aria-hidden="true" />
              <p>还没有接入店铺。</p>
            </div>
          )}
          {subplatformEditorOpen ? (
            <div className="admin-editor subplatform-editor" aria-label="接入店铺">
              <div className="admin-editor-heading">
                <div><strong>接入店铺</strong><small>填写 Git 地址或上传接入包，系统读取店铺自己的页面与商品能力。</small></div>
                <button type="button" onClick={() => setSubplatformEditorOpen(false)}>关闭</button>
              </div>
              <div className="subplatform-source-switch" role="group" aria-label="店铺接入方式">
                <button type="button" className={subplatformSourceKind === "git" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "git"} onClick={() => setSubplatformSourceKind("git")}><GitBranch size={16} aria-hidden="true" />Git 仓库</button>
                <button type="button" className={subplatformSourceKind === "archive" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "archive"} onClick={() => setSubplatformSourceKind("archive")}><Upload size={16} aria-hidden="true" />上传压缩包</button>
              </div>
              {subplatformSourceKind === "git" ? (
                <div className="subplatform-form-grid">
                  <label className="subplatform-form-wide"><span>Git HTTPS 地址（不含凭据）</span><input value={subplatformSourceLocator} onChange={(event) => setSubplatformSourceLocator(event.target.value)} placeholder="https://github.com/example/market.git" inputMode="url" /></label>
                </div>
              ) : (
                <div className="subplatform-upload-box">
                  <label className="file-picker"><Upload size={18} aria-hidden="true" /><span>{subplatformArchive?.name || "选择店铺接入包"}</span><input type="file" accept=".tar.gz,.tgz,.tar.zst,.tzst" onChange={(event) => setSubplatformArchive(event.target.files?.[0] ?? null)} /></label>
                  <p>{subplatformUpload ? `已上传 ${subplatformUpload.originalName} · ${(subplatformUpload.size / 1024 / 1024).toFixed(1)} MiB · digest ${subplatformUpload.sourceDigest.slice(0, 12)}…` : "限制 64 MiB；服务端只保存随机 locator，隔离构建器负责解包与验证。"}</p>
                </div>
              )}
              <div className="subplatform-editor-footer">
                <p><ShieldCheck size={16} aria-hidden="true" />店铺接入包会先完成隔离构建与校验，准备好后再上线。</p>
                {subplatformDiscoveryState ? <small className="subplatform-discovery-state" role="status">{subplatformDiscoveryState}</small> : null}
                <button className="button button-dark" type="button" disabled={saving || !setup?.root.tenantId || !setup.root.organization?.id || !setup?.domains.length} onClick={() => void submitSubplatform()}>{saving ? "接入中…" : "接入并构建"}</button>
              </div>
            </div>
          ) : null}
        </section>

        <div className="platform-component-panel" hidden={activeSection !== "tree"}>
          <MallCatalogModeration onNotice={onNotice} />
        </div>

        <div id="platform-panel-access" className="platform-component-panel" role="tabpanel" aria-labelledby="platform-tab-access" hidden={activeSection !== "access"}>
          <PlatformAccessPanel organizations={accessOrganizations} rootRole={rootRole} onNotice={onNotice} />
        </div>

        <section id="platform-panel-payments" className="surface gateway-panel" role="tabpanel" aria-labelledby="platform-tab-payments" hidden={activeSection !== "payments"}>
          <StoreCommercialTermsPanel rootRole={rootRole} onNotice={onNotice} />
          <div className={`payment-mode-control mode-${paymentMode}`}>
            <div><span className="status-orb" aria-hidden="true" /><span><small>可选线上支付</small><strong>{paymentMode === "test" ? "测试模式" : "生产模式"}</strong></span></div>
            <button type="button" onClick={onRequestModeChange}>切换支付模式</button>
          </div>
          <SectionHeading eyebrow="可选能力" title="线上支付网关" action="配置网关" onAction={() => setGatewayEditorOpen(true)} />
          <div className="gateway-list">
            {gateways.length ? gateways.map((gateway) => (
              <div className="gateway-row" key={gateway.gateway_id}>
                <span className="gateway-row-icon"><CreditCard size={18} aria-hidden="true" /></span>
                <span><strong>{gateway.name}</strong><small>{gateway.kind} · {gateway.mode} · v{gateway.version}</small></span>
                <b className={gateway.enabled ? "status-chip is-on" : "status-chip"}>{gateway.enabled ? "启用" : "停用"}</b>
              </div>
            )) : (
              <div className="gateway-empty">
                <CreditCard size={24} aria-hidden="true" />
                <strong>暂不使用线上支付</strong>
                <p>这不会阻断撮合。默认在双方同意后交换微信和手机号；需要平台内收款时再配置网关。</p>
                <button type="button" onClick={() => setGatewayEditorOpen(true)}>打开配置</button>
              </div>
            )}
          </div>
          {gatewayEditorOpen ? (
            <div className="admin-editor" aria-label="支付网关配置">
              <div className="admin-editor-heading"><strong>新增支付网关</strong><button type="button" onClick={() => setGatewayEditorOpen(false)}>关闭</button></div>
              <label><span>名称</span><input value={gatewayName} onChange={(event) => setGatewayName(event.target.value)} placeholder="例如：微信支付主商户" /></label>
              <label><span>协议</span><select value={gatewayKind} onChange={(event) => setGatewayKind(event.target.value as PaymentGatewayRecord["kind"])}><option value="test">测试网关</option><option value="epay">EPay</option><option value="waffo_pancake">Waffo Pancake</option><option value="wechat_pay_v3">微信支付 API v3</option><option value="alipay_openapi">支付宝 OpenAPI</option></select></label>
              <label><span>模式</span><select value={gatewayMode} onChange={(event) => setGatewayMode(event.target.value as "test" | "production")}><option value="test">测试</option><option value="production">生产</option></select></label>
              <label><span>secret reference</span><input value={gatewayCredentialRef} onChange={(event) => setGatewayCredentialRef(event.target.value)} placeholder="file:///run/secrets/payment/wechat.json" /></label>
              <label><span>settings（JSON）</span><textarea value={gatewaySettings} onChange={(event) => setGatewaySettings(event.target.value)} rows={4} spellCheck={false} /></label>
              <button className="button button-dark" type="button" disabled={saving} onClick={() => void submitGateway()}>{saving ? "保存中…" : "保存网关"}</button>
            </div>
          ) : null}
          <div className="route-manager">
            <div className="subsection-heading">
              <div>
                <p className="eyebrow">路由矩阵</p>
                <strong>支付方式与币种</strong>
              </div>
              <button type="button" onClick={() => setRouteEditorOpen((open) => !open)}>
                {routeEditorOpen ? "关闭配置" : "配置路由"}
              </button>
            </div>
            {paymentRoutes.length ? (
              <div className="route-list" aria-label="已配置支付路由">
                {paymentRoutes.map((route) => {
                  const gateway = gateways.find((item) => item.gateway_id === route.gateway_id);
                  return (
                    <div className="route-row" key={route.route_id}>
                      <span><strong>{route.method_code}</strong><small>{gateway?.name || route.gateway_id} · {route.currency} · 优先级 {route.priority}</small></span>
                      <b className={route.enabled ? "status-chip is-on" : "status-chip"}>{route.enabled ? "启用" : "停用"}</b>
                    </div>
                  );
                })}
              </div>
            ) : <p className="route-empty">线上支付为可选；添加网关后，再为微信支付、支付宝或其他协议指定币种。</p>}
            {routeEditorOpen ? (
              <div className="admin-editor route-editor" aria-label="支付路由配置">
                <div className="admin-editor-heading"><strong>新增支付路由</strong><button type="button" onClick={() => setRouteEditorOpen(false)}>关闭</button></div>
                <label><span>支付网关</span><select value={routeGatewayId} onChange={(event) => setRouteGatewayId(event.target.value)}><option value="">选择已保存的网关</option>{gateways.map((gateway) => <option key={gateway.gateway_id} value={gateway.gateway_id}>{gateway.name} · {gateway.kind}</option>)}</select></label>
                <label><span>方式编码</span><input value={routeMethodCode} onChange={(event) => setRouteMethodCode(event.target.value)} placeholder="由网关协议定义" /></label>
                <div className="route-editor-grid">
                  <label><span>币种</span><input value={routeCurrency} onChange={(event) => setRouteCurrency(event.target.value.toUpperCase())} maxLength={3} placeholder="ISO 4217" /></label>
                  <label><span>优先级</span><input value={routePriority} onChange={(event) => setRoutePriority(event.target.value)} inputMode="numeric" /></label>
                </div>
                <button className="button button-dark" type="button" disabled={saving || !gateways.length} onClick={() => void submitPaymentRoute()}>{saving ? "保存中…" : "保存路由"}</button>
              </div>
            ) : null}
          </div>
        </section>

        <section id="platform-panel-finance" className="surface commission-panel" role="tabpanel" aria-labelledby="platform-tab-finance" hidden={activeSection !== "finance"}>
          <SectionHeading eyebrow="提成模型" title="本月收入构成" />
          <div className="commission-total">
            <span>已确认净收入</span>
            <strong>—</strong>
            <small>等待 API 返回成交与服务费数据</small>
          </div>
          <div className="commission-empty"><HandCoins size={23} aria-hidden="true" /><p>收入构成会按真实成交、线下撮合和增值服务数据生成。</p></div>
          <div className="commission-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>提成按双方确认的最终成交价精确计算，退款时按比例冲回并生成发票更正。</p>
          </div>
        </section>

        <section className="surface finance-activity" aria-labelledby="finance-activity-title" hidden={activeSection !== "finance"}>
          <SectionHeading eyebrow="财务动态" title="支付、发票与退款" action="配置发票" onAction={() => setInvoiceEditorOpen(true)} />
          <div className="finance-empty">
            <ReceiptText size={22} aria-hidden="true" />
            {payments.length || invoices.length || refunds.length
              ? <p>最近记录：{payments.length} 笔支付、{invoices.length} 张发票、{refunds.length} 笔退款。</p>
              : <p>暂无财务记录；接入支付服务后，这里会显示真实事件。</p>}
          </div>
          {(financeView === "invoices" ? invoices : refunds).length ? (
            <div className="finance-record-list" aria-label={financeView === "invoices" ? "最近发票" : "最近退款"}>
              {(financeView === "invoices" ? invoices : refunds).slice(0, 5).map((record) => {
                const invoice = financeView === "invoices" ? record as InvoiceAdminRecord : null;
                const refund = financeView === "refunds" ? record as RefundAdminRecord : null;
                return <div className="finance-record-row" key={invoice?.invoice_id ?? refund?.refund_id}>
                  <span><strong>{invoice ? invoice.invoice_number || invoice.kind : `退款 ${refund?.payment_id.slice(0, 8)}`}</strong><small>{invoice ? `${invoice.status} · ${invoice.amount} ${invoice.currency}` : `${refund?.status} · ${refund?.amount} ${refund?.currency}`}</small></span>
                  <time dateTime={invoice?.updated_at ?? refund?.updated_at}>{new Date(invoice?.updated_at ?? refund?.updated_at ?? Date.now()).toLocaleDateString("zh-CN")}</time>
                </div>;
              })}
            </div>
          ) : null}
          {invoiceProviders.length ? <div className="provider-list">{invoiceProviders.map((provider) => <div className="provider-row" key={provider.provider_id}><span><strong>{provider.name}</strong><small>{provider.provider_key} · {provider.mode}</small></span><b>{provider.enabled ? "启用" : "停用"}</b></div>)}</div> : null}
          <div className="invoice-mode-card">
            <div>
              <p className="eyebrow">发票运行模式</p>
              <strong>{invoiceSetting ? (invoiceSetting.active_mode === "test" ? "测试模式" : "生产模式") : "读取中…"}</strong>
              <small>{invoiceSetting?.provider_id ? "已绑定发票 provider" : "尚未绑定默认 provider"}</small>
            </div>
            <button type="button" disabled={!invoiceSetting} onClick={() => setInvoiceModeDialogOpen(true)}>切换模式</button>
          </div>
          {invoiceEditorOpen ? (
            <div className="admin-editor" aria-label="发票 provider 配置">
              <div className="admin-editor-heading"><strong>新增发票 provider</strong><button type="button" onClick={() => setInvoiceEditorOpen(false)}>关闭</button></div>
              <label><span>名称</span><input value={invoiceName} onChange={(event) => setInvoiceName(event.target.value)} placeholder="例如：电子发票服务" /></label>
              <label><span>provider</span><select value={invoiceProviderKey} onChange={(event) => setInvoiceProviderKey(event.target.value)}><option value="">选择 provider 协议</option><option value="local_test">测试协议</option><option value="http_json">HTTP JSON</option><option value="fapiao_http">Fapiao HTTP</option></select></label>
              <label><span>模式</span><select value={invoiceMode} onChange={(event) => setInvoiceMode(event.target.value as "test" | "production")}><option value="test">测试</option><option value="production">生产</option></select></label>
              <label><span>secret reference</span><input value={invoiceCredentialRef} onChange={(event) => setInvoiceCredentialRef(event.target.value)} placeholder="file:///run/secrets/invoice/provider.token" /></label>
              <label><span>settings（JSON）</span><textarea value={invoiceSettings} onChange={(event) => setInvoiceSettings(event.target.value)} rows={4} spellCheck={false} /></label>
              <button className="button button-dark" type="button" disabled={saving} onClick={() => void submitInvoiceProvider()}>{saving ? "保存中…" : "保存 provider"}</button>
            </div>
          ) : null}
          <div className="finance-actions">
            <button type="button" onClick={() => setInvoiceEditorOpen(true)}>
              <ReceiptText size={18} aria-hidden="true" /><span><strong>发票管理</strong><small>配置与切换真实 provider</small></span>
            </button>
            <button type="button" onClick={() => setFinanceView("refunds")}>
              <BanknoteArrowDown size={18} aria-hidden="true" /><span><strong>退款管理</strong><small>选择支付单后执行退款</small></span>
            </button>
          </div>
          {financeView === "refunds" ? (
            <div className="admin-editor refund-editor" aria-label="创建退款">
              <div className="admin-editor-heading"><strong>提交退款</strong><small>支持全额或部分退款；网关能力不足时会明确返回失败</small></div>
              {payments.some((payment) => payment.status === "captured") ? (
                <>
                  <label><span>支付单</span><select value={refundPaymentId} onChange={(event) => setRefundPaymentId(event.target.value)}><option value="">选择已捕获支付</option>{payments.filter((payment) => payment.status === "captured").map((payment) => <option key={payment.payment_id} value={payment.payment_id}>{payment.merchant_order_id || payment.payment_id} · {payment.captured_amount} {payment.currency}</option>)}</select></label>
                  <div className="subplatform-form-grid">
                    <label><span>退款金额</span><input value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} inputMode="decimal" placeholder="按支付单币种填写" /></label>
                    <label><span>退款原因</span><input value={refundReason} onChange={(event) => setRefundReason(event.target.value)} maxLength={2000} placeholder="说明退款原因" /></label>
                  </div>
                  <button className="button button-dark" type="button" disabled={refundSaving} onClick={() => void submitRefund()}>{refundSaving ? "提交中…" : "提交退款"}</button>
                </>
              ) : <p className="platform-access-empty">暂无已捕获且可退款的支付单。</p>}
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

function routerProtocolLabel(protocol: PlatformAiStatus["router"]["protocol"]): string {
  switch (protocol) {
    case "anthropic-messages":
      return "Anthropic Messages";
    case "gemini-generate-content":
      return "Gemini GenerateContent";
    default:
      return "OpenAI-compatible";
  }
}

function authCapabilitySummary(status: PlatformAiStatus | null): string {
  if (!status) return "正在读取已配置的密码、验证码、Passkey 与第三方登录";
  const labels: string[] = [];
  if (status.auth.password) labels.push("密码");
  if (status.auth.emailOtp) labels.push("邮箱验证码");
  if (status.auth.phoneOtp) labels.push("手机验证码");
  if (status.auth.magicLink) labels.push("免密链接");
  if (status.auth.passkey) labels.push("Passkey");
  labels.push(...status.auth.primary, ...status.auth.fallback);
  return labels.length ? `${labels.join("、")} 可用` : "尚未配置额外登录方式";
}
