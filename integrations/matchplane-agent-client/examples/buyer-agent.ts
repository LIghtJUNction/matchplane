import { MatchPlaneAgentClient, terminalRoutePlanPaths } from "../src/index";

declare const process: { env: Record<string, string | undefined> };

/**
 * A server-side buyer Agent. The mounted platform owns the meaning of attributes and terms;
 * this example intentionally contains no vehicle/category fields.
 */
const client = new MatchPlaneAgentClient({
  baseUrl: process.env.MATCHPLANE_URL!,
  apiKey: process.env.MATCHPLANE_BUYER_API_KEY!,
});

const narrative = process.env.MATCHPLANE_BUYER_REQUEST ?? "寻找符合预算和时间要求的方案";
const route = await client.routePlatformIntent({
  platform_path: "/",
  narrative,
  idempotency_key: crypto.randomUUID(),
});

const routedPath = terminalRoutePlanPaths(route)[0] ?? process.env.MATCHPLANE_PLATFORM_PATH ?? "/";
const capability = await client.openMarketplaceSession({
  tenant_id: process.env.MATCHPLANE_TENANT_ID!,
  domain_id: process.env.MATCHPLANE_DOMAIN_ID!,
  platform_path: routedPath,
  side: "demand",
});

const intent = await client.createIntent(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  participant_id: capability.party_id,
  side: "demand",
  narrative,
  attributes: {},
  terms: {},
  idempotency_key: crypto.randomUUID(),
});

const intentId = readString(intent, "intent_id");
const matches = await client.matchOffers(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  participant_id: capability.party_id,
  intent_id: intentId,
  limit: 10,
});
const first = readFirstCandidate(matches);
if (!first) {
  throw new Error("没有找到合适供给；可以继续澄清需求后创建新的幂等 intent");
}

const introduction = await client.createIntroduction(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  participant_id: capability.party_id,
  intent_id: intentId,
  offer_id: first.offer_id,
  score: first.score,
  reasons: first.reasons,
  idempotency_key: crypto.randomUUID(),
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});
const introductionId = readString(introduction, "introduction_id");

// A match never exposes contact values. This only asks the supply participant to consent.
await client.requestContact(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  participant_id: capability.party_id,
  introduction_id: introductionId,
  idempotency_key: `contact-request:${introductionId}`,
});

function readString(value: unknown, key: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error(`MatchPlane response is missing ${key}`);
}

function readFirstCandidate(value: unknown): { offer_id: string; score: number; reasons: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return null;
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.offer_id !== "string" || typeof record.score !== "number") return null;
  const reasons = Array.isArray(record.reasons) ? record.reasons.filter((item): item is string => typeof item === "string") : [];
  return { offer_id: record.offer_id, score: record.score, reasons };
}
