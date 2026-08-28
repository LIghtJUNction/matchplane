import { MatchPlaneAgentClient } from "../src/index";

declare const process: { env: Record<string, string | undefined> };

/**
 * A server-side supply Agent. It uses the same client and capability shape as the buyer Agent;
 * only the side and the child-owned offer payload differ.
 */
const client = new MatchPlaneAgentClient({
  baseUrl: process.env.MATCHPLANE_URL!,
  apiKey: process.env.MATCHPLANE_SELLER_API_KEY!,
});

const capability = await client.openMarketplaceSession({
  tenant_id: process.env.MATCHPLANE_TENANT_ID!,
  domain_id: process.env.MATCHPLANE_DOMAIN_ID!,
  platform_path: process.env.MATCHPLANE_PLATFORM_PATH || "/",
  side: "supply",
});

const offer = await client.createOffer(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  supply_party_id: capability.party_id,
  external_key: process.env.SELLER_OFFER_KEY ?? crypto.randomUUID(),
  display_name: process.env.SELLER_OFFER_NAME ?? "供给方案",
  attributes: {},
  terms: {},
});

const offerId = readString(offer, "offer_id");
const demandLeads = await client.matchDemands(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  participant_id: capability.party_id,
  offer_id: offerId,
  limit: 10,
});
console.log("已获取买方主动公开的匿名需求摘要；后续引介仍需需求方发起并由供给方同意联系人交换。", {
  offerId,
  demandLeads,
});

// A match is never consent. Collect the authenticated supply party's explicit opt-in outside this
// process, then pass only that reviewed introduction id. An unset value is intentionally fail-closed;
// never select or consent to the first match automatically.
await client.listIntroductions(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  participant_id: capability.party_id,
});
const consentedIntroductionId = process.env.MATCHPLANE_CONSENTED_INTRODUCTION_ID;
if (consentedIntroductionId) {
  await client.consentContact(capability, {
    tenant_id: capability.tenant_id,
    domain_id: capability.domain_id,
    participant_id: capability.party_id,
    introduction_id: consentedIntroductionId,
    idempotency_key: `contact-consent:${consentedIntroductionId}`,
  });
  console.log("已记录供给方明确同意；平台仍会按双方 consent policy 决定是否释放联系方式。", {
    offerId,
    introductionId: consentedIntroductionId,
  });
} else {
  console.log("供给已发布；未收到供给方明确同意，不执行联系方式交换。", { offerId });
}

function readString(value: unknown, key: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error(`MatchPlane response is missing ${key}`);
}
