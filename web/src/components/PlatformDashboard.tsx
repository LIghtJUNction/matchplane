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
        <section className="surface gateway-panel" aria-labelledby="gateway-title">
          <SectionHeading eyebrow="标准化支付接口" title="支付网关" action="配置网关" />
          <div className="gateway-empty">
            <CreditCard size={24} aria-hidden="true" />
            <strong>等待管理员接入支付网关</strong>
            <p>根平台提供标准接口；网关名称、协议和状态由部署配置返回。</p>
            <button type="button" onClick={() => onNotice("网关配置需要管理员会话")}>打开配置</button>
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
          <SectionHeading eyebrow="财务动态" title="支付、发票与退款" action="查看全部" />
          <div className="finance-empty"><ReceiptText size={22} aria-hidden="true" /><p>暂无财务动态。接入支付服务后，这里显示真实事件。</p></div>
          <div className="finance-actions">
            <button type="button" onClick={() => onNotice("已进入发票管理")}>
              <ReceiptText size={18} aria-hidden="true" /><span><strong>发票管理</strong><small>12 个待处理</small></span>
            </button>
            <button type="button" onClick={() => onNotice("已进入退款管理")}>
              <BanknoteArrowDown size={18} aria-hidden="true" /><span><strong>退款管理</strong><small>3 个需复核</small></span>
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
