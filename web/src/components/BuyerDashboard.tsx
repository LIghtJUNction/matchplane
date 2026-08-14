import { useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  Heart,
  MapPin,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import { motion } from "motion/react";

import { recommendations } from "../data";
import type { VehicleListing } from "../types";
import { SectionHeading, VehicleVisual, spring } from "./Primitives";

interface BuyerDashboardProps {
  onOpenListing: (listing: VehicleListing) => void;
  onNotice: (message: string) => void;
}

const filters = ["预算 20–30 万", "2022 年后", "4 万公里内", "上海周边", "可第三方检测"];

export function BuyerDashboard({ onOpenListing, onNotice }: BuyerDashboardProps) {
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return recommendations;
    return recommendations.filter((listing) =>
      [listing.title, listing.subtitle, listing.location, listing.energy]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [query]);

  const toggleSaved = (id: string) => {
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToRecommendations = () => {
    document.getElementById("recommendations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="dashboard buyer-dashboard">
      <section className="buyer-hero" aria-labelledby="buyer-hero-title">
        <div className="hero-copy">
          <span className="hero-kicker">
            <Sparkles size={16} aria-hidden="true" />
            需求已更新 · 12 个高质量匹配
          </span>
          <h1 id="buyer-hero-title">
            适合你的车，
            <span>不只是看起来相似。</span>
          </h1>
          <p>
            告诉我们真实用途、预算和不能妥协的条件。MatchPlane 会解释每一次推荐，
            撮合后你可以直接联系卖家、预约线下看车。
          </p>
          <div className="hero-actions">
            <motion.button
              className="button button-dark"
              type="button"
              onClick={scrollToRecommendations}
              whileTap={{ scale: 0.97 }}
              transition={spring}
            >
              查看推荐
              <ArrowRight size={18} aria-hidden="true" />
            </motion.button>
            <motion.button
              className="button button-quiet"
              type="button"
              onClick={() => onNotice("需求编辑器已保存你的当前筛选条件")}
              whileTap={{ scale: 0.97 }}
              transition={spring}
            >
              调整需求
            </motion.button>
          </div>
          <div className="hero-proof" aria-label="平台保障">
            <span><ShieldCheck size={16} aria-hidden="true" /> 联系信息受控解锁</span>
            <span><BadgeCheck size={16} aria-hidden="true" /> 匹配理由可解释</span>
          </div>
        </div>
        <motion.div
          className="hero-art-wrap"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring}
        >
          <img
            src="/matchplane-marketplace-art.png"
            alt="两只手共同托起一辆汽车，象征买卖双方建立可信连接"
          />
          <div className="floating-match-card">
            <span>最佳匹配</span>
            <strong>96%</strong>
            <small>预算 · 续航 · 地点</small>
          </div>
        </motion.div>
      </section>

      <section className="discovery-panel" aria-label="找车条件">
        <label className="search-field">
          <Search size={20} aria-hidden="true" />
          <span className="sr-only">搜索推荐车辆</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索品牌、能源类型或城市"
            type="search"
          />
        </label>
        <button className="filter-button" type="button" onClick={() => onNotice("高级筛选已展开")}>
          <SlidersHorizontal size={18} aria-hidden="true" />
          筛选
          <span>5</span>
        </button>
        <div className="filter-chips" aria-label="当前筛选条件">
          {filters.map((filter) => (
            <button key={filter} type="button" onClick={() => onNotice(`已选条件：${filter}`)}>
              {filter}
              <Check size={14} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <section id="recommendations" className="content-section">
        <SectionHeading
          eyebrow="为你排序，而不是竞价排序"
          title={`${visible.length} 台优先推荐`}
          action="查看全部 12 台"
        />
        {visible.length ? (
          <div className="vehicle-grid">
            {visible.map((listing, index) => (
              <VehicleCard
                key={listing.id}
                listing={listing}
                index={index}
                saved={saved.has(listing.id)}
                onSave={() => toggleSaved(listing.id)}
                onOpen={() => onOpenListing(listing)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Search size={28} aria-hidden="true" />
            <h3>没有命中这次搜索</h3>
            <p>保留你的硬性条件，换一个品牌或城市试试。</p>
            <button type="button" onClick={() => setQuery("")}>清除搜索</button>
          </div>
        )}
      </section>

      <section className="offline-section" aria-labelledby="offline-title">
        <div className="offline-intro">
          <span className="eyebrow">线上撮合 · 线下成交</span>
          <h2 id="offline-title">看车可以当面，流程仍然清楚。</h2>
          <p>
            平台确认双方匹配与服务费安排后，才按权限交换联系方式。整车款可以由买卖双方线下直接结算，
            平台只收取事先披露的撮合提成。
          </p>
        </div>
        <ol className="offline-steps">
          <li>
            <span><UserRoundCheck aria-hidden="true" /></span>
            <div><small>01</small><strong>匹配并解锁联系</strong><p>仅成交双方可见，访问留有审计记录。</p></div>
          </li>
          <li>
            <span><CalendarDays aria-hidden="true" /></span>
            <div><small>02</small><strong>预约线下看车</strong><p>地点加密保存，双方确认时间后生效。</p></div>
          </li>
          <li>
            <span><BadgeCheck aria-hidden="true" /></span>
            <div><small>03</small><strong>双方确认成交价</strong><p>价格一致后收取准确提成并关闭车源。</p></div>
          </li>
        </ol>
      </section>
    </div>
  );
}

function VehicleCard({
  listing,
  index,
  saved,
  onSave,
  onOpen,
}: {
  listing: VehicleListing;
  index: number;
  saved: boolean;
  onSave: () => void;
  onOpen: () => void;
}) {
  return (
    <motion.article
      className="vehicle-card"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: index * 0.045 }}
      layout
    >
      <button className="vehicle-open" type="button" onClick={onOpen} aria-label={`查看 ${listing.title}`}>
        <VehicleVisual accent={listing.accent} />
      </button>
      <motion.button
        type="button"
        className={`save-button${saved ? " is-saved" : ""}`}
        onClick={onSave}
        aria-label={saved ? `取消收藏 ${listing.title}` : `收藏 ${listing.title}`}
        aria-pressed={saved}
        whileTap={{ scale: 0.86 }}
        transition={spring}
      >
        <Heart size={19} fill={saved ? "currentColor" : "none"} aria-hidden="true" />
      </motion.button>
      <div className="vehicle-content">
        <div className="match-row">
          <span className="match-score">{listing.matchScore}% 匹配</span>
          <span><MapPin size={14} aria-hidden="true" /> {listing.location}</span>
        </div>
        <button className="vehicle-title-button" type="button" onClick={onOpen}>
          <h3>{listing.title}</h3>
        </button>
        <p className="vehicle-subtitle">{listing.subtitle}</p>
        <dl className="vehicle-facts">
          <div><dt>里程</dt><dd>{listing.mileage}</dd></div>
          <div><dt>能源</dt><dd>{listing.energy}</dd></div>
          <div><dt>年份</dt><dd>{listing.year}</dd></div>
        </dl>
        <div className="reason-line">
          <Sparkles size={15} aria-hidden="true" />
          <span>{listing.reasons[0]}</span>
        </div>
        <div className="price-row">
          <div><strong>{listing.price}</strong><small>{listing.monthly}</small></div>
          <motion.button
            className="round-arrow"
            type="button"
            onClick={onOpen}
            aria-label={`打开 ${listing.title} 详情`}
            whileTap={{ scale: 0.9 }}
            transition={spring}
          >
            <ArrowRight size={19} aria-hidden="true" />
          </motion.button>
        </div>
      </div>
    </motion.article>
  );
}
