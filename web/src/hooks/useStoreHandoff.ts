"use client";

import { useCallback } from "react";
import {
  createBuyerIntroduction,
  createMarketplaceIntent,
  createMarketplaceIntroduction,
  createMarketplaceSalesHandoff,
  getMarketplaceIntroductions,
  isLiveMarketplaceEnabled,
  listingIdFromBackend,
  recordMarketplaceBehaviorEvent,
  requestMarketplaceContact,
  retrieveMarketplaceContact,
  type MallAssistantContactConsentAction,
  type MarketplaceContactResponse,
  type PartySession,
} from "../api";
import { markStoreContactRequested } from "../lib/contact-requests";
import { getMarketplaceSession } from "../lib/marketplace-session";
import {
  clearPendingConversion,
  ensurePendingConversion,
  updatePendingConversion,
} from "../pending-conversion";
import {
  loadSubplatform,
  subplatformCopy,
  type SubplatformConfig,
} from "../subplatform";
import type { AssetListing } from "../types";

const CANONICAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function conversionIdempotencyKey(
  session: Pick<PartySession, "partyId">,
  action: string,
  conversionAttemptId: string,
  intentId: string | null,
  offerId: string | null,
): string {
  if (
    !/^[a-z0-9-]{1,48}$/.test(action) ||
    !CANONICAL_ID.test(session.partyId) ||
    !CANONICAL_ID.test(conversionAttemptId) ||
    (intentId !== null && !CANONICAL_ID.test(intentId)) ||
    (offerId !== null && !CANONICAL_ID.test(offerId))
  )
    throw new Error("conversion idempotency scope is invalid");
  return [
    "conversion",
    action,
    session.partyId,
    conversionAttemptId,
    intentId ?? "no-intent",
    offerId ?? "no-offer",
  ].join(":");
}

function activeIntentIdempotencyKey(
  session: Pick<PartySession, "partyId">,
  domainId: string,
  offerId: string | null,
): string {
  if (
    !CANONICAL_ID.test(session.partyId) ||
    !CANONICAL_ID.test(domainId) ||
    (offerId !== null && !CANONICAL_ID.test(offerId))
  )
    throw new Error("active intent idempotency scope is invalid");
  return [
    "active-intent",
    session.partyId,
    domainId,
    offerId ?? "general",
  ].join(":");
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
        throw new Error("同意卡关联的商品已经下架，请继续咨询店长");
      const proposedAttemptId = crypto.randomUUID();
      const pending = ensurePendingConversion({
        storePath: subplatform.path,
        offerId: selected.offerId,
        action: "store_ai_contact_consent",
        conversionAttemptId: proposedAttemptId,
      });
      const conversionAttemptId =
        pending?.conversionAttemptId ?? proposedAttemptId;
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
        narrative: "用户确认进一步了解已选商品，并发起联系申请。",
        attributes: {
          source: "store_ai_contact_consent",
          offer_id: selected.offerId,
          platform_path: subplatform.path,
        },
        supplyDiscoveryEnabled: false,
        idempotencyKey: activeIntentIdempotencyKey(
          session,
          subplatform.domainId,
          selected.offerId,
        ),
      });
      const introduction = await createMarketplaceIntroduction({
        session,
        domainId: subplatform.domainId,
        intentId: intent.intent_id,
        offerId: selected.offerId,
        score: (selected.matchScore ?? 0) / 100,
        idempotencyKey: conversionIdempotencyKey(
          session,
          "store-ai-consent-introduction",
          conversionAttemptId,
          intent.intent_id,
          selected.offerId,
        ),
      });
      const introductionId =
        typeof introduction.introduction_id === "string"
          ? introduction.introduction_id
          : null;
      if (!introductionId)
        throw new Error("撮合结果缺少介绍编号，未发送联系申请");
      const requestedIntroduction = await requestMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId,
        idempotencyKey: conversionIdempotencyKey(
          session,
          "store-ai-contact-request",
          conversionAttemptId,
          intent.intent_id,
          selected.offerId,
        ),
      });
      markStoreContactRequested(subplatform.path);
      updatePendingConversion(selected.offerId, {
        actorId: session.partyId,
        intentId: intent.intent_id,
        idempotencyKey: conversionIdempotencyKey(
          session,
          "store-ai-contact-request",
          conversionAttemptId,
          intent.intent_id,
          selected.offerId,
        ),
      });
      await Promise.allSettled([
        recordMarketplaceBehaviorEvent({
          session,
          domainId: subplatform.domainId,
          eventType: "ai_qualified",
          intentId: intent.intent_id,
          offerId: selected.offerId,
          metadata: { source: "store_ai_contact_consent" },
          idempotencyKey: conversionIdempotencyKey(
            session,
            "behavior-ai-qualified",
            conversionAttemptId,
            intent.intent_id,
            selected.offerId,
          ),
        }),
        recordMarketplaceBehaviorEvent({
          session,
          domainId: subplatform.domainId,
          eventType: "contact",
          intentId: intent.intent_id,
          offerId: selected.offerId,
          metadata: { source: "store_ai_contact_consent" },
          idempotencyKey: conversionIdempotencyKey(
            session,
            "behavior-contact",
            conversionAttemptId,
            intent.intent_id,
            selected.offerId,
          ),
        }),
      ]);
      clearPendingConversion(selected.offerId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("matchplane.contact.updated"));
        window.dispatchEvent(new Event("matchplane:notifications-updated"));
      }
      onNotice(
        "联系申请已保存；店员侧投影状态待后台确认。店员同意后，可在店铺页「联系申请」查看对方联系方式",
      );
      return requestedIntroduction;
    },
    [subplatform, listings, onNotice],
  );

  const retrieveStoreContact = useCallback(
    async (
      action: MallAssistantContactConsentAction,
    ): Promise<MarketplaceContactResponse | null> => {
      if (!isLiveMarketplaceEnabled())
        throw new Error("当前环境未连接真实撮合 API");
      if (!subplatform.domainId || subplatform.slug === "root")
        throw new Error("当前店铺尚未完成联系交换配置");
      const selected = listings.find(
        (item) =>
          item.offerId === action.productId || item.id === action.productId,
      );
      if (!selected?.offerId)
        throw new Error("同意卡关联的商品已经下架，请继续咨询店长");
      const session = await getMarketplaceSession({
        subplatform: subplatform.slug,
        platformPath: subplatform.path,
        tenantId: subplatform.tenantId,
        domainId: subplatform.domainId,
        role: "buyer",
      });
      if (!session) throw new Error("登录后才能查看联系方式交换状态");
      const introductions = await getMarketplaceIntroductions({
        session,
        domainId: subplatform.domainId,
      });
      const matchingIntroductions = introductions.filter(
        (item) =>
          item.offer_id === selected.offerId &&
          item.demand_party_id === session.partyId,
      );
      const introduction =
        matchingIntroductions.find((item) => item.supply_contact_consent_at) ??
        matchingIntroductions[0];
      if (!introduction)
        throw new Error("尚未找到这件商品的联系申请，请先发起申请");
      if (!introduction.supply_contact_consent_at) return null;

      const contact = await retrieveMarketplaceContact({
        session,
        domainId: subplatform.domainId,
        introductionId: introduction.introduction_id,
        idempotencyKey: `store-ai-contact-retrieve:${introduction.introduction_id}:${session.partyId}`,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("matchplane.contact.updated"));
        window.dispatchEvent(new Event("matchplane:notifications-updated"));
      }
      return contact;
    },
    [listings, subplatform],
  );

  const requestStoreAiHandoff = useCallback(
    async (input: {
      requestId: string;
      conversionAttemptId: string;
      intent: "warm" | "high" | "urgent";
      productIds: string[];
    }) => {
      if (!subplatform.domainId || subplatform.slug === "root")
        throw new Error("当前店铺尚未接入客户跟进能力");
      const productIds = [
        ...new Set(
          input.productIds.filter((productId) =>
            listings.some((listing) => listing.offerId === productId),
          ),
        ),
      ]
        .sort()
        .slice(0, 16);
      const pendingOfferId = productIds[0] ?? "general-handoff";
      ensurePendingConversion({
        storePath: subplatform.path,
        offerId: pendingOfferId,
        action: "store_ai_handoff",
        conversionAttemptId: input.conversionAttemptId,
        intentLevel: input.intent,
        productIds,
      });
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
      const deidentifiedSummary = `用户明确请求店员协助；意向等级：${input.intent}；关联商品：${productIds.length} 个。未包含聊天原文或联系方式。`;
      const intent = await createMarketplaceIntent({
        session,
        domainId: subplatform.domainId,
        side: "demand",
        narrative: deidentifiedSummary,
        attributes: {
          source: "store_ai_manager",
          platform_path: subplatform.path,
          product_ids: productIds,
          intent_strength: input.intent,
        },
        supplyDiscoveryEnabled: false,
        idempotencyKey: activeIntentIdempotencyKey(
          session,
          subplatform.domainId,
          productIds[0] ?? null,
        ),
      });
      const handoff = await createMarketplaceSalesHandoff({
        session,
        domainId: subplatform.domainId,
        intentId: intent.intent_id,
        summary: {
          source: "store_ai_manager",
          platform_path: subplatform.path,
          analysis: deidentifiedSummary,
          intent_strength: input.intent,
          product_ids: productIds,
          ai_continues: true,
          contact_consent: "not_requested",
        },
        idempotencyKey: conversionIdempotencyKey(
          session,
          "store-ai-handoff",
          input.conversionAttemptId,
          intent.intent_id,
          productIds[0] ?? null,
        ),
      });
      if (!handoff.handoff_id) throw new Error("人工介入记录缺少编号");
      clearPendingConversion(pendingOfferId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("matchplane.contact.updated"));
      }
      onNotice(
        locale === "en"
          ? "The handoff request was saved. Delivery status is pending confirmation."
          : "人工介入请求已保存，通知投递状态待后台确认。",
      );
    },
    [subplatform, listings, locale, onNotice],
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
      const listingId = isGenericOffer ? null : listingIdFromBackend(selected);
      if (!isGenericOffer && !listingId) {
        throw new Error("商品必须来自已接入店铺的真实目录；当前未发送申请");
      }
      if (
        !selectedDomainId ||
        (!isGenericOffer && !selectedSubplatform.currency)
      ) {
        throw new Error("当前店铺尚未完成身份与价格配置；当前未发送申请");
      }
      try {
        const pendingOfferId = selected.offerId ?? listingId ?? selected.id;
        const proposedAttemptId = crypto.randomUUID();
        const pending = ensurePendingConversion({
          storePath: selectedPath,
          offerId: pendingOfferId,
          action: "contact_listing",
          conversionAttemptId: proposedAttemptId,
        });
        const conversionAttemptId =
          pending?.conversionAttemptId ?? proposedAttemptId;
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
                narrative: "我想进一步了解已选商品，并申请联系店员。",
                attributes: {
                  source: "public_storefront",
                  offer_id: selected.offerId,
                  platform_path: selectedPath,
                },
                supplyDiscoveryEnabled: false,
                idempotencyKey: activeIntentIdempotencyKey(
                  session,
                  selectedDomainId,
                  selected.offerId,
                ),
              })
            ).intent_id;
          updatePendingConversion(selected.offerId, {
            actorId: session.partyId,
            intentId: selectedIntentId,
            idempotencyKey: conversionIdempotencyKey(
              session,
              "web-contact-request",
              conversionAttemptId,
              selectedIntentId,
              selected.offerId,
            ),
          });
          const introduction = await createMarketplaceIntroduction({
            session,
            domainId: selectedDomainId,
            intentId: selectedIntentId,
            offerId: selected.offerId,
            score: (selected.matchScore ?? 0) / 100,
            idempotencyKey: conversionIdempotencyKey(
              session,
              "web-introduction",
              conversionAttemptId,
              selectedIntentId,
              selected.offerId,
            ),
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
            idempotencyKey: conversionIdempotencyKey(
              session,
              "web-contact-request",
              conversionAttemptId,
              selectedIntentId,
              selected.offerId,
            ),
          });
          markStoreContactRequested(selectedPath);
          await Promise.allSettled([
            recordMarketplaceBehaviorEvent({
              session,
              domainId: selectedDomainId,
              eventType: "contact",
              intentId: selectedIntentId,
              offerId: selected.offerId,
              metadata: { source: "public_storefront" },
              idempotencyKey: conversionIdempotencyKey(
                session,
                "behavior-contact",
                conversionAttemptId,
                selectedIntentId,
                selected.offerId,
              ),
            }),
          ]);
          clearPendingConversion(selected.offerId);
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
            exposureKey: conversionIdempotencyKey(
              session,
              "web-legacy-contact",
              conversionAttemptId,
              null,
              listingId,
            ),
          });
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("matchplane.contact.updated"));
          window.dispatchEvent(new Event("matchplane:notifications-updated"));
        }
        onNotice(
          "联系申请已写入撮合系统；店员通知投递状态待后台确认，供给方同意前不会交换联系方式",
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "联系申请未发送，请稍后重试";
        onNotice(message);
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [subplatform, listings, onNotice],
  );

  return {
    requestStoreContactConsent,
    retrieveStoreContact,
    requestStoreAiHandoff,
    contactListing,
  };
}
