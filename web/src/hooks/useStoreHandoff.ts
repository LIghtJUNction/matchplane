"use client";

import { useCallback } from "react";
import {
  createBuyerIntroduction,
  createMarketplaceIntent,
  createMarketplaceIntroduction,
  createMarketplaceSalesHandoff,
  getMarketplaceProfile,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  notifyStoreCustomerHandoff,
  requestMarketplaceContact,
  type MallAssistantContactConsentAction,
} from "../api";
import { markStoreContactRequested } from "../lib/contact-requests";
import { getMarketplaceSession } from "../lib/marketplace-session";
import { loadSubplatform, subplatformCopy, type SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";

export function stableIdempotencyPart(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function readSavedOfferIds(platformPath: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.localStorage.getItem(`matchplane.saved.${platformPath}`) ?? "[]",
    ) as unknown;
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .slice(0, 32)
      : [];
  } catch {
    return [];
  }
}

interface UseStoreHandoffOptions {
  subplatform: SubplatformConfig;
  listings: AssetListing[];
  locale: "zh" | "en";
  onNotice: (message: string) => void;
}

export function useStoreHandoff({
  subplatform,
  listings,
  locale,
  onNotice,
}: UseStoreHandoffOptions) {
  const requestStoreContactConsent = useCallback(
    async (action: MallAssistantContactConsentAction) => {
      if (!isLiveMarketplaceEnabled())
        throw new Error("当前环境未连接真实撮合 API");
      if (!subplatform.domainId || subplatform.slug === "root")
        throw new Error("当前店铺尚未完成联系交换配置");
      const selected = listings.find(
        (item) =>
          item.offerId === action.productId || item.id === action.productId,
      );
      if (!selected?.offerId)
        throw new Error("同意卡关联的商品已经下架，请继续咨询 AI 店长");
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "buyer",
      });
      if (!session) {
        if (typeof window !== "undefined") {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        }
        throw new Error("登录后才能确认联系方式交换");
      }
      const intent = await createMarketplaceIntent({
        session,
        domainId: subplatform.domainId,
        side: "demand",
        narrative: `我同意使用账号中已验证的联系方式，进一步了解并购买“${selected.title}”`,
        attributes: {
          source: "store_ai_contact_consent",
          offer_id: selected.offerId,
          platform_path: subplatform.path,
        },
        supplyDiscoveryEnabled: false,
        idempotencyKey: `store-ai-contact-${selected.offerId}`,
      });
      const profile = await getMarketplaceProfile({
        session,
        domainId: subplatform.domainId,
      }).catch(() => null);
      const handoff = await createMarketplaceSalesHandoff({
        session,
        domainId: subplatform.domainId,
        intentId: intent.intent_id,
        summary: {
          source: "store_ai_contact_consent",
          offer_id: selected.offerId,
          offer_title: selected.title,
          platform_path: subplatform.path,
          analysis: action.reason,
          intent_strength: "high",
          product_ids: [selected.offerId],
          profile: profile?.profile ?? null,
          ai_continues: true,
          contact_consent: "accepted",
        },
        idempotencyKey: `store-ai-consent-handoff-${intent.intent_id}-${selected.offerId}`,
      });
      const introduction = await createMarketplaceIntroduction({
        session,
        domainId: subplatform.domainId,
        intentId: intent.intent_id,
        offerId: selected.offerId,
        score: (selected.matchScore ?? 0) / 100,
        idempotencyKey: `store-ai-consent-${Date.now()}`,
      });
      const introductionId =
        typeof introduction.introduction_id === "string"
          ? introduction.introduction_id
          : null;
      if (!introductionId)
        throw new Error("撮合结果缺少介绍编号，未发送联系申请");
      await requestMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId,
      });
      markStoreContactRequested(subplatform.path);
      const handoffId =
        typeof handoff.handoff_id === "string" ? handoff.handoff_id : null;
      if (handoffId)
        await notifyStoreCustomerHandoff(subplatform.path, handoffId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("matchplane.contact.updated"));
      }
      onNotice(
        "联系申请已发送；店员同意后，可在店铺页「联系申请」查看对方联系方式",
      );
    },
    [subplatform, listings, onNotice],
  );

  const requestStoreAiHandoff = useCallback(
    async (input: {
      requestId: string;
      summary: string;
      intent: "warm" | "high" | "urgent";
      productIds: string[];
    }) => {
      if (!subplatform.domainId || subplatform.slug === "root")
        throw new Error("当前店铺尚未接入客户跟进能力");
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "buyer",
      });
      if (!session) {
        if (typeof window !== "undefined") {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        }
        throw new Error("登录后才能请求人工介入");
      }
      const signalKey = stableIdempotencyPart(
        [
          subplatform.path,
          input.intent,
          input.summary,
          ...[...input.productIds].sort(),
        ].join("\n"),
      );
      const intent = await createMarketplaceIntent({
        session,
        domainId: subplatform.domainId,
        side: "demand",
        narrative: input.summary,
        attributes: {
          source: "store_ai_manager",
          platform_path: subplatform.path,
          product_ids: input.productIds,
          intent_strength: input.intent,
        },
        supplyDiscoveryEnabled: false,
        idempotencyKey: `store-ai-intent-${signalKey}`,
      });
      const handoff = await createMarketplaceSalesHandoff({
        session,
        domainId: subplatform.domainId,
        intentId: intent.intent_id,
        summary: {
          source: "store_ai_manager",
          platform_path: subplatform.path,
          analysis: input.summary,
          intent_strength: input.intent,
          product_ids: input.productIds,
          ai_continues: true,
          contact_consent: "not_requested",
        },
        idempotencyKey: `store-ai-handoff-${signalKey}`,
      });
      const handoffId =
        typeof handoff.handoff_id === "string" ? handoff.handoff_id : null;
      if (!handoffId) throw new Error("人工介入记录缺少编号");
      await notifyStoreCustomerHandoff(subplatform.path, handoffId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("matchplane.contact.updated"));
      }
      onNotice(
        locale === "en"
          ? "Store staff were notified. The AI manager remains available."
          : "已通知店员，AI 店长会继续和你对话。",
      );
    },
    [subplatform, locale, onNotice],
  );

  const contactListing = useCallback(
    async (selected: AssetListing) => {
      const selectedPath = selected.platformPath || subplatform.path;
      const selectedSubplatform =
        selectedPath !== subplatform.path && selected.subplatform
          ? {
              ...(await loadSubplatform(selectedPath)),
              path: selectedPath,
              slug: selected.subplatform,
              ...(selected.tenantId ? { tenantId: selected.tenantId } : {}),
              ...(selected.domainId ? { domainId: selected.domainId } : {}),
            }
          : subplatform;
      const selectedTenantId =
        selected.tenantId || selectedSubplatform.tenantId;
      const selectedDomainId =
        selected.domainId || selectedSubplatform.domainId;
      if (!isLiveMarketplaceEnabled()) {
        throw new Error("当前环境未连接真实撮合 API，未发送联系申请");
      }
      const isGenericOffer = Boolean(selected.offerId);
      const listingId = isGenericOffer
        ? null
        : listingIdFromBackend(selected);
      if (!isGenericOffer && !listingId) {
        throw new Error(
          "商品必须来自已接入店铺的真实目录；当前未发送申请",
        );
      }
      if (
        !selectedDomainId ||
        (!isGenericOffer && !selectedSubplatform.currency)
      ) {
        throw new Error("当前店铺尚未完成身份与价格配置；当前未发送申请");
      }
      try {
        const session = await getMarketplaceSession({
          subplatform: selectedSubplatform.slug,
          platformPath: selectedPath,
          tenantId: selectedTenantId,
          domainId: selectedDomainId,
          role: "buyer",
        });
        if (!session) {
          if (typeof window !== "undefined") {
            const next = `${window.location.pathname}${window.location.search}`;
            window.location.assign(`/login?next=${encodeURIComponent(next)}`);
          }
          throw new Error("登录后才能申请联系");
        }
        if (isGenericOffer && selected.offerId) {
          const selectedIntentId =
            selected.intentId ??
            (
              await createMarketplaceIntent({
                session,
                domainId: selectedDomainId,
                side: "demand",
                narrative: `我想进一步了解并购买“${selected.title}”`,
                attributes: {
                  source: "public_storefront",
                  offer_id: selected.offerId,
                  platform_path: selectedPath,
                },
                supplyDiscoveryEnabled: false,
                idempotencyKey: `public-offer-${selected.offerId}`,
              })
            ).intent_id;
          const profile = await getMarketplaceProfile({
            session,
            domainId: selectedDomainId,
          }).catch(() => null);
          try {
            await createMarketplaceSalesHandoff({
              session,
              domainId: selectedDomainId,
              intentId: selectedIntentId,
              summary: {
                source: "buyer_contact_request",
                offer_id: selected.offerId,
                offer_title: selected.title,
                platform_path: selectedPath,
                profile: profile?.profile ?? null,
                match_level:
                  selected.matchScore === undefined
                    ? null
                    : selected.matchScore >= 80
                      ? "very_suitable"
                      : selected.matchScore >= 60
                        ? "suitable"
                        : selected.matchScore >= 40
                          ? "possible"
                          : "weak",
                reasons: selected.reasons ?? [],
                risks: selected.risks ?? [],
                recent_offer_ids: listings
                  .filter((item) => item.platformPath === selectedPath)
                  .map((item) => item.offerId ?? item.id)
                  .slice(0, 32),
                saved_offer_ids: readSavedOfferIds(selectedPath),
              },
              idempotencyKey: `web-handoff-${selectedIntentId}-${selected.offerId}`,
            });
          } catch {
            // A missing optional handoff migration must not prevent a consent-gated contact request.
          }
          const introduction = await createMarketplaceIntroduction({
            session,
            domainId: selectedDomainId,
            intentId: selectedIntentId,
            offerId: selected.offerId,
            score: (selected.matchScore ?? 0) / 100,
            idempotencyKey: `web-introduction-${Date.now()}`,
          });
          const introductionId =
            typeof introduction.introduction_id === "string"
              ? introduction.introduction_id
              : null;
          if (!introductionId)
            throw new Error("撮合结果缺少介绍编号，未发送联系申请");
          await requestMarketplaceContact({
            session,
            domainId: selectedDomainId,
            introductionId,
          });
          markStoreContactRequested(selectedPath);
        } else if (listingId && selectedSubplatform.currency) {
          await createBuyerIntroduction({
            session,
            domainId: selectedDomainId,
            listingId,
            narrative: subplatformCopy(
              selectedSubplatform,
              "contactIntentNarrative",
              "希望与供给方直接沟通并完成后续协商",
            ),
            requirements: {},
            currency: selectedSubplatform.currency,
            currencyScale: selectedSubplatform.currencyScale ?? 0,
            exposureKey: `web-contact-${Date.now()}`,
          });
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("matchplane.contact.updated"));
        }
        onNotice(
          "联系申请已写入撮合系统，等待供给方明确同意后交换联系方式",
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "联系申请未发送，请稍后重试";
        onNotice(message);
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [subplatform, listings, onNotice],
  );

  return {
    requestStoreContactConsent,
    requestStoreAiHandoff,
    contactListing,
  };
}
