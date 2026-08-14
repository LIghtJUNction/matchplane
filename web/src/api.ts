import type { VehicleListing } from "./types";

const apiBase = (process.env.NEXT_PUBLIC_MATCHPLANE_API_BASE_URL ?? "/api").replace(/\/$/, "");

export interface PartySession {
  tenantId: string;
  partyId: string;
  role: "buyer" | "seller" | "both";
  accessToken: string;
}

export interface ContactExchange {
  phone?: string;
  wechat?: string;
}

export interface OfflineDeal {
  offline_deal_id: string;
  tenant_id: string;
  listing_id: string;
  buyer_request_id: string;
  seller_party_id: string;
  buyer_party_id: string;
  status: string;
  seller_contact_consent_at: string | null;
  contact_released_at: string | null;
  commission_collection: string;
  [key: string]: unknown;
}

export interface ContactResponse {
  counterpart: {
    party_id: string;
    display_name: string;
    contact: ContactExchange;
  };
  deal: OfflineDeal;
  vehicle_settlement: string;
  platform_commission_settlement: string;
}

export class MarketplaceApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MarketplaceApiError";
    this.status = status;
  }
}

function authorization(session: PartySession): string {
  return `Bearer ${session.accessToken}`;
}

async function request<T>(path: string, init: RequestInit = {}, session?: PartySession): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (session) headers.set("authorization", authorization(session));
  const response = await fetch(`${apiBase}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the HTTP status when an upstream error is not JSON.
    }
    throw new MarketplaceApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function isLiveMarketplaceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MATCHPLANE_LIVE_MODE === "true";
}

export function readPartySession(role: PartySession["role"]): PartySession | null {
  try {
    const raw = window.localStorage.getItem(`matchplane.party.${role}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PartySession;
    if (
      typeof parsed.tenantId !== "string" ||
      typeof parsed.partyId !== "string" ||
      typeof parsed.accessToken !== "string" ||
      !["buyer", "seller", "both"].includes(parsed.role)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePartySession(session: PartySession): void {
  window.localStorage.setItem(`matchplane.party.${session.role}`, JSON.stringify(session));
}

export async function registerParty(input: {
  tenantId: string;
  externalKey: string;
  displayName: string;
  role: PartySession["role"];
  contact: ContactExchange;
}): Promise<PartySession> {
  const result = await request<{
    party_id: string;
    role: PartySession["role"];
    tenant_id: string;
    access_token: string;
  }>("/v1/marketplace/parties", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      external_key: input.externalKey,
      display_name: input.displayName,
      role: input.role,
      contact: input.contact,
    }),
  });
  const session: PartySession = {
    tenantId: result.tenant_id,
    partyId: result.party_id,
    role: result.role,
    accessToken: result.access_token,
  };
  savePartySession(session);
  return session;
}

export async function createBuyerIntroduction(input: {
  session: PartySession;
  domainId: string;
  listingId: string;
  narrative: string;
  requirements: Record<string, unknown>;
  budgetMin?: string;
  budgetMax?: string;
  currency: string;
  currencyScale: number;
  exposureKey: string;
}): Promise<OfflineDeal> {
  const requestResult = await request<{ request_id: string }>(
    "/v1/marketplace/buyer-requests",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        buyer_party_id: input.session.partyId,
        narrative: input.narrative,
        requirements: input.requirements,
        budget_min: input.budgetMin ?? null,
        budget_max: input.budgetMax ?? null,
        currency: input.currency,
        currency_scale: input.currencyScale,
      }),
    },
    input.session,
  );
  const recommendations = await request<Array<{ listing_id: string }>>(
    `/v1/marketplace/buyer-requests/${requestResult.request_id}/recommendations`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        buyer_party_id: input.session.partyId,
        exposure_key: input.exposureKey,
        limit: 20,
      }),
    },
    input.session,
  );
  if (!recommendations.some((item) => item.listing_id === input.listingId)) {
    throw new MarketplaceApiError(409, "这台车不满足当前需求，请刷新匹配理由后再试");
  }
  const outcome = await request<{ offline_deal_id: string }>(
    "/v1/marketplace/offline-deals",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        listing_id: input.listingId,
        buyer_request_id: requestResult.request_id,
        buyer_party_id: input.session.partyId,
      }),
    },
    input.session,
  );
  return request<OfflineDeal>(
    `/v1/marketplace/offline-deals/${outcome.offline_deal_id}?tenant_id=${input.session.tenantId}&party_id=${input.session.partyId}`,
    {},
    input.session,
  );
}

export function listOfflineDeals(session: PartySession): Promise<OfflineDeal[]> {
  return request<OfflineDeal[]>(
    `/v1/marketplace/offline-deals?tenant_id=${session.tenantId}&party_id=${session.partyId}`,
    {},
    session,
  );
}

export function acceptContactExchange(
  session: PartySession,
  offlineDealId: string,
): Promise<OfflineDeal> {
  return request<OfflineDeal>(
    `/v1/marketplace/offline-deals/${offlineDealId}/contact/accept`,
    {
      method: "POST",
      body: JSON.stringify({ tenant_id: session.tenantId, party_id: session.partyId }),
    },
    session,
  );
}

export function retrieveContact(
  session: PartySession,
  offlineDealId: string,
): Promise<ContactResponse> {
  return request<ContactResponse>(
    `/v1/marketplace/offline-deals/${offlineDealId}/contact?tenant_id=${session.tenantId}&party_id=${session.partyId}`,
    {},
    session,
  );
}

export function listingIdFromBackend(listing: VehicleListing): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{2}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(listing.id)
    ? listing.id
    : null;
}
