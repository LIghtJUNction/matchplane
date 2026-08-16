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
  getPaymentAdminRecords,
  getPaymentGateways,
  getPaymentRoutes,
  getPlatformSetupStatus,
  getSubplatformOrganizations,
  getRefundAdminRecords,
  createAdminRefund,
  isLiveMarketplaceEnabled,
  activateSubplatform,
  createPlatformDomain,
  createRootPlatformOrganization,
  getPlatformDomains,
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
  type PlatformDomainRecord,
  type RefundAdminRecord,
  type SubplatformArchiveUpload,
  type SubplatformOrganizationRecord,
} from "../api";
import { ModeDialog } from "./Overlays";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
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
    void Promise.all([getPlatformSetupStatus(), getPlatformDomains()])
      .then(([status, records]) => {
        if (!mounted) return;
        setSetup(status);
        setDomains(records);
      })
      .catch(() => { if (mounted) setSetupError(true); });
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
    const packageId = subplatformPackageId.trim();
    const slug = subplatformSlug.trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(packageId)) {
      onNotice("package id 只能使用小写字母、数字、点、下划线或短横线");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      onNotice("slug 只能使用小写字母、数字和短横线");
      return;
    }
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(subplatformManifest);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      manifest = parsed as Record<string, unknown>;
    } catch {
      onNotice("manifest 必须是 JSON 对象");
      return;
    }
    if (manifest.id !== packageId || manifest.slug !== slug) {
      onNotice("manifest.id 和 manifest.slug 必须分别等于 package id 与 slug");
      return;
    }
    let sourceLocator = subplatformSourceLocator.trim();
    let sourceDigest = subplatformSourceDigest.trim().toLowerCase();
    let pinnedRevision = subplatformPinnedRevision.trim().toLowerCase();
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
        onNotice("请填写 Git HTTPS/SSH 地址或先上传压缩包");
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
      const requestedScopes = [...new Set(subplatformScopes.split(",").map((scope) => scope.trim()).filter(Boolean))];
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
        requestedScopes,
        membershipPolicy: subplatformMembershipPolicy,
      });
      await refreshSubplatforms();
      setSubplatformEditorOpen(false);
      resetSubplatformEditor();
      onNotice(`子平台 ${result.slug} 已登记，等待隔离构建器附加 build digest`);
    } catch (error) {
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
      : setup
        ? "身份已初始化"
        : "读取部署状态";
  const routingStatus = setupError
    ? "状态接口不可用"
      : setup
        ? setup.routing.ready ? `${setup.routing.activeChildren} 个子平台已激活` : "等待子平台激活"
        : "读取部署状态";
  const subplatformStateLabel: Record<string, string> = {
    active: "已激活",
    ready: "构建完成",
    building: "构建中",
    validated: "已登记，待构建",
    failed: "构建失败",
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
          </div>
          {setup?.firstRun.needsRootAccount ? (
            <a className="button button-dark readiness-action" href="/login?role=platform&next=%2F%3Frole%3Dplatform">去创建或登录根管理员</a>
          ) : null}
          {setup?.root.tenantExists && !setup.root.organization ? (
            <button className="button button-light readiness-action" type="button" disabled={saving} onClick={() => void initializeRootOrganization()}>
              {saving ? "初始化中…" : "初始化根平台组织"}
            </button>
          ) : null}
        </section>

        <section className="surface domain-panel" aria-labelledby="domain-title">
          <SectionHeading eyebrow="平台范围" title="管理 domain" action={domainEditorOpen ? "关闭" : "新增 domain"} onAction={() => setDomainEditorOpen((open) => !open)} />
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

        <section className="surface subplatform-panel" aria-labelledby="subplatform-title">
          <div className="subplatform-header">
            <div>
              <p className="eyebrow">递归平台树</p>
              <h2 id="subplatform-title">把任意市场接入同一个根平台。</h2>
              <p className="subplatform-intro">子平台只提交自己的 manifest、不可变来源和能力声明。根平台负责身份、路由与审计；领域数据、Agent 和检索实现仍由子平台拥有。</p>
            </div>
            <button className="button button-dark" type="button" onClick={() => setSubplatformEditorOpen((open) => !open)}>
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
                <div><strong>登记一个平台节点</strong><small>URL 和压缩包都不会在 Web 进程中执行。</small></div>
                <button type="button" onClick={() => setSubplatformEditorOpen(false)}>关闭</button>
              </div>
              <div className="subplatform-form-grid">
                <label><span>挂载到</span><select value={subplatformParentId} onChange={(event) => setSubplatformParentId(event.target.value)}><option value="">根平台</option>{subplatforms.map((organization) => <option key={organization.id} value={organization.id}>/{organization.slug} · {organization.name}</option>)}</select></label>
                <label><span>所属 domain</span><select value={subplatformDomainId} onChange={(event) => setSubplatformDomainId(event.target.value)}><option value="">选择 active domain</option>{setup?.domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name} · {domain.slug}</option>)}</select></label>
                <label><span>package id</span><input value={subplatformPackageId} onChange={(event) => setSubplatformPackageId(event.target.value)} placeholder="包 manifest 中的 id" autoComplete="off" /></label>
                <label><span>slug / 路径</span><input value={subplatformSlug} onChange={(event) => setSubplatformSlug(event.target.value)} placeholder="包 manifest 中的 slug" autoComplete="off" /></label>
              </div>
              <div className="subplatform-source-switch" role="group" aria-label="子平台来源类型">
                <button type="button" className={subplatformSourceKind === "git" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "git"} onClick={() => setSubplatformSourceKind("git")}><GitBranch size={16} aria-hidden="true" />Git 仓库</button>
                <button type="button" className={subplatformSourceKind === "archive" ? "is-selected" : ""} aria-pressed={subplatformSourceKind === "archive"} onClick={() => setSubplatformSourceKind("archive")}><Upload size={16} aria-hidden="true" />上传压缩包</button>
              </div>
              {subplatformSourceKind === "git" ? (
                <div className="subplatform-form-grid">
                  <label className="subplatform-form-wide"><span>Git HTTPS / SSH 地址（不含凭据）</span><input value={subplatformSourceLocator} onChange={(event) => setSubplatformSourceLocator(event.target.value)} placeholder="https://github.com/example/market.git" inputMode="url" /></label>
                  <label><span>pinned revision</span><input value={subplatformPinnedRevision} onChange={(event) => setSubplatformPinnedRevision(event.target.value)} placeholder="40 位 commit SHA" spellCheck={false} /></label>
                  <label><span>来源 SHA-256</span><input value={subplatformSourceDigest} onChange={(event) => setSubplatformSourceDigest(event.target.value)} placeholder="构建器验证的 64 位 digest" spellCheck={false} /></label>
                </div>
              ) : (
                <div className="subplatform-upload-box">
                  <label className="file-picker"><Upload size={18} aria-hidden="true" /><span>{subplatformArchive?.name || "选择子平台压缩包"}</span><input type="file" accept=".tar.gz,.tgz,.tar.zst,.tzst" onChange={(event) => setSubplatformArchive(event.target.files?.[0] ?? null)} /></label>
                  <p>{subplatformUpload ? `已上传 ${subplatformUpload.originalName} · ${(subplatformUpload.size / 1024 / 1024).toFixed(1)} MiB · digest ${subplatformUpload.sourceDigest.slice(0, 12)}…` : "限制 64 MiB；服务端只保存随机 locator，隔离构建器负责解包与验证。"}</p>
                  <label><span>pinned revision（压缩包可使用 source digest）</span><input value={subplatformPinnedRevision} onChange={(event) => setSubplatformPinnedRevision(event.target.value)} placeholder="上传后自动填入 source digest" spellCheck={false} /></label>
                </div>
              )}
              <div className="subplatform-form-grid">
                <label><span>请求 scopes（逗号分隔）</span><input value={subplatformScopes} onChange={(event) => setSubplatformScopes(event.target.value)} placeholder="marketplace:read,retrieval:query" /></label>
                <label><span>成员加入策略</span><select value={subplatformMembershipPolicy} onChange={(event) => setSubplatformMembershipPolicy(event.target.value as "public" | "invite")}><option value="public">公开映射</option><option value="invite">邀请加入</option></select></label>
              </div>
              <label><span>manifest（来自待注册仓库；根平台不提供示例）</span><textarea value={subplatformManifest} onChange={(event) => setSubplatformManifest(event.target.value)} rows={12} spellCheck={false} placeholder="粘贴仓库中的 matchplane.subplatform.json；业务字段由子平台自己声明。" /></label>
              <div className="subplatform-editor-footer">
                <p><ShieldCheck size={16} aria-hidden="true" />登记不会立即进入路由；只有构建器签发 build digest 后才能激活。</p>
                <button className="button button-dark" type="button" disabled={saving || !setup?.root.tenantId || !setup?.domains.length} onClick={() => void submitSubplatform()}>{saving ? "提交中…" : "登记并进入构建"}</button>
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
