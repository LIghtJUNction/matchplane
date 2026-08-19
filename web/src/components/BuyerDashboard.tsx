import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  ChevronDown,
  Heart,
  MapPin,
  Search,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  Scale,
  UserRoundCheck,
} from "lucide-react";
import { motion } from "motion/react";

import { subplatformContactLabel, type SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import {
  getMarketplaceIntroductions,
  getMarketplaceOfferPreferences,
  getPlatformChildren,
  recordMarketplaceBehaviorEvent,
  retrieveMarketplaceContact,
  setMarketplaceOfferPreference,
  type MarketplaceContactResponse,
  type MarketplaceIntroduction,
  type PlatformChildSummary,
} from "../api";
import { getMarketplaceSession as getCapability } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import { localizedSubplatformCopy } from "../lib/localized-copy";
import { ListingVisual, SectionHeading, spring } from "./Primitives";
import { ContactProfileCard } from "./ContactProfileCard";

interface BuyerDashboardProps {
  listings: AssetListing[];
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}

interface IntroductionScope {
  tenantId: string;
  domainId: string;
  platformPath: string;
  subplatform: string;
}

interface IntroductionEntry {
  introduction: MarketplaceIntroduction;
  scope: IntroductionScope;
}

export function BuyerDashboard({ listings, locale, onOpenListing, onNotice, subplatform }: BuyerDashboardProps) {
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<Set<string>>(() => readSavedItems(`matchplane.saved.${subplatform.path}`));
  const [dismissed, setDismissed] = useState<Set<string>>(() => readSavedItems(`matchplane.dismissed.${subplatform.path}`));
  const [compareIds, setCompareIds] = useState<Set<string>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(() => new Set());
  const [childPlatforms, setChildPlatforms] = useState<PlatformChildSummary[]>([]);
  const [introductions, setIntroductions] = useState<IntroductionEntry[]>([]);
  const [contacts, setContacts] = useState<Record<string, MarketplaceContactResponse>>({});
  const [contactLoading, setContactLoading] = useState<string | null>(null);
  const isRoot = subplatform.slug === "root";
  const savedKey = `matchplane.saved.${subplatform.path}`;
  const dismissedKey = `matchplane.dismissed.${subplatform.path}`;
  const filterDefinitions = subplatform.ui?.filters ?? [];
  const copy = (key: string, fallbackZh: string, fallbackEn = fallbackZh) => localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);

  useEffect(() => {
    window.localStorage.setItem(savedKey, JSON.stringify([...saved]));
  }, [saved, savedKey]);

  useEffect(() => {
    window.localStorage.setItem(dismissedKey, JSON.stringify([...dismissed]));
  }, [dismissed, dismissedKey]);

  useEffect(() => {
    let active = true;
    if (!subplatform.tenantId || !subplatform.domainId) return () => { active = false; };
    void getCapability({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "buyer",
    }).then((session) => session ? getMarketplaceOfferPreferences({ session, domainId: subplatform.domainId! }) : null)
      .then((preferences) => {
        if (!active || !preferences) return;
        const savedIds = preferences.filter((item) => item.state === "saved").map((item) => item.offer_id);
        const dismissedIds = preferences.filter((item) => item.state === "dismissed").map((item) => item.offer_id);
        if (savedIds.length) setSaved((current) => new Set([...current, ...savedIds]));
        if (dismissedIds.length) setDismissed((current) => new Set([...current, ...dismissedIds]));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [subplatform.domainId, subplatform.path, subplatform.slug, subplatform.tenantId]);

  useEffect(() => {
    if (!isRoot) {
      setChildPlatforms([]);
      return;
    }
    let active = true;
    void getPlatformChildren(subplatform.path)
      .then((children) => {
        if (active) setChildPlatforms(children);
      })
      .catch(() => {
        if (active) setChildPlatforms([]);
      });
    return () => {
      active = false;
    };
  }, [isRoot, subplatform.path]);

  const loadIntroductions = useCallback(async () => {
    const scopes = new Map<string, IntroductionScope>();
    const addScope = (scope: IntroductionScope | null) => {
      if (!scope) return;
      scopes.set(`${scope.tenantId}:${scope.domainId}:${scope.platformPath}`, scope);
    };
    if (subplatform.tenantId && subplatform.domainId) {
      addScope({
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        platformPath: subplatform.path,
        subplatform: subplatform.slug,
      });
    }
    // Root chat recommendations carry the authoritative child scope. Read the
    // inbox from those nodes as well, rather than querying only the page's
    // domain and losing the contact handoff after a federated match.
    for (const listing of listings) {
      if (!listing.tenantId || !listing.domainId || !listing.platformPath) continue;
      const pathSlug = listing.platformPath.split("/").filter(Boolean).at(-1);
      addScope({
        tenantId: listing.tenantId,
        domainId: listing.domainId,
        platformPath: listing.platformPath,
        subplatform: listing.subplatform || pathSlug || subplatform.slug,
      });
    }
    if (!scopes.size) {
      setIntroductions([]);
      return;
    }
    const entries = await Promise.all([...scopes.values()].map(async (scope): Promise<IntroductionEntry[]> => {
      try {
        const session = await getCapability({
          subplatform: scope.subplatform,
          platformPath: scope.platformPath,
          tenantId: scope.tenantId,
          domainId: scope.domainId,
          role: "buyer",
        });
        if (!session) return [];
        const records = await getMarketplaceIntroductions({ session, domainId: scope.domainId });
        return records.map((introduction) => ({ introduction, scope }));
      } catch {
        return [];
      }
    }));
    setIntroductions(entries.flat());
  }, [listings, subplatform.domainId, subplatform.path, subplatform.slug, subplatform.tenantId]);

  useEffect(() => {
    void loadIntroductions();
    const refresh = () => void loadIntroductions();
    window.addEventListener("matchplane.contact.updated", refresh);
    return () => window.removeEventListener("matchplane.contact.updated", refresh);
  }, [loadIntroductions]);

  const releaseContact = async (entry: IntroductionEntry) => {
    const { introduction, scope } = entry;
    if (contactLoading) return;
    setContactLoading(introduction.introduction_id);
    try {
      const session = await getCapability({
        subplatform: scope.subplatform,
        platformPath: scope.platformPath,
        tenantId: scope.tenantId,
        domainId: scope.domainId,
        role: "buyer",
      });
      if (!session) {
        onNotice(copy("contactLoginNotice", "请先登录后查看已同意交换的联系方式"));
        return;
      }
      const response = await retrieveMarketplaceContact({
        session,
        domainId: scope.domainId,
        introductionId: introduction.introduction_id,
      });
      setContacts((current) => ({ ...current, [introduction.introduction_id]: response }));
      onNotice(copy("contactReleasedNotice", "联系方式已解锁，请通过对方提供的渠道联系"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : copy("contactReleaseError", "联系方式暂时无法读取"));
    } finally {
      setContactLoading(null);
    }
  };

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return listings.filter((listing) => {
      if (dismissed.has(listing.id)) return false;
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
  }, [activeFilters, dismissed, filterDefinitions, listings, query]);

  const recordBehavior = useCallback(async (listing: AssetListing, eventType: string, reason?: string) => {
    if (!listing.offerId || !listing.tenantId || !listing.domainId) return;
    const scopePath = listing.platformPath || subplatform.path;
    const scopeSlug = listing.subplatform || scopePath.split("/").filter(Boolean).at(-1) || subplatform.slug;
    try {
      const session = await getCapability({
        subplatform: scopeSlug,
        platformPath: scopePath,
        tenantId: listing.tenantId,
        domainId: listing.domainId,
        role: "buyer",
      });
      if (!session) return;
      await recordMarketplaceBehaviorEvent({
        session,
        domainId: listing.domainId,
        offerId: listing.offerId,
        intentId: listing.intentId,
        eventType,
        reason,
        metadata: { source: "buyer_dashboard", platform_path: scopePath },
        idempotencyKey: `ui-${eventType}-${listing.offerId}-${crypto.randomUUID()}`,
      });
    } catch {
      // Analytics must never block a buyer action.
    }
  }, [subplatform.path, subplatform.slug]);

  const toggleSaved = (listing: AssetListing) => {
    const id = listing.id;
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (listing.offerId && listing.tenantId && listing.domainId) {
      const scopePath = listing.platformPath || subplatform.path;
      const scopeSlug = listing.subplatform || scopePath.split("/").filter(Boolean).at(-1) || subplatform.slug;
      void getCapability({
        subplatform: scopeSlug,
        platformPath: scopePath,
        tenantId: listing.tenantId,
        domainId: listing.domainId,
        role: "buyer",
      }).then((session) => session ? setMarketplaceOfferPreference({
        session,
        domainId: listing.domainId!,
        offerId: listing.offerId!,
        state: saved.has(id) ? "neutral" : "saved",
      }) : undefined).catch(() => undefined);
    }
    void recordBehavior(listing, saved.has(id) ? "offer.unsave" : "offer.save");
  };

  const dismissListing = (listing: AssetListing) => {
    setDismissed((current) => new Set(current).add(listing.id));
    void recordBehavior(listing, "offer.dismiss", "not_a_fit");
    if (listing.offerId && listing.tenantId && listing.domainId) {
      const scopePath = listing.platformPath || subplatform.path;
      const scopeSlug = listing.subplatform || scopePath.split("/").filter(Boolean).at(-1) || subplatform.slug;
      void getCapability({
        subplatform: scopeSlug,
        platformPath: scopePath,
        tenantId: listing.tenantId,
        domainId: listing.domainId,
        role: "buyer",
      }).then((session) => session ? setMarketplaceOfferPreference({
        session,
        domainId: listing.domainId!,
        offerId: listing.offerId!,
        state: "dismissed",
        reason: "not_a_fit",
      }) : undefined).catch(() => undefined);
    }
    onNotice(copy("dismissedOfferNotice", "已隐藏这条供给，后续推荐会参考你的反馈"));
  };

  const toggleCompare = (listing: AssetListing) => {
    setCompareIds((current) => {
      const next = new Set(current);
      if (next.has(listing.id)) next.delete(listing.id);
      else if (next.size < 3) next.add(listing.id);
      else {
        onNotice(copy("compareLimitNotice", "最多同时比较 3 条供给"));
        return current;
      }
      return next;
    });
    void recordBehavior(listing, "offer.compare");
  };

  const scrollToListings = () => {
    document.getElementById("recommendations")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const showRecommendations = !isRoot || listings.length > 0 || query.trim().length > 0;

  return (
    <div className="dashboard buyer-dashboard">
      {isRoot ? (
        <RootFlow subplatform={subplatform} childPlatforms={childPlatforms} locale={locale} />
      ) : (
        <section className="buyer-hero" aria-labelledby="buyer-hero-title">
          <div className="hero-copy">
            <span className="hero-kicker">
              <Sparkles size={16} aria-hidden="true" />
              {copy("demandEyebrow", "需求由你定义")}
            </span>
            <h1 id="buyer-hero-title">
              {copy("demandTitle", "把目标说清楚，")}
              <span>{copy("demandTitleAccent", "找到合适的供给方。")}</span>
            </h1>
            <p>{copy("demandDescription", "告诉我们目标、预算和不能妥协的条件。平台会解释每一次推荐，撮合后你可以直接联系供给方，也可以在线下完成后续安排。")}</p>
            <div className="hero-actions">
              <motion.button
                className="button button-dark"
                type="button"
                onClick={scrollToListings}
                whileTap={{ scale: 0.97 }}
                transition={spring}
              >
                {copy("browseOffersLabel", "查看可用供给")}
                <ArrowRight size={18} aria-hidden="true" />
              </motion.button>
              <a className="button button-quiet" href={`${subplatform.path}?role=seller`}>
                {copy("supplyActionLabel", "我来提供")}
              </a>
              <motion.button
                className="button button-quiet"
                type="button"
                onClick={() => {
                  document.getElementById("match-chat-input")?.focus();
                  onNotice(copy("refineDemandNotice", "已回到需求输入框，可以继续补充目标、预算和限制条件"));
                }}
                whileTap={{ scale: 0.97 }}
                transition={spring}
              >
                {copy("refineDemandLabel", "调整需求")}
              </motion.button>
            </div>
            <div className="hero-proof" aria-label={copy("trustLabel", "平台保障")}>
              <span><BadgeCheck size={16} aria-hidden="true" /> {copy("explainableMatchLabel", "匹配理由可解释")}</span>
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
              <span>{copy("matchingCoreLabel", "匹配核心")}</span>
              <strong>AI</strong>
              <small>{copy("matchingCoreDetail", "目标 · 约束 · 可信度")}</small>
            </div>
          </motion.div>
        </section>
      )}

      <ContactProfileCard locale={locale} subplatform={subplatform} role="buyer" onNotice={onNotice} />

      {listings.length ? (
        <section className="discovery-panel" aria-label={copy("searchOffersLabel", "搜索供给")}>
          <label className="search-field">
            <Search size={20} aria-hidden="true" />
            <span className="sr-only">{copy("searchOffersLabel", "搜索供给")}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy("searchPlaceholder", "搜索名称、属性或地点")}
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
            <span>{copy("filterLabel", "筛选")}{activeFilters.size ? ` · ${activeFilters.size}` : ""}</span>
          </button> : null}
          {filterDefinitions.length && filtersOpen ? (
            <div className="filter-menu" role="group" aria-label={copy("advancedFilterLabel", "高级筛选")}>
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
                      onNotice(active
                        ? copy("filterRemovedNotice", `已移除筛选：${filter.label}`, `Removed filter: ${filter.label}`)
                        : copy("filterAddedNotice", `已启用筛选：${filter.label}`, `Added filter: ${filter.label}`));
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

      {showRecommendations ? (
        <section id="recommendations" className={`content-section${isRoot ? " root-content" : ""}`}>
          <SectionHeading
            eyebrow={subplatform.ui?.chat?.listingEyebrow}
            title={`${visible.length} ${locale === "zh" && subplatform.ui?.chat?.listingLabel
              ? subplatform.ui.chat.listingLabel
              : copy("listingCountLabel", "个可用供给", "available offers")}`}
          />
          {visible.length ? (
            <div className="listing-grid">
              {visible.map((listing, index) => (
                <AssetCard
                  key={listing.id}
                  listing={listing}
                  index={index}
                  saved={saved.has(listing.id)}
                  compared={compareIds.has(listing.id)}
                  onSave={() => toggleSaved(listing)}
                  onDismiss={() => dismissListing(listing)}
                  onCompare={() => toggleCompare(listing)}
                  onOpen={() => {
                    void recordBehavior(listing, "offer.open");
                    onOpenListing(listing);
                  }}
                  locale={locale}
                  matchLabel={copy("matchLabel", "匹配", "match")}
                  viewLabel={copy("viewOfferLabel", "查看", "View")}
                  saveLabel={copy("saveOfferLabel", "收藏", "Save")}
                  unsaveLabel={copy("unsaveOfferLabel", "取消收藏", "Remove from saved")}
                  dismissLabel={copy("dismissOfferLabel", "不太合适", "Not a fit")}
                  compareLabel={compareIds.has(listing.id) ? copy("removeCompareLabel", "取消比较", "Remove") : copy("compareLabel", "比较", "Compare")}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Search size={28} aria-hidden="true" />
              <h3>{query
                ? copy("searchEmptyTitle", "没有命中这次搜索", "No offers match this search")
                : copy("noOffersTitle", "等待供给方上传资料", "Waiting for supply partners to publish")}</h3>
              <p>
                {query
                  ? copy("searchEmptyDescription", "换一个名称、属性或地点试试。", "Try another name, attribute, or location.")
                  : copy("noOffersDescription", "平台不预置样例内容；供给方提交并通过审核后，这里会出现真实供给。", "There are no seeded examples. Approved offers will appear here after supply partners publish them.")}
              </p>
              {query ? <button type="button" onClick={() => setQuery("")}>{copy("clearSearchLabel", "清除搜索", "Clear search")}</button> : null}
              {!query ? <button type="button" onClick={() => { document.getElementById("match-chat-input")?.focus(); onNotice(copy("describeDemandNotice", "先描述你的目标，平台会从已激活的子平台开始路由", "Describe your goal and the platform will route it through active matching nodes.")); }}>{copy("describeDemandLabel", "描述需求", "Describe a need")}</button> : null}
            </div>
          )}
        </section>
      ) : null}

      {compareIds.size ? (
        <section className="surface compare-panel" aria-label={copy("compareLabel", "比较", "Compare")}>
          <div className="compare-panel-heading">
            <div><Scale size={18} aria-hidden="true" /><strong>{copy("compareTitle", "正在比较", "Comparing")}</strong><span>{compareIds.size}/3</span></div>
            <button type="button" className="text-action" onClick={() => setCompareIds(new Set())}>{copy("clearCompareLabel", "清空", "Clear")}</button>
          </div>
          <div className="compare-items">
            {[...compareIds].map((id) => {
              const listing = listings.find((candidate) => candidate.id === id);
              return listing ? <button key={id} type="button" onClick={() => onOpenListing(listing)}>{listing.title}</button> : null;
            })}
          </div>
        </section>
      ) : null}

      {introductions.length ? (
        <section className="surface buyer-contact-inbox" aria-labelledby="buyer-contact-inbox-title">
          <SectionHeading eyebrow={copy("contactInboxEyebrow", "撮合进度")} title={copy("contactInboxTitle", "双方同意后，查看联系方式")} />
          <ol className="submission-list">
            {introductions.map((entry) => {
              const { introduction, scope } = entry;
              const contact = contacts[introduction.introduction_id];
              return (
                <li key={introduction.introduction_id}>
                  <div>
                    <strong>{copy("contactRequestLabel", "一条撮合联系申请")}</strong>
                    <small>{buyerIntroductionStatus(introduction.status, copy)} · {scope.platformPath}</small>
                    {contact ? <div className="buyer-contact-values">{Object.entries(contact.counterpart.contact).map(([key, value]) => <span key={key}>{subplatformContactLabel(subplatform, key)}: {value}</span>)}</div> : null}
                  </div>
                  {contact ? <span className="submission-status">{copy("contactVisibleLabel", "已可联系")}</span> : introduction.supply_contact_consent_at ? (
                    <button className="text-action" type="button" onClick={() => void releaseContact(entry)} disabled={contactLoading === introduction.introduction_id}>
                      {contactLoading === introduction.introduction_id ? copy("contactReadingLabel", "读取中…") : copy("viewContactLabel", "查看联系方式")}
                    </button>
                  ) : <span className="submission-status">{copy("contactWaitingLabel", "等待供给方同意")}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {!isRoot ? <section className="offline-section" aria-labelledby="offline-title">
        <div className="offline-intro">
          <span className="eyebrow">{copy("offlineEyebrow", "线上撮合 · 线下协商")}</span>
          <h2 id="offline-title">{copy("offlineTitle", "双方在哪完成后续安排，由双方决定。")}</h2>
          <p>
            {copy("offlineDescription", "平台确认双方匹配与服务安排后，才按权限交换联系方式。线下完成后续安排也会保留撮合记录，平台只收取事先披露的服务费用。")}
          </p>
        </div>
        <ol className="offline-steps">
          <li>
            <span><UserRoundCheck aria-hidden="true" /></span>
            <div><small>01</small><strong>{copy("offlineStepOneTitle", "匹配并解锁联系", "Match and unlock contact")}</strong><p>{copy("offlineStepOneDescription", "仅双方可见，访问留有审计记录。", "Visible only to both parties, with access recorded.")}</p></div>
          </li>
          <li>
            <span><CalendarDays aria-hidden="true" /></span>
            <div><small>02</small><strong>{copy("offlineStepTwoTitle", "预约或线下协商", "Arrange a meeting or continue offline")}</strong><p>{copy("offlineStepTwoDescription", "地点和时间在双方确认后生效。", "Place and time take effect after both sides confirm.")}</p></div>
          </li>
          <li>
            <span><BadgeCheck aria-hidden="true" /></span>
            <div><small>03</small><strong>{copy("offlineStepThreeTitle", "确认结果与平台提成", "Confirm the outcome and platform fee")}</strong><p>{copy("offlineStepThreeDescription", "成交后按披露规则结算平台服务费。", "The platform fee follows the disclosed terms after completion.")}</p></div>
          </li>
        </ol>
      </section> : null}
    </div>
  );
}

function buyerIntroductionStatus(status: string, copy: (key: string, fallback: string) => string): string {
  return {
    proposed: copy("introductionProposedLabel", "已建立撮合"),
    contact_requested: copy("introductionRequestedLabel", "已申请联系"),
    contact_released: copy("introductionReleasedLabel", "对方已同意交换"),
    completed: copy("introductionCompletedLabel", "已完成"),
    declined: copy("introductionDeclinedLabel", "已拒绝"),
    expired: copy("introductionExpiredLabel", "已过期"),
  }[status] ?? copy("introductionProcessingLabel", "撮合处理中");
}

function matchesFilter(
  listing: AssetListing,
  filter: NonNullable<NonNullable<SubplatformConfig["ui"]>["filters"]>[number],
): boolean {
  if (filter.source === "trust") return Boolean(listing.trust?.length);
  if (filter.source === "price") return Boolean(listing.price.trim() && listing.price.trim() !== "—");
  if (!filter.attribute) return false;
  const fact = listing.facts.find((candidate) => candidate.key === filter.attribute || candidate.label === filter.attribute);
  if (!fact) return false;
  return filter.value === undefined || fact.value === filter.value;
}

function matchLevelForScore(score: number, locale: InterfaceLocale): string {
  if (locale === "en") {
    return score >= 80 ? "Strong fit" : score >= 60 ? "Good fit" : score >= 40 ? "Possible fit" : "Weak fit";
  }
  return score >= 80 ? "非常适合" : score >= 60 ? "比较适合" : score >= 40 ? "一般" : "不太适合";
}

function RootFlow({
  subplatform,
  childPlatforms,
  locale,
}: {
  subplatform: SubplatformConfig;
  childPlatforms: PlatformChildSummary[];
  locale: InterfaceLocale;
}) {
  const copy = (key: string, fallbackZh: string, fallbackEn = fallbackZh) => localizedSubplatformCopy(subplatform, locale, key, fallbackZh, fallbackEn);
  return (
    <details className="root-routing-disclosure">
      <summary>
        <span>{copy("moreEntryPointsLabel", "其他入口", "More entry points")}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="root-routing-disclosure-content">
        <a className="root-routing-seller-link" href={`${subplatform.path}?role=seller`}>
          {copy("supplyActionLabel", "我来提供", "I can provide")}
          <ArrowRight size={17} aria-hidden="true" />
        </a>
        {childPlatforms.length ? (
          <div className="root-platform-links" aria-label={copy("activePlatformsLabel", "已激活的平台", "Active platforms")}>
            {childPlatforms.map((child) => (
              <a className="root-platform-link-card" key={child.path} href={child.path}>
                <strong>{child.displayName}</strong>
                {child.description ? <small>{child.description}</small> : null}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssetCard({
  listing,
  index,
  saved,
  compared,
  locale,
  matchLabel,
  viewLabel,
  saveLabel,
  unsaveLabel,
  dismissLabel,
  compareLabel,
  onSave,
  onDismiss,
  onCompare,
  onOpen,
}: {
  listing: AssetListing;
  index: number;
  saved: boolean;
  compared: boolean;
  locale: InterfaceLocale;
  matchLabel: string;
  viewLabel: string;
  saveLabel: string;
  unsaveLabel: string;
  dismissLabel: string;
  compareLabel: string;
  onSave: () => void;
  onDismiss: () => void;
  onCompare: () => void;
  onOpen: () => void;
}) {
  const offerViewLabel = `${viewLabel} ${listing.title}`;
  return (
    <motion.article
      className="listing-card"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: index * 0.045 }}
      layout
    >
      <button className="listing-open" type="button" onClick={onOpen} aria-label={offerViewLabel}>
        <ListingVisual accent={listing.accent} label={listing.trust?.[0]} />
      </button>
      <motion.button
        type="button"
        className={`save-button${saved ? " is-saved" : ""}`}
        onClick={onSave}
        aria-label={saved ? `${unsaveLabel} ${listing.title}` : `${saveLabel} ${listing.title}`}
        aria-pressed={saved}
        whileTap={{ scale: 0.86 }}
        transition={spring}
      >
        <Heart size={19} fill={saved ? "currentColor" : "none"} aria-hidden="true" />
      </motion.button>
      <div className="listing-content">
        <div className="match-row">
          {listing.matchScore !== undefined ? <span className="match-score">{matchLevelForScore(listing.matchScore, locale)} · {matchLabel}</span> : null}
          {listing.location ? <span><MapPin size={14} aria-hidden="true" /> {listing.location}</span> : null}
        </div>
        <button className="listing-title-button" type="button" onClick={onOpen} aria-label={offerViewLabel}>
          <h3>{listing.title}</h3>
        </button>
        {listing.subtitle ? <p className="listing-subtitle">{listing.subtitle}</p> : null}
        {listing.facts.length ? (
          <dl className="listing-facts">
            {listing.facts.slice(0, 3).map((fact) => <div key={`${fact.label}-${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
          </dl>
        ) : null}
        {listing.reasons?.[0] ? (
          <div className="reason-line">
            <Sparkles size={15} aria-hidden="true" />
            <span>{listing.reasons[0]}</span>
          </div>
        ) : null}
        <div className="listing-feedback-actions">
          <button type="button" className="text-action" onClick={onDismiss}><ThumbsDown size={14} aria-hidden="true" />{dismissLabel}</button>
          <button type="button" className={`text-action${compared ? " is-active" : ""}`} onClick={onCompare}><Scale size={14} aria-hidden="true" />{compareLabel}</button>
        </div>
        <div className="price-row">
          <div><strong>{listing.price}</strong>{listing.priceLabel ? <small>{listing.priceLabel}</small> : null}</div>
          <motion.button className="round-arrow" type="button" aria-label={offerViewLabel} onClick={onOpen} whileTap={{ scale: 0.88 }} transition={spring}>
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
