import { useEffect, useState } from "react";
import {
  Archive,
  BadgeCheck,
  BanknoteArrowDown,
  CircleDollarSign,
  Clock3,
  CreditCard,
  FileCheck2,
  GitBranch,
  HandCoins,
  ReceiptText,
  RefreshCcw,
  ShieldCheck,
  Upload,
  WalletCards,
} from "lucide-react";
import { motion } from "motion/react";

import {
  getInvoiceAdminRecords,
  getInvoiceSetting,
  getInvoiceProviders,
  getMarketplaceOfferAdminRecords,
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
  activateMarketplaceOffer,
  activateSubplatform,
  createPlatformDomain,
  createRootPlatformOrganization,
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
  type MarketplaceOfferAdminRecord,
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
import { MetricCard, SectionHeading, spring } from "./Primitives";

interface PlatformDashboardProps {
  paymentMode: "test" | "production";
  rootRole?: string | null;
  onRequestModeChange: () => void;
  onNotice: (message: string) => void;
}

export function PlatformDashboard({
  paymentMode,
  rootRole,
  onRequestModeChange,
  onNotice,
}: PlatformDashboardProps) {
  const [setup, setSetup] = useState<PlatformSetupStatus | null>(null);
  const [aiStatus, setAiStatus] = useState<PlatformAiStatus | null>(null);
  const [setupError, setSetupError] = useState(false);
  const [domains, setDomains] = useState<PlatformDomainRecord[]>([]);
  const [subplatforms, setSubplatforms] = useState<SubplatformOrganizationRecord[]>([]);
  const [gateways, setGateways] = useState<PaymentGatewayRecord[]>([]);
  const [paymentRoutes, setPaymentRoutes] = useState<PaymentRouteRecord[]>([]);
  const [invoiceProviders, setInvoiceProviders] = useState<InvoiceProviderRecord[]>([]);
  const [invoiceSetting, setInvoiceSetting] = useState<InvoiceSetting | null>(null);
  const [payments, setPayments] = useState<PaymentAdminRecord[]>([]);
  const [refunds, setRefunds] = useState<RefundAdminRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAdminRecord[]>([]);
  const [offerQueue, setOfferQueue] = useState<MarketplaceOfferAdminRecord[]>([]);
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
  const [subplatformParentId, setSubplatformParentId] = useState("");
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
          setSetupError(false);
        } else {
          setSetupError(true);
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
      getMarketplaceOfferAdminRecords({ status: "draft", limit: 50 }),
      getSubplatformOrganizations(),
    ])
      .then(([gatewayResult, routeResult, invoiceResult, invoiceSettingResult, paymentResult, refundResult, invoiceRecordResult, offerResult, subplatformResult]) => {
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
        if (offerResult.status === "fulfilled") setOfferQueue(offerResult.value);
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

  const refreshOfferQueue = async () => {
    setOfferQueue(await getMarketplaceOfferAdminRecords({ status: "draft", limit: 50 }));
  };

  const activateOffer = async (offer: MarketplaceOfferAdminRecord) => {
    const tenantId = setup?.root.tenantId;
    if (!tenantId || tenantId !== offer.tenant_id) {
      onNotice("供给不属于当前根平台 tenant，未执行激活");
      return;
    }
    setSaving(true);
    try {
      const activated = await activateMarketplaceOffer({ offerId: offer.offer_id, tenantId });
      await refreshOfferQueue();
      onNotice(activated.catalog_sync?.synced === false
        ? `“${offer.display_name}”已激活，但子平台目录尚未同步；请检查 MCP 服务后重试。`
        : `“${offer.display_name}”已激活，进入当前子平台的匹配范围`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "供给激活失败");
    } finally {
      setSaving(false);
    }
  };

  const refreshDomains = async () => {
    const [status, records] = await Promise.all([getPlatformSetupStatus(), getPlatformDomains()]);
    setSetup(status);
    setDomains(records);
  };

  const initializeRootOrganization = async () => {
    setSaving(true);
    try {
      await createRootPlatformOrganization();
      await refreshDomains();
      onNotice("根平台组织已初始化；统一成员、API Key 和 Agent 接入现在可用");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "根平台组织初始化失败");
    } finally {
      setSaving(false);
    }
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
    setSubplatformParentId("");
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
      onNotice("根平台 tenant 尚未配置，暂时不能注册子平台");
      return;
    }
    if (!subplatformDomainId) {
      onNotice("请先在根平台配置一个 active domain");
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
          onNotice("请选择 .tar.gz、.tgz、.tar.zst 或 .tzst 子平台压缩包");
          return;
        }
        const uploaded = await uploadSubplatformArchive(subplatformArchive, subplatformParentId || undefined);
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
          parentOrganizationId: subplatformParentId || undefined,
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
            throw new Error(discovered.error || "隔离构建器拒绝了这个子平台来源");
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
        setSubplatformDiscoveryState("manifest 已验证，正在登记平台节点…");
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
        onNotice("构建器返回的 manifest.id/slug 与平台节点不一致");
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
        parentOrganizationId: subplatformParentId || undefined,
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
      onNotice(`子平台 ${result.slug} 已登记，等待隔离构建器附加 build digest`);
    } catch (error) {
      setSubplatformDiscoveryState(error instanceof Error ? error.message : "子平台源码发现失败");
      onNotice(error instanceof Error ? error.message : "子平台注册失败");
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
      onNotice(error instanceof Error ? error.message : "子平台激活失败");
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

  const identityStatus = setupError
    ? "状态接口不可用"
    : setup?.firstRun.needsRootAccount
      ? "等待根管理员账号"
      : setup && !setup.root.tenantConfigured
        ? "等待 root tenant 配置"
        : setup && !setup.root.tenantExists
          ? "等待 root tenant 初始化"
          : setup && !setup.root.organization
            ? "等待根平台组织"
      : setup
        ? "身份已初始化"
        : "读取部署状态";
  const routingStatus = setupError
      ? "状态接口不可用"
        : setup
          ? setup.routing.ready ? `${setup.routing.activeChildren} 个子平台已激活` : "等待子平台激活"
          : "读取部署状态";
  const hostedAgentStatus = setupError
    ? "状态接口不可用"
    : setup?.hostedAgent.configured
      ? "平台 Agent 已连接"
      : "平台 Agent 使用受控降级";
  const builderStatus = setupError
    ? "构建器状态不可用"
    : setup?.builder?.status === "ready"
      ? "子平台构建器已就绪"
      : setup?.builder?.status === "degraded"
        ? "子平台构建器待补运行时"
        : "子平台构建器未配置";
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
          <p className="eyebrow">平台管理</p>
          <h1>平台管理</h1>
          <p>管理平台树、支付、发票和退款。</p>
        </div>
        <div className={`mode-summary mode-${paymentMode}`}>
          <span className="status-orb" aria-hidden="true" />
          <div><small>当前支付模式</small><strong>{paymentMode === "test" ? "测试模式" : "生产模式"}</strong></div>
          <motion.button
            type="button"
            onClick={onRequestModeChange}
            whileTap={{ scale: 0.94 }}
            transition={spring}
          >
            切换
          </motion.button>
        </div>
      </section>

      <section className="metric-grid" aria-label="平台经营指标">
        <MetricCard icon={CircleDollarSign} label="平台服务费" value="—" detail="等待实时结算数据" tone="cactus" />
        <MetricCard icon={HandCoins} label="完成撮合" value="—" detail="由 API 提供统计" tone="heather" />
        <MetricCard icon={WalletCards} label="待结算" value="—" detail="等待双方确认" />
        <MetricCard icon={RefreshCcw} label="退款率" value="—" detail="由支付服务计算" tone="clay" />
      </section>

      <div className="platform-layout">
        <section className="surface platform-readiness" aria-label="首启与平台树">
          <SectionHeading eyebrow="首启与平台树" title="先确认平台已经准备好" />
          <div className="readiness-grid">
            <div className={setup?.firstRun.needsRootAccount ? "readiness-item readiness-attention" : "readiness-item"}>
              <span aria-hidden="true" />
              <strong>{identityStatus}</strong>
              <small>根管理员验证后才可注册和激活子平台</small>
            </div>
            <div className={setup?.routing.ready ? "readiness-item" : "readiness-item readiness-attention"}>
              <span aria-hidden="true" />
              <strong>{routingStatus}</strong>
              <small>{setup ? `${setup.domains.length} 个可用 domain` : "domain 与注册状态由 API 返回"}</small>
            </div>
            <div className={setup?.hostedAgent.configured ? "readiness-item" : "readiness-item readiness-attention"}>
              <span aria-hidden="true" />
              <strong>{hostedAgentStatus}</strong>
              <small>{setup?.hostedAgent.configured ? "托管模型负责没有自有 Agent 的买家和卖家" : "配置 MATCHPLANE_ROUTER_AI_URL、KEY、MODEL 后启用"}</small>
            </div>
            <div className={setup?.builder?.status === "ready" ? "readiness-item" : "readiness-item readiness-attention"}>
              <span aria-hidden="true" />
              <strong>{builderStatus}</strong>
              <small>{setup?.builder?.status === "ready" ? "Git/归档包会在隔离构建器中生成 immutable artifact" : "配置 builder token、工作目录与 bubblewrap 后再激活新包"}</small>
            </div>
          </div>
          {setup?.firstRun.needsRootAccount ? (
            <a className="button button-dark readiness-action" href="/login?role=platform&next=%2F%3Frole%3Dplatform">去创建或登录根管理员</a>
          ) : null}
          {setup && !setup.root.tenantConfigured ? (
            <p className="readiness-note">请先在服务端运行 <code>matchplane provision-root</code> 配置 root tenant；登录本身不替代租户初始化。</p>
          ) : null}
          {setup?.root.tenantExists && !setup.root.organization ? (
            <button className="button button-light readiness-action" type="button" disabled={saving} onClick={() => void initializeRootOrganization()}>
              {saving ? "初始化中…" : "初始化根平台组织"}
            </button>
          ) : null}
        </section>

        <section className="surface platform-agent-config" aria-label="AI 与登录配置">
          <SectionHeading eyebrow="AI 与登录" title="把真实服务接到这一个管理员入口" />
          <div className="readiness-grid">
            <div className={aiStatus?.router.configured ? "readiness-item" : "readiness-item readiness-attention"}>
              <span aria-hidden="true" />
              <strong>{aiStatus?.router.configured ? `托管 Agent 已连接${aiStatus.router.model ? ` · ${aiStatus.router.model}` : ""}` : "托管 Agent 尚未连接"}</strong>
              <small>{aiStatus?.router.configured ? `${routerProtocolLabel(aiStatus.router.protocol)} · ${aiStatus.router.endpointOrigin || "服务端端点"}` : "把模型网关配置在 web 服务端，浏览器不会接触密钥"}</small>
            </div>
            <div className="readiness-item">
              <span aria-hidden="true" />
              <strong>统一登录已就绪</strong>
              <small>{authCapabilitySummary(aiStatus)}</small>
            </div>
          </div>
          <div className="platform-agent-config-body">
            <p>模型由根平台负责有限路由；子平台检索和领域 Agent 仍由各自 manifest/MCP 端点提供。管理员页面只显示状态，不保存 OAuth 或模型密钥。</p>
            <div className="platform-agent-config-snippets" aria-label="服务端配置项">
              <code>MATCHPLANE_ROUTER_AI_URL=https://your-gateway.example/v1/chat/completions</code>
              <code>MATCHPLANE_ROUTER_AI_KEY=server-secret</code>
              <code>MATCHPLANE_ROUTER_AI_MODEL=provider/model</code>
              <code>MATCHPLANE_ROUTER_AI_PROTOCOL=openai-compatible</code>
              <small>可选协议：openai-compatible、anthropic-messages、gemini-generate-content</small>
            </div>
            <div className="platform-agent-config-actions">
              <button className="button button-light" type="button" disabled={aiTesting || !aiStatus?.router.configured} onClick={() => void testAiConnection()}>
                {aiTesting ? "测试中…" : "测试连接"}
              </button>
              <a className="button button-light" href="/?role=buyer">打开买方对话测试</a>
              <span>{aiStatus?.router.configured ? `每小时上限 ${aiStatus.router.globalRequestsPerHour} 次 · 单次最长 ${Math.round(aiStatus.router.totalTimeoutMs / 1000)} 秒` : "配置后刷新此页，再用买方对话发送一句真实需求"}</span>
            </div>
          </div>
        </section>

        <section className="surface offer-review-panel" aria-labelledby="offer-review-title">
          <SectionHeading
            eyebrow="供给审核"
            title="确认真实资料，再进入买方匹配"
            action="刷新"
            onAction={() => void refreshOfferQueue()}
          />
          <p className="subplatform-intro">根平台只负责审核状态和审计，不解释子平台的 attributes/terms；字段含义由对应子平台自己定义。</p>
          {offerQueue.length ? (
            <div className="offer-review-list" aria-label="待审核供给列表">
              {offerQueue.map((offer) => (
                <article className="offer-review-row" key={offer.offer_id}>
                  <div className="offer-review-copy">
                    <strong>{offer.display_name}</strong>
                    <small>{offer.external_key} · domain {offer.domain_id.slice(0, 8)}… · {formatAdminDate(offer.updated_at)}</small>
                    <details>
                      <summary>查看子平台资料</summary>
                      <pre>{formatOfferJson({ attributes: offer.attributes, terms: offer.terms })}</pre>
                    </details>
                  </div>
                  <button className="button button-dark" type="button" disabled={saving} onClick={() => void activateOffer(offer)}>
                    激活并匹配
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="offer-review-empty">当前没有待审核供给。卖家提交后会先出现在这里。</div>
          )}
        </section>

        <section className="surface domain-panel" aria-labelledby="domain-title">
          <SectionHeading
            eyebrow="平台范围"
            title="管理 domain"
            action={setup?.root.tenantConfigured ? (domainEditorOpen ? "关闭" : "新增 domain") : undefined}
            onAction={() => setDomainEditorOpen((open) => !open)}
          />
          {!setup?.root.tenantConfigured ? <p className="subplatform-intro">root tenant 尚未配置，domain 创建入口会在服务端初始化后出现。</p> : null}
          <p className="subplatform-intro">domain 是平台树挂载和权限隔离的稳定范围；创建后才能把子平台注册到对应路径。</p>
          {domains.length ? (
            <div className="subplatform-list" aria-label="根平台 domain 列表">
              {domains.map((domain) => (
                <div className="subplatform-row" key={domain.id}>
                  <span className="subplatform-row-icon" aria-hidden="true"><GitBranch size={18} /></span>
                  <span className="subplatform-row-copy"><strong>{domain.name}</strong><small>{domain.slug} · v{domain.version}</small></span>
                  <span className={`subplatform-state state-${domain.status}`}>{domain.status === "active" ? "启用" : "停用"}</span>
                  <button className="button button-light subplatform-activate" type="button" disabled={saving} onClick={() => void toggleDomain(domain)}>{domain.status === "active" ? "停用" : "启用"}</button>
                </div>
              ))}
            </div>
          ) : <div className="subplatform-empty"><GitBranch size={22} aria-hidden="true" /><p>还没有 domain；先创建一个平台范围。</p></div>}
          {domainEditorOpen ? (
            <div className="admin-editor" aria-label="新增 domain">
              <div className="admin-editor-heading"><strong>新增平台 domain</strong><button type="button" onClick={() => setDomainEditorOpen(false)}>关闭</button></div>
              <div className="subplatform-form-grid">
                <label><span>slug</span><input value={domainSlug} onChange={(event) => setDomainSlug(event.target.value)} placeholder="例如 marketplace" autoComplete="off" /></label>
                <label><span>名称</span><input value={domainName} onChange={(event) => setDomainName(event.target.value)} placeholder="平台范围名称" /></label>
              </div>
              <button className="button button-dark" type="button" disabled={saving} onClick={() => void submitDomain()}>{saving ? "保存中…" : "创建 domain"}</button>
            </div>
          ) : null}
        </section>

        <PlatformSiteSettingsPanel
          organizationId={setup?.root.organization?.id}
          platformPath="/"
          platformName={setup?.root.organization?.name || "根平台"}
          onNotice={onNotice}
        />

        <section className="surface subplatform-panel" aria-labelledby="subplatform-title">
          <div className="subplatform-header">
            <div>
              <p className="eyebrow">递归平台树</p>
              <h2 id="subplatform-title">把任意市场接入同一个根平台。</h2>
              <p className="subplatform-intro">子平台只提交自己的 manifest、不可变来源和能力声明。根平台负责身份、路由与审计；领域数据、Agent 和检索实现仍由子平台拥有。</p>
            </div>
            <button
              className="button button-dark"
              type="button"
              disabled={saving || !setup?.root.organization?.id || !setup.domains.length}
              title={!setup?.root.organization?.id ? "请先初始化根平台组织" : !setup.domains.length ? "请先创建 active domain" : undefined}
              onClick={() => setSubplatformEditorOpen((open) => !open)}
            >
              {subplatformEditorOpen ? "关闭登记" : "添加子平台"}
            </button>
          </div>
          {subplatforms.length ? (
            <div className="subplatform-list" aria-label="已登记子平台">
              {subplatforms.map((organization) => (
                <div className="subplatform-row" key={organization.id}>
                  <span className="subplatform-row-icon" aria-hidden="true"><Archive size={18} /></span>
                  <span className="subplatform-row-copy">
                    <strong>{organization.name}</strong>
                    <small>/{organization.slug} · {organization.sourceRepository || "来源待构建器解析"}</small>
                  </span>
                  <span className={`subplatform-state state-${organization.registrationState || "unknown"}`}>
                    {subplatformStateLabel[organization.registrationState || ""] || "未登记"}
                  </span>
                  {organization.buildError ? <small className="subplatform-build-error" title={organization.buildError}>最近失败：{organization.buildError.slice(0, 120)}</small> : null}
                  {organization.registrationState === "ready" && organization.buildDigest ? (
                    <button className="button button-dark subplatform-activate" type="button" disabled={saving} onClick={() => void activateRegisteredSubplatform(organization)}>
                      激活路由
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="subplatform-empty">
              <GitBranch size={22} aria-hidden="true" />
              <p>还没有子平台。登记后会先进入隔离构建，再由管理员显式激活。</p>
            </div>
          )}
          {subplatformEditorOpen ? (
            <div className="admin-editor subplatform-editor" aria-label="登记子平台">
              <div className="admin-editor-heading">
                <div><strong>登记一个平台节点</strong><small>填 Git 地址或上传压缩包，隔离构建器会自动读取 manifest。</small></div>
                <button type="button" onClick={() => setSubplatformEditorOpen(false)}>关闭</button>
              </div>
              <div className="subplatform-form-grid">
                <label><span>挂载到</span><select value={subplatformParentId} onChange={(event) => setSubplatformParentId(event.target.value)}><option value="">根平台</option>{subplatforms.map((organization) => <option key={organization.id} value={organization.id}>/{organization.slug} · {organization.name}</option>)}</select></label>
                <label><span>所属 domain</span><select value={subplatformDomainId} onChange={(event) => setSubplatformDomainId(event.target.value)}><option value="">选择 active domain</option>{setup?.domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name} · {domain.slug}</option>)}</select></label>
              </div>
              <div className="subplatform-source-switch" role="group" aria-label="子平台来源类型">
                <button type="button" className={subplatformSourceKind === "git" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "git"} onClick={() => setSubplatformSourceKind("git")}><GitBranch size={16} aria-hidden="true" />Git 仓库</button>
                <button type="button" className={subplatformSourceKind === "archive" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "archive"} onClick={() => setSubplatformSourceKind("archive")}><Upload size={16} aria-hidden="true" />上传压缩包</button>
              </div>
              {subplatformSourceKind === "git" ? (
                <div className="subplatform-form-grid">
                  <label className="subplatform-form-wide"><span>Git HTTPS 地址（不含凭据）</span><input value={subplatformSourceLocator} onChange={(event) => setSubplatformSourceLocator(event.target.value)} placeholder="https://github.com/example/market.git" inputMode="url" /></label>
                </div>
              ) : (
                <div className="subplatform-upload-box">
                  <label className="file-picker"><Upload size={18} aria-hidden="true" /><span>{subplatformArchive?.name || "选择子平台压缩包"}</span><input type="file" accept=".tar.gz,.tgz,.tar.zst,.tzst" onChange={(event) => setSubplatformArchive(event.target.files?.[0] ?? null)} /></label>
                  <p>{subplatformUpload ? `已上传 ${subplatformUpload.originalName} · ${(subplatformUpload.size / 1024 / 1024).toFixed(1)} MiB · digest ${subplatformUpload.sourceDigest.slice(0, 12)}…` : "限制 64 MiB；服务端只保存随机 locator，隔离构建器负责解包与验证。"}</p>
                </div>
              )}
              <div className="subplatform-form-grid">
                <label><span>请求 scopes（逗号分隔）</span><input value={subplatformScopes} onChange={(event) => setSubplatformScopes(event.target.value)} placeholder="marketplace:read,retrieval:query" /></label>
                <label><span>成员加入策略</span><select value={subplatformMembershipPolicy} onChange={(event) => setSubplatformMembershipPolicy(event.target.value as "public" | "invite")}><option value="public">公开映射</option><option value="invite">邀请加入</option></select></label>
              </div>
              <details className="subplatform-advanced-fields">
                <summary>高级：已有构建器验证信息（通常无需填写）</summary>
                <div className="subplatform-form-grid">
                  <label><span>package id</span><input value={subplatformPackageId} onChange={(event) => setSubplatformPackageId(event.target.value)} placeholder="manifest 中的 id" autoComplete="off" /></label>
                  <label><span>slug / 路径</span><input value={subplatformSlug} onChange={(event) => setSubplatformSlug(event.target.value)} placeholder="manifest 中的 slug" autoComplete="off" /></label>
                  <label><span>pinned revision</span><input value={subplatformPinnedRevision} onChange={(event) => setSubplatformPinnedRevision(event.target.value)} placeholder="commit SHA 或 archive digest" spellCheck={false} /></label>
                  <label><span>来源 SHA-256</span><input value={subplatformSourceDigest} onChange={(event) => setSubplatformSourceDigest(event.target.value)} placeholder="构建器验证的 64 位 digest" spellCheck={false} /></label>
                </div>
                <label><span>manifest JSON</span><textarea value={subplatformManifest} onChange={(event) => setSubplatformManifest(event.target.value)} rows={8} spellCheck={false} placeholder="已有完整 manifest 时再粘贴；留空则由隔离构建器从来源读取。" /></label>
              </details>
              <div className="subplatform-editor-footer">
                <p><ShieldCheck size={16} aria-hidden="true" />源码会在隔离构建器中读取和校验；登记不会立即进入路由，需管理员在构建完成后激活。</p>
                {subplatformDiscoveryState ? <small className="subplatform-discovery-state" role="status">{subplatformDiscoveryState}</small> : null}
                <button className="button button-dark" type="button" disabled={saving || !setup?.root.tenantId || !setup.root.organization?.id || !setup?.domains.length} onClick={() => void submitSubplatform()}>{saving ? "提交中…" : "登记并进入构建"}</button>
              </div>
            </div>
          ) : null}
        </section>

        <PlatformAccessPanel organizations={accessOrganizations} rootRole={rootRole} onNotice={onNotice} />

        <section className="surface gateway-panel" aria-labelledby="gateway-title">
          <SectionHeading eyebrow="标准化支付接口" title="支付网关" action="配置网关" onAction={() => setGatewayEditorOpen(true)} />
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
                <strong>尚未配置支付网关</strong>
                <p>选择 EPay、Waffo Pancake、微信支付、支付宝或测试网关。</p>
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
            ) : <p className="route-empty">还没有路由；先保存一个网关，再为微信、支付宝或其他协议指定币种。</p>}
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

        <section className="surface commission-panel" aria-labelledby="commission-title">
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

        <section className="surface finance-activity" aria-labelledby="finance-activity-title">
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

        <section className="operations-strip" aria-label="支付运营状态">
          <div><span><BadgeCheck aria-hidden="true" /></span><p><strong>网关健康</strong><small>等待配置数据</small></p></div>
          <div><span><Clock3 aria-hidden="true" /></span><p><strong>主动对账</strong><small>由支付服务报告</small></p></div>
          <div><span><FileCheck2 aria-hidden="true" /></span><p><strong>审计记录</strong><small>由根平台审计流报告</small></p></div>
        </section>
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

function formatAdminDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function formatOfferJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "资料无法展开";
  }
}
