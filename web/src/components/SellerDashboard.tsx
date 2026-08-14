import {
  ArrowRight,
  BadgeCheck,
  Camera,
  Eye,
  Gauge,
  MessageCircle,
  MousePointerClick,
  Sparkles,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { motion } from "motion/react";

import { sellerActivity } from "../data";
import { ActivityList, MetricCard, SectionHeading, VehicleVisual, spring } from "./Primitives";

export function SellerDashboard({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <div className="dashboard seller-dashboard">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">卖家经营台 · 8 月 14 日</p>
          <h1>让真正需要这台车的人先看到它。</h1>
          <p>曝光不只看付费高低；资料完整度、价格竞争力和买家需求相关性共同决定推荐质量。</p>
        </div>
        <motion.button
          className="button button-dark"
          type="button"
          onClick={() => onNotice("新车源草稿已创建")}
          whileTap={{ scale: 0.97 }}
          transition={spring}
        >
          发布新车源
          <ArrowRight size={18} aria-hidden="true" />
        </motion.button>
      </section>

      <section className="metric-grid" aria-label="卖家核心指标">
        <MetricCard icon={Eye} label="有效曝光" value="8,492" detail="较上周 +18.4%" tone="cactus" />
        <MetricCard icon={MousePointerClick} label="详情访问" value="1,236" detail="访问率 14.6%" />
        <MetricCard icon={UsersRound} label="高意向匹配" value="47" detail="其中 12 位可本周看车" tone="heather" />
        <MetricCard icon={MessageCircle} label="已解锁联系" value="9" detail="平均回复用时 18 分钟" tone="clay" />
      </section>

      <div className="seller-layout">
        <section className="surface listing-performance" aria-labelledby="listing-performance-title">
          <SectionHeading eyebrow="主力车源" title="2023 极氪 001 WE" action="查看车源" />
          <div className="listing-feature">
            <VehicleVisual accent="cactus" compact />
            <div className="listing-score">
              <div className="score-ring" aria-label="车源质量分 92 分">
                <strong>92</strong><span>/100</span>
              </div>
              <div>
                <strong>曝光竞争力优秀</strong>
                <p>价格、车况和买家需求的综合表现位于同类车源前 8%。</p>
              </div>
            </div>
          </div>
          <div className="quality-tasks">
            <div className="quality-complete">
              <span><BadgeCheck size={18} aria-hidden="true" /></span>
              <div><strong>核心资料已核验</strong><p>维保、事故、手续和卖家身份</p></div>
            </div>
            <button type="button" onClick={() => onNotice("已打开照片优化向导")}>
              <span><Camera size={18} aria-hidden="true" /></span>
              <div><strong>补充底盘与轮胎照片</strong><p>预计增加 12% 有效曝光</p></div>
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </section>

        <section className="surface exposure-funnel" aria-labelledby="exposure-title">
          <SectionHeading eyebrow="最近 7 天" title="曝光转化" />
          <div className="funnel-chart" role="img" aria-label="曝光 8492 次，详情访问 1236 次，高意向匹配 47 次，已联系 9 次">
            <FunnelBar label="推荐曝光" value="8,492" width="100%" tone="cactus" />
            <FunnelBar label="详情访问" value="1,236" width="72%" tone="ink" />
            <FunnelBar label="高意向匹配" value="47" width="47%" tone="heather" />
            <FunnelBar label="已联系" value="9" width="29%" tone="clay" />
          </div>
          <div className="funnel-insight">
            <TrendingUp size={19} aria-hidden="true" />
            <p><strong>访问到匹配的转化提高 3.2%</strong><br />最近补充的维保记录正在带来更准确的买家。</p>
          </div>
        </section>

        <section className="surface seller-activity" aria-labelledby="seller-activity-title">
          <SectionHeading eyebrow="实时动态" title="买家正在做什么" action="全部动态" />
          <ActivityList items={sellerActivity} />
        </section>

        <section className="seller-boost" aria-labelledby="boost-title">
          <div className="boost-icon"><Sparkles aria-hidden="true" /></div>
          <div>
            <p className="eyebrow">曝光建议</p>
            <h2 id="boost-title">先完善车况，再考虑额外推广。</h2>
            <p>完成 2 项资料建议即可进入“高可信车源”池；无需先购买曝光。</p>
          </div>
          <motion.button
            className="button button-light"
            type="button"
            onClick={() => onNotice("已打开车源优化清单")}
            whileTap={{ scale: 0.97 }}
            transition={spring}
          >
            查看优化清单
            <Gauge size={18} aria-hidden="true" />
          </motion.button>
        </section>
      </div>
    </div>
  );
}

function FunnelBar({
  label,
  value,
  width,
  tone,
}: {
  label: string;
  value: string;
  width: string;
  tone: "cactus" | "ink" | "heather" | "clay";
}) {
  return (
    <div className="funnel-row">
      <div className="funnel-label"><span>{label}</span><strong>{value}</strong></div>
      <div className="funnel-track">
        <motion.span
          className={`funnel-fill funnel-${tone}`}
          initial={{ width: 0 }}
          animate={{ width }}
          transition={spring}
        />
      </div>
    </div>
  );
}
