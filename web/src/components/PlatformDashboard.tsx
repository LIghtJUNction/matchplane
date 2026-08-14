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
  Settings2,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { motion } from "motion/react";

import { gateways, paymentActivity } from "../data";
import { ActivityList, MetricCard, SectionHeading, spring } from "./Primitives";

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
          <h1>每一笔撮合，都能解释收益从哪里来。</h1>
          <p>整车可在线支付，也可由双方线下直接成交；平台按确认成交价收取已披露提成。</p>
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
        <MetricCard icon={CircleDollarSign} label="本月平台提成" value="¥486,320" detail="较上月 +12.7%" tone="cactus" />
        <MetricCard icon={HandCoins} label="完成撮合" value="184 台" detail="线下直成交占 63%" tone="heather" />
        <MetricCard icon={WalletCards} label="待结算提成" value="¥38,640" detail="17 笔等待双方确认" />
        <MetricCard icon={RefreshCcw} label="退款率" value="0.82%" detail="低于近 90 日均值" tone="clay" />
      </section>

      <div className="platform-layout">
        <section className="surface gateway-panel" aria-labelledby="gateway-title">
          <SectionHeading eyebrow="标准化支付接口" title="支付网关" action="配置网关" />
          <div className="gateway-list">
            {gateways.map((gateway) => (
              <button
                key={gateway.name}
                type="button"
                onClick={() => onNotice(`已打开 ${gateway.name} 配置`)}
              >
                <span className={`gateway-logo gateway-${gateway.status}`}>
                  {gateway.name === "线下成交" ? <HandCoins aria-hidden="true" /> : <CreditCard aria-hidden="true" />}
                </span>
                <span className="gateway-copy">
                  <strong>{gateway.name}</strong>
                  <small>{gateway.kind} · {gateway.methods}</small>
                </span>
                <span className={`gateway-state state-${gateway.status}`}>
                  {gateway.status === "healthy" ? "正常" : gateway.status === "attention" ? "需复核" : "流程内置"}
                </span>
                <Settings2 size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        <section className="surface commission-panel" aria-labelledby="commission-title">
          <SectionHeading eyebrow="提成模型" title="本月收入构成" />
          <div className="commission-total">
            <span>已确认净收入</span>
            <strong>¥486,320</strong>
            <small>184 笔成交 · 平均每台 ¥2,643</small>
          </div>
          <div className="commission-bars" aria-label="收入构成：线下成交撮合费 61%，在线整车交易 27%，增值服务 12%">
            <motion.span className="bar-offline" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={spring} />
            <motion.span className="bar-online" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ ...spring, delay: 0.05 }} />
            <motion.span className="bar-service" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ ...spring, delay: 0.1 }} />
          </div>
          <dl className="commission-legend">
            <div><dt><i className="legend-offline" />线下成交撮合费</dt><dd>61% · ¥296,655</dd></div>
            <div><dt><i className="legend-online" />在线整车交易</dt><dd>27% · ¥131,306</dd></div>
            <div><dt><i className="legend-service" />增值服务</dt><dd>12% · ¥58,359</dd></div>
          </dl>
          <div className="commission-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>提成按双方确认的最终成交价精确计算，退款时按比例冲回并生成发票更正。</p>
          </div>
        </section>

        <section className="surface finance-activity" aria-labelledby="finance-activity-title">
          <SectionHeading eyebrow="财务动态" title="支付、发票与退款" action="查看全部" />
          <ActivityList items={paymentActivity} />
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
          <div><span><BadgeCheck aria-hidden="true" /></span><p><strong>网关健康</strong><small>4 / 4 在线网关可用</small></p></div>
          <div><span><Clock3 aria-hidden="true" /></span><p><strong>主动对账</strong><small>最近一次 3 分钟前</small></p></div>
          <div><span><FileCheck2 aria-hidden="true" /></span><p><strong>审计记录</strong><small>今日 1,284 条，链路完整</small></p></div>
        </section>
      </div>
    </div>
  );
}
