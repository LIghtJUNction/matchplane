"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getMarketplaceIntroductions,
  isLiveMarketplaceEnabled,
  retrieveMarketplaceContact,
  type MarketplaceContactResponse,
  type MarketplaceIntroduction,
} from "../api";
import { hasStoreContactRequested } from "../lib/contact-requests";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import {
  subplatformContactLabel,
  type SubplatformConfig,
} from "../subplatform";

const VISIBLE_STATUSES = new Set([
  "contact_requested",
  "contact_released",
  "completed",
]);

/**
 * Buyer-side counterpart of the seller consent list: lists this store's contact
 * requests and reveals the store's verified contact once staff approve.
 */
export function StoreContactRequestsPanel({
  subplatform,
  locale,
}: {
  subplatform: SubplatformConfig;
  locale: InterfaceLocale;
}) {
  const english = locale === "en";
  const [introductions, setIntroductions] = useState<
    MarketplaceIntroduction[]
  >([]);
  const [contacts, setContacts] = useState<
    Record<string, MarketplaceContactResponse>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revealingId, setRevealingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (
      !isLiveMarketplaceEnabled() ||
      subplatform.slug === "root" ||
      !subplatform.domainId ||
      !hasStoreContactRequested(subplatform.path)
    )
      return;
    setRefreshing(true);
    setError(null);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "buyer",
      });
      if (!session) return;
      const all = await getMarketplaceIntroductions({
        session,
        domainId: subplatform.domainId,
      });
      setIntroductions(
        all.filter(
          (item) =>
            item.demand_party_id === session.partyId &&
            VISIBLE_STATUSES.has(item.status),
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : english
            ? "Could not load contact requests."
            : "无法读取联系申请。",
      );
    } finally {
      setRefreshing(false);
    }
  }, [subplatform, english]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("matchplane.contact.updated", refresh);
    return () =>
      window.removeEventListener("matchplane.contact.updated", refresh);
  }, [load]);

  const reveal = async (introduction: MarketplaceIntroduction) => {
    if (!subplatform.domainId || revealingId) return;
    setRevealingId(introduction.introduction_id);
    setError(null);
    try {
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "buyer",
      });
      if (!session) {
        setError(
          english ? "Sign in to view the contact." : "请先登录，再查看联系方式。",
        );
        return;
      }
      const contact = await retrieveMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
      });
      setContacts((current) => ({
        ...current,
        [introduction.introduction_id]: contact,
      }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : english
            ? "Could not load the contact."
            : "联系方式暂时读取不了，请稍后再试。",
      );
    } finally {
      setRevealingId(null);
    }
  };

  if (!introductions.length && !error) return null;

  return (
    <section
      className="storefront-contact-requests"
      aria-labelledby="storefront-contact-requests-title"
    >
      <div className="storefront-contact-requests-heading">
        <div>
          <h2 id="storefront-contact-requests-title">
            {english ? "Contact requests" : "联系申请"}
          </h2>
          <span>
            {english
              ? "Verified contact details appear here after store staff approve."
              : "店员同意后，已验证联系方式会显示在这里。"}
          </span>
        </div>
        <button type="button" onClick={() => void load()} disabled={refreshing}>
          {refreshing
            ? english
              ? "Checking…"
              : "刷新中…"
            : english
              ? "Refresh"
              : "刷新"}
        </button>
      </div>
      {error ? (
        <p className="storefront-contact-requests-error" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="storefront-contact-requests-list">
        {introductions.map((introduction) => {
          const released = contacts[introduction.introduction_id];
          return (
            <li key={introduction.introduction_id}>
              <div>
                <strong>
                  {english ? "Contact request" : "联系申请"} ·{" "}
                  {formatRequestDate(introduction.created_at, locale)}
                </strong>
                {released ? (
                  <div className="buyer-contact-values">
                    <span>{released.counterpart.display_name}</span>
                    {Object.entries(released.counterpart.contact).map(
                      ([key, value]) => (
                        <span key={key}>
                          {subplatformContactLabel(subplatform, key)}: {value}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
              {released ? (
                <span className="submission-status">
                  {english ? "Contact available" : "已可联系"}
                </span>
              ) : introduction.supply_contact_consent_at ? (
                <button
                  className="text-action"
                  type="button"
                  onClick={() => void reveal(introduction)}
                  disabled={revealingId === introduction.introduction_id}
                >
                  {revealingId === introduction.introduction_id
                    ? english
                      ? "Loading…"
                      : "读取中…"
                    : english
                      ? "View contact"
                      : "查看对方联系方式"}
                </button>
              ) : (
                <span className="submission-status">
                  {english ? "Waiting for store approval" : "等待店员同意"}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatRequestDate(value: string, locale: InterfaceLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? locale === "en"
      ? "Unknown time"
      : "时间未知"
    : date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN");
}
