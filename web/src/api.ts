import type { AssetListing } from "./types";

const apiBase = (process.env.NEXT_PUBLIC_MATCHPLANE_API_BASE_URL ?? "/api").replace(/\/$/, "");

export interface PartySession {
  tenantId: string;
  partyId: string;
  role: "buyer" | "seller" | "both";
  accessToken: string;
  accessTokenExpiresAt: string;
}

export type BetterAuthMarketplaceRole = "buyer" | "seller" | "subplatform_admin" | "platform";

export interface PaymentSetting {
  tenant_id: string;
  active_mode: "test" | "production";
  updated_by: string;
  version: number;
  updated_at: string;
}

export interface SubplatformEmailConfig {
  tenant_id: string;
  domain_id: string;
  provider_key: string;
  smtp_host: string;
  smtp_port: number;
  tls_mode: "starttls" | "tls" | "plain" | string;
  username: string;
  credential_configured: boolean;
  from_address: string;
  reply_to?: string | null;
  mode: "test" | "production" | string;
  enabled: boolean;
  version: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactExchange {
  phone?: string;
  wechat?: string;
  email?: string;
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

export interface ListingSubmission {
  submission_id: string;
  tenant_id: string;
  domain_id: string;
  seller_party_id: string;
  asset_schema_id: string;
  external_key: string;
  display_name: string;
  attributes: Record<string, unknown>;
  asking_amount: string;
  currency: string;
  currency_scale: number;
  status: "pending_review" | "approved" | "rejected" | "withdrawn" | string;
  reviewed_by?: string | null;
  review_reason?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Public, contact-free recommendation returned by the domain adapter. */
export interface RecommendedBackendListing {
  listing_id: string;
  tenant_id: string;
  domain_id: string;
  asset_id: string;
  display_name: string;
  attributes: Record<string, unknown>;
  asking_amount: string;
  currency: string;
  currency_scale: number;
  commission_bps?: number;
  commission_collection?: string;
  status?: string;
  match_score: number;
  match_reasons: string[];
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

export interface PlatformRouteHop {
  slug: string;
  path: string;
  displayName: string;
  description: string;
  tenantId: string;
  domainId: string;
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
  depth: number;
}

export interface PlatformRouteDecision {
  selectedSlugs: string[];
  source: "ai" | "policy_fallback";
  model: string | null;
  rationale: string;
  confidence: number | null;
  degraded: boolean;
  costBearer: "platform";
  budget: {
    maxInputCharacters: number;
    maxOutputTokens: number;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
}

export interface PlatformIntentRoute {
  requestId: string;
  platformPath: string;
  status: "accepted" | "delegated" | "degraded";
  routePlan: PlatformRouteHop[];
  routing: PlatformRouteDecision;
  routingTrace?: Array<{
    platformPath: string;
    decision: PlatformRouteDecision;
  }>;
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

async function paymentRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api/admin/payment-mode${path.includes("?") ? path.slice(path.indexOf("?")) : ""}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    let message = `支付服务请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the HTTP status when an upstream error is not JSON.
    }
    throw new MarketplaceApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export function isLiveMarketplaceEnabled(): boolean {
  const configured = process.env.NEXT_PUBLIC_MATCHPLANE_LIVE_MODE;
  if (configured === "false") return false;
  if (configured === "true") return true;
  // A production build must never silently fall back to the demo-only branch.
  // Operators can still opt out explicitly for a local/demo deployment.
  return process.env.NODE_ENV === "production";
}

export async function routePlatformIntent(input: {
  platformPath: string;
  narrative: string;
}): Promise<PlatformIntentRoute> {
  const response = await fetch("/api/platform/match", {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = `平台撮合请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the HTTP status when an upstream error is not JSON.
    }
    throw new MarketplaceApiError(response.status, message);
  }
  return (await response.json()) as PlatformIntentRoute;
}

export function getPaymentSetting(tenantId: string): Promise<PaymentSetting> {
  return paymentRequest<PaymentSetting>(
    `?tenant_id=${encodeURIComponent(tenantId)}`,
  );
}

export function switchPaymentMode(input: {
  tenantId: string;
  mode: "test" | "production";
  expectedVersion: number;
  reason: string;
}): Promise<PaymentSetting> {
  return paymentRequest<PaymentSetting>(
    "",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.tenantId,
        mode: input.mode,
        expected_version: input.expectedVersion,
        actor: "web-admin",
        reason: input.reason,
      }),
    },
  );
}

export function readPartySession(role: PartySession["role"] | "admin", subplatform = "root"): PartySession | null {
  try {
    const storageRoles = role === "admin" ? ["admin", "both"] : [role];
    const keys = [
      ...storageRoles.map((storageRole) => `matchplane.party.${subplatform}.${storageRole}`),
      ...(role === "admin" ? [] : [`matchplane.party.${role}`]),
    ];
    for (const key of [...new Set(keys)]) {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as PartySession;
        if (
          typeof parsed.tenantId !== "string" ||
          typeof parsed.partyId !== "string" ||
          typeof parsed.accessToken !== "string" ||
          typeof parsed.accessTokenExpiresAt !== "string" ||
          !isCapabilityActive(parsed.accessTokenExpiresAt) ||
          !["buyer", "seller", "both"].includes(parsed.role) ||
          (role === "admin" && parsed.role !== "both")
        ) {
          window.localStorage.removeItem(key);
          continue;
        }
        return parsed;
      } catch {
        window.localStorage.removeItem(key);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function savePartySession(session: PartySession, subplatform = "root", storageRole: string = session.role): void {
  window.localStorage.setItem(`matchplane.party.${subplatform}.${storageRole}`, JSON.stringify(session));
}

/**
 * Exchanges an already verified Better Auth cookie for the domain capability required by the
 * Rust marketplace API. The browser never creates or chooses an access token itself.
 */
export async function establishMarketplaceSession(input: {
  tenantId: string;
  domainId?: string;
  subplatform: string;
  platformPath?: string;
  role: BetterAuthMarketplaceRole;
}): Promise<PartySession> {
  const response = await fetch("/api/marketplace/session", {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-matchplane-subplatform": input.subplatform,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = `登录会话连接失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the status when the server does not return JSON.
    }
    throw new MarketplaceApiError(response.status, message);
  }
  const result = (await response.json()) as {
    tenant_id: string;
    party_id: string;
    role: PartySession["role"];
    access_token: string;
    access_token_expires_at: string;
  };
  if (!isCapabilityActive(result.access_token_expires_at)) {
    throw new MarketplaceApiError(502, "撮合会话服务返回了无效的能力过期时间");
  }
  const session: PartySession = {
    tenantId: result.tenant_id,
    partyId: result.party_id,
    role: result.role,
    accessToken: result.access_token,
    accessTokenExpiresAt: result.access_token_expires_at,
  };
  savePartySession(session, input.subplatform, input.role === "subplatform_admin" ? "admin" : input.role);
  return session;
}

function isCapabilityActive(value: string): boolean {
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function createBuyerRequest(input: {
  session: PartySession;
  domainId: string;
  narrative: string;
  requirements: Record<string, unknown>;
  budgetMin?: string;
  budgetMax?: string;
  currency: string;
  currencyScale: number;
}): Promise<{ request_id: string; [key: string]: unknown }> {
  return request<{ request_id: string; [key: string]: unknown }>(
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
}

export function getBuyerRecommendations(input: {
  session: PartySession;
  requestId: string;
  exposureKey: string;
  limit?: number;
}): Promise<RecommendedBackendListing[]> {
  return request<RecommendedBackendListing[]>(
    `/v1/marketplace/buyer-requests/${encodeURIComponent(input.requestId)}/recommendations`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        buyer_party_id: input.session.partyId,
        exposure_key: input.exposureKey,
        limit: input.limit ?? 20,
      }),
    },
    input.session,
  );
}

export function submitSellerListing(input: {
  session: PartySession;
  domainId: string;
  assetSchemaId: string;
  externalKey: string;
  displayName: string;
  attributes: Record<string, unknown>;
  askingAmount: string;
  currency: string;
  currencyScale: number;
}): Promise<ListingSubmission> {
  return request<ListingSubmission>(
    "/v1/marketplace/listing-submissions",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        seller_party_id: input.session.partyId,
        asset_schema_id: input.assetSchemaId,
        external_key: input.externalKey,
        display_name: input.displayName,
        attributes: input.attributes,
        asking_amount: input.askingAmount,
        currency: input.currency,
        currency_scale: input.currencyScale,
      }),
    },
    input.session,
  );
}

export function getSubplatformEmailConfig(
  session: PartySession,
  domainId: string,
): Promise<SubplatformEmailConfig> {
  return request<SubplatformEmailConfig>(
    `/v1/subplatforms/${encodeURIComponent(domainId)}/email-config?tenant_id=${encodeURIComponent(session.tenantId)}&party_id=${encodeURIComponent(session.partyId)}`,
    {},
    session,
  );
}

export function saveSubplatformEmailConfig(input: {
  session: PartySession;
  domainId: string;
  providerKey: string;
  smtpHost: string;
  smtpPort: number;
  tlsMode: "starttls" | "tls" | "plain";
  username: string;
  credentialSecretRef: string;
  fromAddress: string;
  replyTo?: string;
  mode: "test" | "production";
  enabled: boolean;
  expectedVersion?: number;
  updatedBy: string;
}): Promise<SubplatformEmailConfig> {
  return request<SubplatformEmailConfig>(
    `/v1/subplatforms/${encodeURIComponent(input.domainId)}/email-config`,
    {
      method: "PUT",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        party_id: input.session.partyId,
        provider_key: input.providerKey,
        smtp_host: input.smtpHost,
        smtp_port: input.smtpPort,
        tls_mode: input.tlsMode,
        username: input.username,
        credential_secret_ref: input.credentialSecretRef,
        from_address: input.fromAddress,
        reply_to: input.replyTo || null,
        mode: input.mode,
        enabled: input.enabled,
        expected_version: input.expectedVersion ?? null,
        updated_by: input.updatedBy,
      }),
    },
    input.session,
  );
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
  const recommendations = await getBuyerRecommendations({
    session: input.session,
    requestId: requestResult.request_id,
    exposureKey: input.exposureKey,
    limit: 20,
  });
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

export function listingIdFromBackend(listing: AssetListing): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{2}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(listing.id)
    ? listing.id
    : null;
}
