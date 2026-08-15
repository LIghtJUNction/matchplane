import { useEffect, useState } from "react";
import {
  BadgeCheck,
  BanknoteArrowDown,
  CircleDollarSign,
  Clock3,
  CreditCard,
  FileCheck2,
  HandCoins,
  ReceiptText,
  RefreshCcw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { motion } from "motion/react";

import {
  getInvoiceAdminRecords,
  getInvoiceProviders,
  getPaymentAdminRecords,
  getPaymentGateways,
  getPlatformSetupStatus,
  getRefundAdminRecords,
  isLiveMarketplaceEnabled,
  saveInvoiceProvider,
  savePaymentGateway,
  type InvoiceProviderRecord,
  type InvoiceAdminRecord,
  type PaymentAdminRecord,
  type PaymentGatewayRecord,
  type PlatformSetupStatus,
  type RefundAdminRecord,
} from "../api";
import { MetricCard, SectionHeading, spring } from "./Primitives";

interface PlatformDashboardProps {
  paymentMode: "test" | "production";
  onRequestModeChange: () => void;
  onNotice: (message: string) => void;
}

export function PlatformDashboard({
  paymentMode,
  onRequestModeChange,
  onNotice,
}: PlatformDashboardProps) {
  const [setup, setSetup] = useState<PlatformSetupStatus | null>(null);
  const [setupError, setSetupError] = useState(false);
  const [gateways, setGateways] = useState<PaymentGatewayRecord[]>([]);
  const [invoiceProviders, setInvoiceProviders] = useState<InvoiceProviderRecord[]>([]);
  const [payments, setPayments] = useState<PaymentAdminRecord[]>([]);
  const [refunds, setRefunds] = useState<RefundAdminRecord[]>([]);
  const [invoices, setInvoices] = useState<InvoiceAdminRecord[]>([]);
  const [financeView, setFinanceView] = useState<"invoices" | "refunds">("invoices");
  const [gatewayEditorOpen, setGatewayEditorOpen] = useState(false);
  const [invoiceEditorOpen, setInvoiceEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayKind, setGatewayKind] = useState<PaymentGatewayRecord["kind"]>("test");
  const [gatewayMode, setGatewayMode] = useState<"test" | "production">("test");
  const [gatewaySettings, setGatewaySettings] = useState("{}");
  const [gatewayCredentialRef, setGatewayCredentialRef] = useState("");
  const [invoiceName, setInvoiceName] = useState("");
  const [invoiceProviderKey, setInvoiceProviderKey] = useState("local_test");
  const [invoiceMode, setInvoiceMode] = useState<"test" | "production">("test");
  const [invoiceSettings, setInvoiceSettings] = useState("{}");
  const [invoiceCredentialRef, setInvoiceCredentialRef] = useState("");

  useEffect(() => {
    if (!isLiveMarketplaceEnabled()) return;
    let mounted = true;
    void Promise.allSettled([
      getPlatformSetupStatus(),
      getPaymentGateways(),
      getInvoiceProviders(),
      getPaymentAdminRecords(),
      getRefundAdminRecords(),
      getInvoiceAdminRecords(),
    ])
      .then(([setupResult, gatewayResult, invoiceResult, paymentResult, refundResult, invoiceRecordResult]) => {
        if (!mounted) return;
        if (setupResult.status === "fulfilled") setSetup(setupResult.value);
        else setSetupError(true);
        // Payment administration is intentionally allowed to be unavailable while the first
        // Better Auth session is still settling; the setup card remains useful in that state.
        if (gatewayResult.status === "fulfilled") setGateways(gatewayResult.value);
        if (invoiceResult.status === "fulfilled") setInvoiceProviders(invoiceResult.value);
        if (paymentResult.status === "fulfilled") setPayments(paymentResult.value);
        if (refundResult.status === "fulfilled") setRefunds(refundResult.value);
        if (invoiceRecordResult.status === "fulfilled") setInvoices(invoiceRecordResult.value);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const refreshPaymentAdministration = async () => {
    const [nextGateways, nextInvoiceProviders, nextPayments, nextRefunds, nextInvoices] = await Promise.all([
      getPaymentGateways(),
      getInvoiceProviders(),
      getPaymentAdminRecords(),
      getRefundAdminRecords(),
      getInvoiceAdminRecords(),
    ]);
    setGateways(nextGateways);
    setInvoiceProviders(nextInvoiceProviders);
    setPayments(nextPayments);
    setRefunds(nextRefunds);
    setInvoices(nextInvoices);
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

  return (
    <div className="dashboard platform-dashboard">
      <section className="workspace-heading platform-heading">
        <div>
          <p className="eyebrow">平台经营与结算</p>
          <h1>每一笔撮合，都能解释价值从哪里来。</h1>
          <p>支付、发票、退款和线下结果都由根平台记录；具体费率与网关由管理员配置。</p>
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
        </section>

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
          {invoiceEditorOpen ? (
            <div className="admin-editor" aria-label="发票 provider 配置">
              <div className="admin-editor-heading"><strong>新增发票 provider</strong><button type="button" onClick={() => setInvoiceEditorOpen(false)}>关闭</button></div>
              <label><span>名称</span><input value={invoiceName} onChange={(event) => setInvoiceName(event.target.value)} placeholder="例如：电子发票服务" /></label>
              <label><span>provider</span><select value={invoiceProviderKey} onChange={(event) => setInvoiceProviderKey(event.target.value)}><option value="local_test">测试发票</option><option value="http_json">HTTP JSON</option><option value="fapiao_http">Fapiao HTTP</option></select></label>
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
        </section>

        <section className="operations-strip" aria-label="支付运营状态">
          <div><span><BadgeCheck aria-hidden="true" /></span><p><strong>网关健康</strong><small>等待配置数据</small></p></div>
          <div><span><Clock3 aria-hidden="true" /></span><p><strong>主动对账</strong><small>由支付服务报告</small></p></div>
          <div><span><FileCheck2 aria-hidden="true" /></span><p><strong>审计记录</strong><small>由根平台审计流报告</small></p></div>
        </section>
      </div>
    </div>
  );
}
