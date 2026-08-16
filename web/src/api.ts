import type { AssetListing } from "./types";

const apiBase = (process.env.NEXT_PUBLIC_MATCHPLANE_API_BASE_URL ?? "/api").replace(/\/$/, "");

export interface PartySession {
  tenantId: string;
  partyId: string;
  /** Better Auth subject that was verified before this capability was exchanged. */
  authUserId?: string;
  /** Recursive node scope used to isolate browser capability caches. */
  platformPath?: string;
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

export interface PaymentGatewayRecord {
  gateway_id: string;
  tenant_id: string;
  name: string;
  kind: "test" | "epay" | "waffo_pancake" | "wechat_pay_v3" | "alipay_openapi" | "custom" | string;
  mode: "test" | "production" | string;
  settings: Record<string, unknown>;
  credential_configured: boolean;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentRouteRecord {
  route_id: string;
  tenant_id: string;
  gateway_id: string;
  method_code: string;
  currency: string;
  priority: number;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InvoiceProviderRecord {
  provider_id: string;
  tenant_id: string;
  name: string;
  provider_key: string;
  mode: "test" | "production" | string;
  settings: Record<string, unknown>;
  credential_configured: boolean;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InvoiceSetting {
  tenant_id: string;
  active_mode: "test" | "production";
  provider_id: string | null;
  updated_by: string;
  version: number;
  updated_at: string;
}

export interface PaymentAdminRecord {
  payment_id: string;
  tenant_id: string;
  gateway_id: string;
  merchant_order_id: string;
  transaction_channel: string;
  purpose: string;
  gateway_kind: string;
  gateway_mode: string;
  payment_method: string;
  amount: string;
  captured_amount: string;
  refunded_amount: string;
  commission_amount: string;
  commission_refunded_amount: string;
  currency: string;
  currency_scale: number;
  status: string;
  provider_reference?: string | null;
  provider_status: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface RefundAdminRecord {
  refund_id: string;
  tenant_id: string;
  payment_id: string;
  amount: string;
  commission_reversal_amount: string;
  currency: string;
  currency_scale: number;
  reason: string;
  status: string;
  provider_reference?: string | null;
  provider_status?: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface InvoiceAdminRecord {
  invoice_id: string;
  tenant_id: string;
  payment_id?: string | null;
  offline_deal_id?: string | null;
  correction_of_invoice_id?: string | null;
  kind: string;
  amount: string;
  currency: string;
  currency_scale: number;
  description: string;
  status: string;
  provider_key: string;
  provider_mode: string;
  provider_reference?: string | null;
  invoice_number?: string | null;
  failure_reason?: string | null;
  requested_by: string;
  reviewed_by?: string | null;
  requested_at: string;
  issued_at?: string | null;
  updated_at: string;
  [key: string]: unknown;
}

export interface PlatformSetupStatus {
  status: "ok" | "degraded";
  root: {
    tenantConfigured: boolean;
    tenantExists: boolean;
    tenantId: string | null;
    tenant: { slug: string; name: string } | null;
    rootAdminConfigured: boolean;
    identityAccounts: number;
    rootAdminAccounts: number;
  };
  domains: Array<{ id: string; slug: string; name: string }>;
  registrations: Record<string, number>;
  routing: { activeChildren: number; ready: boolean };
  firstRun: { needsRootAccount: boolean; readyForAdmin: boolean };
}

export interface SubplatformOrganizationRecord {
  id: string;
  name: string;
  slug: string;
  parentOrganizationId: string | null;
  tenantId: string;
  domainId: string;
  sourceRepository: string | null;
  createdAt: string;
  registrationId: string | null;
  registrationState: string | null;
  buildDigest: string | null;
  manifestDigest: string | null;
}

export interface SubplatformArchiveUpload {
  sourceKind: "archive";
  sourceLocator: string;
  sourceDigest: string;
  originalName: string;
  size: number;
}

export interface SubplatformRegistrationResult {
  registrationId: string;
  organizationId: string;
  slug: string;
  state: string;
  manifestDigest: string;
  sourceDigest: string;
  next: string;
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
  routeMechanism?: "mcp_tool" | "structured_json" | "policy_fallback";
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

/**
 * Marketplace capabilities are deliberately held in memory only.  They are short-lived
 * integration credentials, not login state; persisting them in localStorage would let an XSS
 * survive a page reload with a bearer that can call the Rust gateway.  Better Auth's HttpOnly
 * session cookie remains the durable browser credential and is exchanged again when needed.
 */
const capabilityCache = new Map<string, PartySession>();
const MAX_CAPABILITY_CACHE_ENTRIES = 128;

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
  return paymentAdminRequest<T>(`payment-mode${path.includes("?") ? path.slice(path.indexOf("?")) : ""}`, init);
}

async function paymentAdminRequest<T>(resource: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api/admin/${resource}`, { ...init, headers, credentials: "include" });
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

export async function getPlatformSetupStatus(): Promise<PlatformSetupStatus> {
  const response = await fetch("/api/platform/setup", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as Partial<PlatformSetupStatus> | null;
  if (!response.ok || !body || body.status !== "ok") {
    throw new MarketplaceApiError(response.status, "平台初始化状态暂时不可用");
  }
  return body as PlatformSetupStatus;
}

export async function getSubplatformOrganizations(parentOrganizationId?: string): Promise<SubplatformOrganizationRecord[]> {
  const query = parentOrganizationId
    ? `?parentOrganizationId=${encodeURIComponent(parentOrganizationId)}`
    : "";
  const response = await fetch(`/api/platform/subplatforms${query}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { organizations?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "子平台列表读取失败");
  return Array.isArray(body?.organizations) ? body.organizations as SubplatformOrganizationRecord[] : [];
}

export async function uploadSubplatformArchive(file: File, parentOrganizationId?: string): Promise<SubplatformArchiveUpload> {
  const form = new FormData();
  form.set("archive", file, file.name);
  const headers = new Headers({ accept: "application/json" });
  if (parentOrganizationId) headers.set("x-matchplane-parent-organization-id", parentOrganizationId);
  const response = await fetch("/api/platform/subplatforms/upload", {
    method: "POST",
    credentials: "include",
    headers,
    body: form,
  });
  const body = await response.json().catch(() => null) as Partial<SubplatformArchiveUpload> & { error?: string } | null;
  if (!response.ok || !body?.sourceLocator || !body.sourceDigest) {
    throw new MarketplaceApiError(response.status, body?.error || "子平台压缩包上传失败");
  }
  return body as SubplatformArchiveUpload;
}

export async function registerSubplatform(input: {
  tenantId: string;
  domainId: string;
  parentOrganizationId?: string;
  packageId: string;
  slug: string;
  sourceKind: "git" | "archive";
  sourceLocator: string;
  pinnedRevision: string;
  sourceDigest: string;
  manifest: Record<string, unknown>;
  requestedScopes?: string[];
  membershipPolicy: "public" | "invite";
}): Promise<SubplatformRegistrationResult> {
  const response = await fetch("/api/platform/subplatforms", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as Partial<SubplatformRegistrationResult> & { error?: string } | null;
  if (!response.ok || !body?.registrationId) {
    throw new MarketplaceApiError(response.status, body?.error || "子平台注册失败");
  }
  return body as SubplatformRegistrationResult;
}

export async function activateSubplatform(input: { registrationId: string; buildDigest: string }): Promise<Record<string, unknown>> {
  const response = await fetch("/api/platform/subplatforms/activate", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> & { error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "子平台激活失败");
  return body ?? {};
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

export function getPaymentSetting(tenantId?: string): Promise<PaymentSetting> {
  return paymentRequest<PaymentSetting>(
    tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : "",
  );
}

export function switchPaymentMode(input: {
  tenantId?: string;
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

export function getPaymentGateways(tenantId?: string): Promise<PaymentGatewayRecord[]> {
  return paymentAdminRequest<PaymentGatewayRecord[]>(
    `payment-gateways${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function savePaymentGateway(input: {
  tenantId?: string;
  gatewayId?: string;
  name: string;
  kind: PaymentGatewayRecord["kind"];
  mode: "test" | "production";
  settings: Record<string, unknown>;
  credentialSecretRef?: string;
  enabled: boolean;
  expectedVersion?: number;
  reason: string;
}): Promise<PaymentGatewayRecord> {
  return paymentAdminRequest<PaymentGatewayRecord>("payment-gateways", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      gateway_id: input.gatewayId,
      name: input.name,
      kind: input.kind,
      mode: input.mode,
      settings: input.settings,
      credential_secret_ref: input.credentialSecretRef || null,
      enabled: input.enabled,
      expected_version: input.expectedVersion,
      reason: input.reason,
    }),
  });
}

export function getPaymentRoutes(tenantId?: string): Promise<PaymentRouteRecord[]> {
  return paymentAdminRequest<PaymentRouteRecord[]>(
    `payment-routes${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function savePaymentRoute(input: {
  tenantId?: string;
  routeId?: string;
  gatewayId: string;
  methodCode: string;
  currency: string;
  priority: number;
  enabled: boolean;
  expectedVersion?: number;
  reason: string;
}): Promise<PaymentRouteRecord> {
  return paymentAdminRequest<PaymentRouteRecord>("payment-routes", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      route_id: input.routeId,
      gateway_id: input.gatewayId,
      method_code: input.methodCode,
      currency: input.currency,
      priority: input.priority,
      enabled: input.enabled,
      expected_version: input.expectedVersion,
      reason: input.reason,
    }),
  });
}

export function getInvoiceProviders(tenantId?: string): Promise<InvoiceProviderRecord[]> {
  return paymentAdminRequest<InvoiceProviderRecord[]>(
    `invoice-providers${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function saveInvoiceProvider(input: {
  tenantId?: string;
  providerId?: string;
  name: string;
  providerKey: string;
  mode: "test" | "production";
  settings: Record<string, unknown>;
  credentialSecretRef?: string;
  enabled: boolean;
  expectedVersion?: number;
  reason: string;
}): Promise<InvoiceProviderRecord> {
  return paymentAdminRequest<InvoiceProviderRecord>("invoice-providers", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      provider_id: input.providerId,
      name: input.name,
      provider_key: input.providerKey,
      mode: input.mode,
      settings: input.settings,
      credential_secret_ref: input.credentialSecretRef || null,
      enabled: input.enabled,
      expected_version: input.expectedVersion,
      reason: input.reason,
    }),
  });
}

export function getInvoiceSetting(tenantId?: string): Promise<InvoiceSetting> {
  return paymentAdminRequest<InvoiceSetting>(
    `invoice-mode${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function getPaymentAdminRecords(tenantId?: string, limit = 25): Promise<PaymentAdminRecord[]> {
  return paymentAdminRequest<PaymentAdminRecord[]>(
    `payments?limit=${limit}${tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function getRefundAdminRecords(tenantId?: string, limit = 25): Promise<RefundAdminRecord[]> {
  return paymentAdminRequest<RefundAdminRecord[]>(
    `refunds?limit=${limit}${tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function getInvoiceAdminRecords(tenantId?: string, limit = 25): Promise<InvoiceAdminRecord[]> {
  return paymentAdminRequest<InvoiceAdminRecord[]>(
    `invoices?limit=${limit}${tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : ""}`,
  );
}

export function switchInvoiceMode(input: {
  tenantId?: string;
  mode: "test" | "production";
  providerId?: string;
  expectedVersion: number;
  reason: string;
}): Promise<InvoiceSetting> {
  return paymentAdminRequest<InvoiceSetting>("invoice-mode", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      mode: input.mode,
      provider_id: input.providerId ?? null,
      expected_version: input.expectedVersion,
      reason: input.reason,
    }),
  });
}

export function readPartySession(
  role: PartySession["role"] | "admin",
  subplatform = "root",
  platformPath?: string,
  authUserId?: string,
): PartySession | null {
  pruneCapabilityCache();
  const storageRoles = role === "admin" ? ["admin", "both"] : [role];
  const scopedKey = platformPath ? encodeURIComponent(platformPath) : subplatform;
  const keys = [
    ...storageRoles.map((storageRole) => `matchplane.party.${scopedKey}.${storageRole}`),
    ...(!platformPath && role !== "admin" ? [`matchplane.party.${role}`] : []),
  ];
  for (const key of [...new Set(keys)]) {
    const parsed = capabilityCache.get(key);
    if (!parsed) continue;
    if (
      typeof parsed.tenantId !== "string" ||
      typeof parsed.partyId !== "string" ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.accessTokenExpiresAt !== "string" ||
      !isCapabilityActive(parsed.accessTokenExpiresAt) ||
      !["buyer", "seller", "both"].includes(parsed.role) ||
      (role === "admin" && parsed.role !== "both") ||
      (platformPath && parsed.platformPath !== platformPath) ||
      (authUserId !== undefined && parsed.authUserId !== authUserId)
    ) {
      capabilityCache.delete(key);
      continue;
    }
    return parsed;
  }
  return null;
}

export function savePartySession(
  session: PartySession,
  subplatform = "root",
  storageRole: string = session.role,
  platformPath?: string,
): void {
  pruneCapabilityCache();
  const scopedKey = platformPath ? encodeURIComponent(platformPath) : subplatform;
  if (!capabilityCache.has(`matchplane.party.${scopedKey}.${storageRole}`) && capabilityCache.size >= MAX_CAPABILITY_CACHE_ENTRIES) {
    const oldest = capabilityCache.keys().next().value;
    if (typeof oldest === "string") capabilityCache.delete(oldest);
  }
  capabilityCache.set(`matchplane.party.${scopedKey}.${storageRole}`, session);
}

/** Clear all in-memory capabilities after logout or an account switch. */
export function clearPartySessionCache(): void {
  capabilityCache.clear();
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
  authUserId?: string;
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
    authUserId: input.authUserId,
    platformPath: input.platformPath,
    role: result.role,
    accessToken: result.access_token,
    accessTokenExpiresAt: result.access_token_expires_at,
  };
  savePartySession(session, input.subplatform, input.role === "subplatform_admin" ? "admin" : input.role, input.platformPath);
  return session;
}

function isCapabilityActive(value: string): boolean {
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function pruneCapabilityCache(): void {
  for (const [key, session] of capabilityCache) {
    if (!isCapabilityActive(session.accessTokenExpiresAt)) capabilityCache.delete(key);
  }
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
  domainId: string;
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
        domain_id: input.domainId,
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
    domainId: input.domainId,
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
        domain_id: input.domainId,
        listing_id: input.listingId,
        buyer_request_id: requestResult.request_id,
        buyer_party_id: input.session.partyId,
      }),
    },
    input.session,
  );
  return request<OfflineDeal>(
    `/v1/marketplace/offline-deals/${outcome.offline_deal_id}?tenant_id=${input.session.tenantId}&domain_id=${encodeURIComponent(input.domainId)}&party_id=${input.session.partyId}`,
    {},
    input.session,
  );
}

export function listOfflineDeals(session: PartySession, domainId?: string): Promise<OfflineDeal[]> {
  return request<OfflineDeal[]>(
    `/v1/marketplace/offline-deals?tenant_id=${session.tenantId}&party_id=${session.partyId}${domainId ? `&domain_id=${encodeURIComponent(domainId)}` : ""}`,
    {},
    session,
  );
}

export function acceptContactExchange(
  session: PartySession,
  offlineDealId: string,
  domainId: string,
): Promise<OfflineDeal> {
  return request<OfflineDeal>(
    `/v1/marketplace/offline-deals/${offlineDealId}/contact/accept`,
    {
      method: "POST",
      body: JSON.stringify({ tenant_id: session.tenantId, domain_id: domainId, party_id: session.partyId }),
    },
    session,
  );
}

export function retrieveContact(
  session: PartySession,
  offlineDealId: string,
  domainId?: string,
): Promise<ContactResponse> {
  return request<ContactResponse>(
    `/v1/marketplace/offline-deals/${offlineDealId}/contact?tenant_id=${session.tenantId}&party_id=${session.partyId}${domainId ? `&domain_id=${encodeURIComponent(domainId)}` : ""}`,
    {},
    session,
  );
}

export function listingIdFromBackend(listing: AssetListing): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{2}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(listing.id)
    ? listing.id
    : null;
}
