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

// Sellers can review introductions visible to this party. Publishing an offer alone never
// grants access to buyer contact details.
const introductions = await client.listIntroductions(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  participant_id: capability.party_id,
});
const introductionId = readFirstIntroduction(introductions);
if (introductionId) {
  await client.consentContact(capability, {
    tenant_id: capability.tenant_id,
    domain_id: capability.domain_id,
    participant_id: capability.party_id,
    introduction_id: introductionId,
    idempotency_key: `contact-consent:${introductionId}`,
  });
  console.log("已同意一次联系方式交换；平台会按双方 consent policy 决定是否释放联系方式。", {
    offerId: readString(offer, "offer_id"),
    introductionId,
  });
} else {
  console.log("供给已发布，当前没有待处理的介绍。");
}

function readString(value: unknown, key: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error(`MatchPlane response is missing ${key}`);
}

function readFirstIntroduction(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const introductions = (value as Record<string, unknown>).introductions;
  if (!Array.isArray(introductions)) return null;
  const first = introductions[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const id = (first as Record<string, unknown>).introduction_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
