import { useEffect, useMemo, useState } from "react";
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

import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { ListingVisual, SectionHeading, spring } from "./Primitives";

interface BuyerDashboardProps {
  listings: AssetListing[];
  onOpenListing: (listing: AssetListing) => void;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

export function BuyerDashboard({ listings, onOpenListing, onNotice, subplatform }: BuyerDashboardProps) {
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<Set<string>>(() => readSavedItems(`matchplane.saved.${subplatform.path}`));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(() => new Set());
  const isRoot = subplatform.slug === "root";
  const savedKey = `matchplane.saved.${subplatform.path}`;
  const filterDefinitions = subplatform.ui?.filters ?? [];

  useEffect(() => {
    window.localStorage.setItem(savedKey, JSON.stringify([...saved]));
  }, [saved, savedKey]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return listings.filter((listing) => {
      const searchable = [listing.title, listing.subtitle, listing.location, listing.price, listing.trust?.join(" "), ...listing.facts.map((fact) => `${fact.label} ${fact.value}`)]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      if (normalized && !searchable.includes(normalized)) return false;
      for (const key of activeFilters) {
        const filter = filterDefinitions.find((candidate) => candidate.key === key);
        if (filter && !matchesFilter(listing, filter)) return false;
      }
      return true;
    });
  }, [activeFilters, filterDefinitions, listings, query]);

  const toggleSaved = (id: string) => {
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const scrollToListings = () => {
    document.getElementById("recommendations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="dashboard buyer-dashboard">
      {isRoot ? (
        <RootFlow subplatform={subplatform} />
      ) : (
        <section className="buyer-hero" aria-labelledby="buyer-hero-title">
          <div className="hero-copy">
            <span className="hero-kicker">
              <Sparkles size={16} aria-hidden="true" />
              需求由你定义
            </span>
            <h1 id="buyer-hero-title">
              把目标说清楚，
              <span>找到合适的供给方。</span>
            </h1>
            <p>告诉我们真实用途、预算和不能妥协的条件。MatchPlane 会解释每一次推荐，撮合后你可以直接联系供给方，也可以在线下完成交易。</p>
            <div className="hero-actions">
              <motion.button
                className="button button-dark"
                type="button"
                onClick={scrollToListings}
                whileTap={{ scale: 0.97 }}
                transition={spring}
              >
                查看可用供给
                <ArrowRight size={18} aria-hidden="true" />
              </motion.button>
              <a className="button button-quiet" href={`${subplatform.path}?role=seller`}>
                我来提供
              </a>
              <motion.button
                className="button button-quiet"
                type="button"
                onClick={() => {
                  document.getElementById("match-chat-input")?.focus();
                  onNotice("已回到需求输入框，可以继续补充预算、时间和不能妥协的条件");
                }}
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
            className="hero-art-wrap generic-match-art"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={spring}
            aria-hidden="true"
          >
            <span className="generic-art-orbit orbit-one" />
            <span className="generic-art-orbit orbit-two" />
            <span className="generic-art-core"><Sparkles size={40} strokeWidth={1.3} /></span>
            <div className="floating-match-card">
              <span>匹配核心</span>
              <strong>AI</strong>
              <small>目标 · 约束 · 可信度</small>
            </div>
          </motion.div>
        </section>
      )}

      {listings.length ? (
        <section className="discovery-panel" aria-label="搜索供给">
          <label className="search-field">
            <Search size={20} aria-hidden="true" />
            <span className="sr-only">搜索供给</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、属性或地点"
              type="search"
            />
          </label>
          {filterDefinitions.length ? <button
            className={`filter-button${filtersOpen ? " is-active" : ""}`}
            type="button"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span>筛选{activeFilters.size ? ` · ${activeFilters.size}` : ""}</span>
          </button> : null}
          {filterDefinitions.length && filtersOpen ? (
            <div className="filter-menu" role="group" aria-label="高级筛选">
              {filterDefinitions.map((filter) => {
                const active = activeFilters.has(filter.key);
                return (
                  <button
                    key={filter.key}
                    className={active ? "is-active" : ""}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setActiveFilters((current) => {
                        const next = new Set(current);
                        if (next.has(filter.key)) next.delete(filter.key);
                        else next.add(filter.key);
                        return next;
                      });
                      onNotice(active ? `已移除筛选：${filter.label}` : `已启用筛选：${filter.label}`);
                    }}
                  >
                    {filter.label}
                    {active ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      <section id="recommendations" className={`content-section${isRoot ? " root-content" : ""}`}>
        <SectionHeading eyebrow="由供给方提交，审核后展示" title={`${visible.length} 个可用供给`} />
        {visible.length ? (
          <div className="vehicle-grid">
            {visible.map((listing, index) => (
              <AssetCard
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
            <h3>{query ? "没有命中这次搜索" : "等待供给方上传资料"}</h3>
            <p>
              {query
                ? "换一个名称、属性或地点试试。"
                : "平台不预置样例内容；卖家提交并通过审核后，这里会出现真实供给。"}
            </p>
            {query ? <button type="button" onClick={() => setQuery("")}>清除搜索</button> : null}
            {!query ? <button type="button" onClick={() => { document.getElementById("match-chat-input")?.focus(); onNotice("先描述你的目标，平台会从已激活的子平台开始路由"); }}>描述需求</button> : null}
          </div>
        )}
      </section>

      <section className="offline-section" aria-labelledby="offline-title">
        <div className="offline-intro">
          <span className="eyebrow">线上撮合 · 线下协商</span>
          <h2 id="offline-title">双方在哪完成交易，由双方决定。</h2>
          <p>
            平台确认双方匹配与服务费安排后，才按权限交换联系方式。线下成交也会保留撮合记录，
            平台只收取事先披露的撮合提成。
          </p>
        </div>
        <ol className="offline-steps">
          <li>
            <span><UserRoundCheck aria-hidden="true" /></span>
            <div><small>01</small><strong>匹配并解锁联系</strong><p>仅双方可见，访问留有审计记录。</p></div>
          </li>
          <li>
            <span><CalendarDays aria-hidden="true" /></span>
            <div><small>02</small><strong>预约或线下协商</strong><p>地点和时间在双方确认后生效。</p></div>
          </li>
          <li>
            <span><BadgeCheck aria-hidden="true" /></span>
            <div><small>03</small><strong>确认结果与平台提成</strong><p>成交后按披露规则结算平台服务费。</p></div>
          </li>
        </ol>
      </section>
    </div>
  );
}

function matchesFilter(
  listing: AssetListing,
  filter: NonNullable<NonNullable<SubplatformConfig["ui"]>["filters"]>[number],
): boolean {
  if (filter.source === "trust") return Boolean(listing.trust?.length);
  if (filter.source === "price") return Boolean(listing.price.trim() && listing.price.trim() !== "—");
  if (!filter.attribute) return false;
  const fact = listing.facts.find((candidate) => candidate.label === filter.attribute);
  if (!fact) return false;
  return filter.value === undefined || fact.value === filter.value;
}

function RootFlow({ subplatform }: { subplatform: SubplatformConfig }) {
  return (
    <section className="root-routing-strip" aria-labelledby="root-routing-title">
      <div className="root-routing-copy">
        <h2 id="root-routing-title">一句话，开始一条匹配路径。</h2>
        <p>根平台只做理解与路由；具体领域、商家和供给内容由各子平台提供。</p>
      </div>
      <ol className="root-routing-steps">
        <li><span aria-hidden="true" /><div><strong>描述目标</strong><small>预算与约束</small></div></li>
        <li><span aria-hidden="true" /><div><strong>沿平台树路由</strong><small>只访问已激活节点</small></div></li>
        <li><span aria-hidden="true" /><div><strong>双方同意后联系</strong><small>保留撮合与审计记录</small></div></li>
      </ol>
      <a className="button button-quiet root-routing-seller-link" href={`${subplatform.path}?role=seller`}>
        我来提供
        <ArrowRight size={17} aria-hidden="true" />
      </a>
    </section>
  );
}

function AssetCard({
  listing,
  index,
  saved,
  onSave,
  onOpen,
}: {
  listing: AssetListing;
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
        <ListingVisual accent={listing.accent} label={listing.trust?.[0]} />
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
          {listing.matchScore !== undefined ? <span className="match-score">{listing.matchScore}% 匹配</span> : null}
          {listing.location ? <span><MapPin size={14} aria-hidden="true" /> {listing.location}</span> : null}
        </div>
        <button className="vehicle-title-button" type="button" onClick={onOpen}>
          <h3>{listing.title}</h3>
        </button>
        <p className="vehicle-subtitle">{listing.subtitle}</p>
        {listing.facts.length ? (
          <dl className="vehicle-facts">
            {listing.facts.slice(0, 3).map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        ) : null}
        {listing.reasons?.[0] ? (
          <div className="reason-line">
            <Sparkles size={15} aria-hidden="true" />
            <span>{listing.reasons[0]}</span>
          </div>
        ) : null}
        <div className="price-row">
          <div><strong>{listing.price}</strong>{listing.priceLabel ? <small>{listing.priceLabel}</small> : null}</div>
          <motion.button className="round-arrow" type="button" aria-label={`查看 ${listing.title}`} onClick={onOpen} whileTap={{ scale: 0.88 }} transition={spring}>
            <ArrowRight size={18} aria-hidden="true" />
          </motion.button>
        </div>
      </div>
    </motion.article>
  );
}

function readSavedItems(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}
