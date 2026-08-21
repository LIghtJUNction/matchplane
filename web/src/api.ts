import type { AssetListing } from "./types";
import {
  MAX_MEDIA_BYTES,
  MEDIA_ATTACHMENT_PROTOCOL,
  parseMediaUploadResponse,
  type MarketplaceAttachment,
} from "./media-attachment";
import type { RetrievalResult } from "./retrieval-protocol";

export type { MarketplaceAttachment } from "./media-attachment";

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
    organization: {
      id: string;
      slug: string;
      name: string;
      tenantId: string;
      domainId: string | null;
    } | null;
    rootAdminConfigured: boolean;
    identityAccounts: number;
    rootAdminAccounts: number;
  };
  domains: Array<{ id: string; slug: string; name: string }>;
  registrations: Record<string, number>;
  routing: { activeChildren: number; ready: boolean };
  hostedAgent: { configured: boolean; status: "ready" | "fallback" };
  builder: { configured: boolean; status: "ready" | "degraded" | "unconfigured" };
  firstRun: { needsRootAccount: boolean; readyForAdmin: boolean };
}

export interface PlatformAiStatus {
  router: {
    configured: boolean;
    protocol: "openai-compatible" | "anthropic-messages" | "gemini-generate-content";
    model: string | null;
    endpointOrigin: string | null;
    toolMode: "auto" | "required" | "disabled";
    maxInputCharacters: number;
    maxOutputTokens: number;
    totalTimeoutMs: number;
    maxSteps: number;
    maxFanout: number;
    requestsPerHour: number;
    globalRequestsPerHour: number;
  };
  auth: {
    primary: string[];
    fallback: string[];
    password: boolean;
    emailOtp: boolean;
    phoneOtp: boolean;
    magicLink: boolean;
    passkey: boolean;
  };
}

export interface PlatformAiProbeResult {
  status: "ready" | "unconfigured" | "failed";
  model: string | null;
  responseStatus: number | null;
  latencyMs: number;
  message: string;
}

export interface PlatformSiteSettings {
  organization_id: string;
  tenant_id: string;
  icp_number: string | null;
  icp_subject: string | null;
  icp_record_url: string | null;
  public_security_number: string | null;
  public_security_url: string | null;
  lookup_source: string | null;
  lookup_checked_at: string | null;
  version: number;
  updated_at: string | null;
  configured: boolean;
}

export interface PlatformSiteSettingsLookup extends PlatformSiteSettings {
  lookup_source: string | null;
  lookup_checked_at: string | null;
}

export interface RootPlatformOrganization {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
  domainId: string | null;
}

export async function createRootPlatformOrganization(input?: {
  name?: string;
  slug?: string;
}): Promise<RootPlatformOrganization> {
  const response = await fetch("/api/platform/root-organization", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const body = await response.json().catch(() => null) as { organization?: RootPlatformOrganization; error?: string } | null;
  if (!response.ok || !body?.organization) {
    throw new MarketplaceApiError(response.status, body?.error || "根平台组织初始化失败");
  }
  return body.organization;
}

export interface PlatformDomainRecord {
  id: string;
  slug: string;
  name: string;
  status: "active" | "disabled";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlatformMemberRecord {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string; email: string; image?: string } | null;
}

export interface PlatformInvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface PlatformMemberDirectory {
  organization: {
    id: string;
    name: string;
    slug: string;
    parentOrganizationId: string | null;
    tenantId: string;
    domainId: string | null;
  };
  members: PlatformMemberRecord[];
  invitations: PlatformInvitationRecord[];
  canAssignOwner: boolean;
}

export async function getPlatformMembers(organizationId: string): Promise<PlatformMemberDirectory> {
  const response = await fetch(`/api/platform/members?organizationId=${encodeURIComponent(organizationId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as Partial<PlatformMemberDirectory> & { error?: string } | null;
  if (!response.ok || !body?.organization) {
    throw new MarketplaceApiError(response.status, body?.error || "成员列表读取失败");
  }
  return body as PlatformMemberDirectory;
}

export async function invitePlatformMember(input: {
  organizationId: string;
  email: string;
  role: string;
  resend?: boolean;
}): Promise<PlatformInvitationRecord> {
  const response = await fetch("/api/platform/members", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { invitation?: PlatformInvitationRecord; error?: string } | null;
  if (!response.ok || !body?.invitation) throw new MarketplaceApiError(response.status, body?.error || "成员邀请失败");
  return body.invitation;
}

export async function updatePlatformMember(input: {
  organizationId: string;
  memberId: string;
  role: string;
}): Promise<PlatformMemberRecord> {
  const response = await fetch("/api/platform/members", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { member?: PlatformMemberRecord; error?: string } | null;
  if (!response.ok || !body?.member) throw new MarketplaceApiError(response.status, body?.error || "成员权限更新失败");
  return body.member;
}

export async function removePlatformMember(input: {
  organizationId: string;
  memberIdOrEmail?: string;
  invitationId?: string;
}): Promise<void> {
  const response = await fetch("/api/platform/members", {
    method: "DELETE",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new MarketplaceApiError(response.status, body?.error || "成员移除失败");
  }
}

/** A browser-safe account summary for the mall account directory. It deliberately excludes
 * phone numbers, identity-provider subjects, sessions, and contact preferences. */
export interface PlatformAccountRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  createdAt: string;
  banned?: boolean;
}

export async function getPlatformAccounts(): Promise<PlatformAccountRecord[]> {
  const response = await fetch("/api/platform/administrators", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { accounts?: unknown; administrators?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "账号列表读取失败");
  // `administrators` is retained by the server for callers deployed before the account-directory
  // rename. New surfaces must use `accounts`: it includes ordinary registered customers too.
  const accounts = body?.accounts ?? body?.administrators;
  return Array.isArray(accounts) ? accounts as PlatformAccountRecord[] : [];
}

export async function updatePlatformAdministrator(input: {
  userId: string;
  role: "rootAdmin" | "user";
}): Promise<PlatformAccountRecord> {
  const response = await fetch("/api/platform/administrators", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { administrator?: PlatformAccountRecord; error?: string } | null;
  if (!response.ok || !body?.administrator) throw new MarketplaceApiError(response.status, body?.error || "根管理员权限更新失败");
  return body.administrator;
}

export interface PlatformApiKeyRecord {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  referenceId: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions?: Record<string, string[]> | string | null;
  metadata?: Record<string, unknown> | string | null;
  key?: string;
}

export async function getPlatformApiKeys(organizationId: string): Promise<PlatformApiKeyRecord[]> {
  const response = await fetch(`/api/platform/api-keys?organizationId=${encodeURIComponent(organizationId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { apiKeys?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "API Key 列表读取失败");
  return Array.isArray(body?.apiKeys) ? body.apiKeys as PlatformApiKeyRecord[] : [];
}

export async function createPlatformApiKey(input: {
  organizationId: string;
  name: string;
  expiresIn?: number;
  permissions?: Record<string, string[]>;
  agentSide?: "demand" | "supply" | "both";
}): Promise<PlatformApiKeyRecord> {
  const response = await fetch("/api/platform/api-keys", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as PlatformApiKeyRecord & { error?: string } | null;
  if (!response.ok || !body?.id) throw new MarketplaceApiError(response.status, body?.error || "API Key 创建失败");
  return body;
}

export async function updatePlatformApiKey(input: { organizationId: string; keyId: string; enabled: boolean }): Promise<PlatformApiKeyRecord> {
  const response = await fetch("/api/platform/api-keys", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as PlatformApiKeyRecord & { error?: string } | null;
  if (!response.ok || !body?.id) throw new MarketplaceApiError(response.status, body?.error || "API Key 更新失败");
  return body;
}

export async function revokePlatformApiKey(input: { organizationId: string; keyId: string }): Promise<void> {
  const response = await fetch("/api/platform/api-keys", {
    method: "DELETE",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new MarketplaceApiError(response.status, body?.error || "API Key 撤销失败");
  }
}

export interface PlatformOidcClientRecord {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUris: string[];
  disabled: boolean;
  requirePkce: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  matchplane?: Record<string, unknown>;
}

export async function getPlatformOidcClients(): Promise<PlatformOidcClientRecord[]> {
  const response = await fetch("/api/platform/oidc/clients", { credentials: "include", headers: { accept: "application/json" } });
  const body = await response.json().catch(() => null) as { clients?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "OIDC 客户端列表读取失败");
  return Array.isArray(body?.clients) ? body.clients as PlatformOidcClientRecord[] : [];
}

export async function createPlatformOidcClient(input: {
  subplatformRegistrationId: string;
  clientName: string;
  redirectUris: string[];
}): Promise<PlatformOidcClientRecord & { clientSecret?: string; client_secret?: string }> {
  const response = await fetch("/api/platform/oidc/clients", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as PlatformOidcClientRecord & { client_id?: string; clientSecret?: string; client_secret?: string; error?: string } | null;
  const clientId = body?.clientId || body?.client_id;
  if (!response.ok || !clientId) throw new MarketplaceApiError(response.status, body?.error || "OIDC 客户端创建失败");
  return { ...body, clientId };
}

export async function updatePlatformOidcClient(input: { clientId: string; action: "enable" | "disable" | "rotate-secret" }): Promise<Record<string, unknown>> {
  const response = await fetch("/api/platform/oidc/clients", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> & { error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "OIDC 客户端更新失败");
  return body || {};
}

export interface FederationBindingRecord {
  id: string;
  inviteId: string;
  organizationId: string | null;
  registrationId: string | null;
  nodeId: string;
  slug: string;
  displayName: string;
  endpoint: string;
  mcpServerKey: string;
  tokenEnv: string | null;
  status: "pending" | "active" | "degraded" | "revoked" | string;
  registrationState?: string | null;
  lastHealthAt?: string | null;
  lastError?: string | null;
  manifestDigest?: string | null;
  createdAt?: string;
  activatedAt?: string | null;
}

export async function getFederationBindings(): Promise<FederationBindingRecord[]> {
  const response = await fetch("/api/platform/federation/bindings", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { bindings?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "联邦节点列表读取失败");
  return Array.isArray(body?.bindings) ? body.bindings as FederationBindingRecord[] : [];
}

export async function createFederationInvite(input: {
  domainId: string;
  parentOrganizationId?: string;
  expiresInHours?: number;
}): Promise<{
  inviteId: string;
  domainId: string;
  parentOrganizationId: string;
  expiresAt: string;
  enrollmentToken: string;
  enrollmentUrl: string;
}> {
  const response = await fetch("/api/platform/federation/invites", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as {
    inviteId?: string;
    domainId?: string;
    parentOrganizationId?: string;
    expiresAt?: string;
    enrollmentToken?: string;
    enrollmentUrl?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.inviteId || !body.enrollmentToken || !body.enrollmentUrl) {
    throw new MarketplaceApiError(response.status, body?.error || "联邦入驻邀请创建失败");
  }
  return body as {
    inviteId: string;
    domainId: string;
    parentOrganizationId: string;
    expiresAt: string;
    enrollmentToken: string;
    enrollmentUrl: string;
  };
}

export async function activateFederationBinding(input: {
  bindingId: string;
  tokenEnv?: string;
  membershipPolicy?: "public" | "invite";
}): Promise<FederationBindingRecord & { bindingId: string; routing: string }> {
  const response = await fetch("/api/platform/federation/bindings/activate", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as FederationBindingRecord & { bindingId?: string; routing?: string; error?: string } | null;
  if (!response.ok || !body?.bindingId) throw new MarketplaceApiError(response.status, body?.error || "联邦节点激活失败");
  return { ...body, id: body.bindingId, bindingId: body.bindingId, routing: body.routing || "enabled" };
}

export async function revokeFederationBinding(bindingId: string): Promise<void> {
  const response = await fetch("/api/platform/federation/bindings", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ bindingId, status: "revoked" }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new MarketplaceApiError(response.status, body?.error || "联邦节点撤销失败");
  }
}

export async function probeFederationBinding(bindingId: string): Promise<{ status: string; lastHealthAt?: string; lastError?: string | null }> {
  const response = await fetch("/api/platform/federation/bindings/health", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ bindingId }),
  });
  const body = await response.json().catch(() => null) as { status?: string; lastHealthAt?: string; lastError?: string | null; error?: string } | null;
  if (!response.ok || !body?.status) throw new MarketplaceApiError(response.status, body?.error || "联邦节点健康检查失败");
  return { status: body.status, lastHealthAt: body.lastHealthAt, lastError: body.lastError };
}

export interface PlatformChildSummary {
  slug: string;
  path: string;
  displayName: string;
  description: string;
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
}

export interface StoreSummary {
  id: string;
  slug: string;
  path: string;
  displayName: string;
  description: string;
  integrationKind: "hosted" | "package" | "external";
  status?: "pending" | "active" | "suspended" | "closed";
  commercialTerms?: {
    pricingModel: "none" | "subscription" | "commission" | "hybrid";
    recurringFeeMinor: string;
    currency: string;
    billingInterval: "month" | "year" | null;
    commissionBps: number;
    status: "draft" | "active" | "paused";
    version: number;
  };
}

export interface MallSettings {
  name: string;
  slug: string;
  version: number;
  logoUrl?: string | null;
}

export async function getMallSettings(): Promise<MallSettings> {
  const response = await fetch("/api/mall/settings", { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => null) as { mall?: MallSettings; error?: string } | null;
  if (!response.ok || !body?.mall) throw new MarketplaceApiError(response.status, body?.error || "商城设置读取失败");
  return body.mall;
}

export async function saveMallSettings(input: { name: string; expectedVersion: number }): Promise<MallSettings> {
  const response = await fetch("/api/mall/settings", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { mall?: MallSettings; error?: string } | null;
  if (!response.ok || !body?.mall) throw new MarketplaceApiError(response.status, body?.error || "商城名称保存失败");
  return body.mall;
}

export async function uploadMallBrandLogo(input: { file: File; expectedVersion: number }): Promise<MallSettings> {
  if (input.file.size < 1 || input.file.size > 4 * 1024 * 1024) {
    throw new MarketplaceApiError(413, "Logo 图片不能超过 4 MiB");
  }
  const dataBase64 = bytesToBase64(new Uint8Array(await input.file.arrayBuffer()));
  const response = await fetch("/api/mall/logo", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ dataBase64, expectedVersion: input.expectedVersion }),
  });
  const body = await response.json().catch(() => null) as { mall?: MallSettings; error?: string } | null;
  if (!response.ok || !body?.mall) throw new MarketplaceApiError(response.status, body?.error || "商城 Logo 保存失败");
  return body.mall;
}

export interface MallLegalDocument {
  content: string;
  version: number;
  updatedAt: string;
}

export interface MallLegalDocuments {
  mallName: string;
  documents: {
    terms: MallLegalDocument;
    privacy: MallLegalDocument;
  };
}

export async function getMallLegalDocuments(): Promise<MallLegalDocuments> {
  const response = await fetch("/api/mall/legal", { headers: { accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => null) as MallLegalDocuments & { error?: string } | null;
  if (!response.ok || !body?.documents?.terms || !body.documents.privacy) {
    throw new MarketplaceApiError(response.status, body?.error || "法律页面读取失败");
  }
  return body;
}

export async function saveMallLegalDocuments(input: {
  termsContent: string;
  privacyContent: string;
  termsVersion: number;
  privacyVersion: number;
}): Promise<MallLegalDocuments> {
  const response = await fetch("/api/mall/legal", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as MallLegalDocuments & { error?: string } | null;
  if (!response.ok || !body?.documents?.terms || !body.documents.privacy) {
    throw new MarketplaceApiError(response.status, body?.error || "法律页面保存失败");
  }
  return body;
}

export interface AccountProfile {
  name: string;
  email: string;
  image: string | null;
  bio: string;
}

export async function getAccountProfile(): Promise<AccountProfile> {
  const response = await fetch("/api/account/profile", { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => null) as { profile?: AccountProfile; error?: string } | null;
  if (!response.ok || !body?.profile) throw new MarketplaceApiError(response.status, body?.error || "个人资料读取失败");
  return body.profile;
}

export async function saveAccountProfile(input: { bio: string }): Promise<AccountProfile> {
  const response = await fetch("/api/account/profile", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { profile?: AccountProfile; error?: string } | null;
  if (!response.ok || !body?.profile) throw new MarketplaceApiError(response.status, body?.error || "个人资料保存失败");
  return body.profile;
}

export async function uploadAccountAvatar(file: File): Promise<string> {
  if (file.size < 1 || file.size > 4 * 1024 * 1024) throw new MarketplaceApiError(413, "头像图片不能超过 4 MiB");
  const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const response = await fetch("/api/account/avatar", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ dataBase64 }),
  });
  const body = await response.json().catch(() => null) as { image?: string; error?: string } | null;
  if (!response.ok || !body?.image) throw new MarketplaceApiError(response.status, body?.error || "头像保存失败");
  return body.image;
}

export async function getStores(): Promise<StoreSummary[]> {
  const response = await fetch("/api/stores", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { stores?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "店铺目录读取失败");
  return Array.isArray(body?.stores) ? body.stores as StoreSummary[] : [];
}

export async function getOwnedStores(): Promise<StoreSummary[]> {
  const response = await fetch("/api/stores?mine=1", {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { stores?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "我的店铺读取失败");
  return Array.isArray(body?.stores) ? body.stores as StoreSummary[] : [];
}

export async function getManagedStores(): Promise<StoreSummary[]> {
  const response = await fetch("/api/stores?manage=1", {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { stores?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "店铺计费读取失败");
  return Array.isArray(body?.stores) ? body.stores as StoreSummary[] : [];
}

export async function saveStoreCommercialTerms(input: {
  storeId: string;
  pricingModel: "none" | "subscription" | "commission" | "hybrid";
  recurringFeeMinor: string;
  currency: string;
  billingInterval: "month" | "year" | null;
  commissionBps: number;
  status: "draft" | "active" | "paused";
  expectedVersion: number;
}): Promise<NonNullable<StoreSummary["commercialTerms"]>> {
  const response = await fetch(`/api/stores/${encodeURIComponent(input.storeId)}/commercial-terms`, {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { commercialTerms?: NonNullable<StoreSummary["commercialTerms"]>; error?: string } | null;
  if (!response.ok || !body?.commercialTerms) throw new MarketplaceApiError(response.status, body?.error || "店铺计费保存失败");
  return body.commercialTerms;
}

export async function createHostedStore(input: { name: string; slug: string; description: string }): Promise<StoreSummary> {
  const response = await fetch("/api/stores", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { store?: StoreSummary; error?: string } | null;
  if (!response.ok || !body?.store) throw new MarketplaceApiError(response.status, body?.error || "店铺创建失败");
  return body.store;
}

export async function getPlatformChildren(path = "/"): Promise<PlatformChildSummary[]> {
  const response = await fetch(`/api/platform/children?path=${encodeURIComponent(path)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { children?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "平台节点读取失败");
  return Array.isArray(body?.children) ? body.children as PlatformChildSummary[] : [];
}

export interface SubplatformOrganizationRecord {
  id: string;
  isRoot?: boolean;
  name: string;
  slug: string;
  parentOrganizationId: string | null;
  tenantId: string;
  domainId: string | null;
  sourceRepository: string | null;
  createdAt: string;
  registrationId: string | null;
  registrationState: string | null;
  sourceKind?: "git" | "archive" | "remote" | string | null;
  sourceLocator?: string | null;
  pinnedRevision?: string | null;
  registrationVersion?: string | null;
  buildDigest: string | null;
  manifestDigest: string | null;
  buildAttempts?: number;
  buildError?: string | null;
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

export interface SubplatformSourceIntake {
  intakeId: string;
  state: "queued" | "discovering" | "ready" | "rejected" | string;
  sourceKind: "git" | "archive";
  sourceLocator: string;
  sourceDigest?: string | null;
  pinnedRevision?: string | null;
  manifest?: Record<string, unknown> | null;
  manifestDigest?: string | null;
  packageId?: string | null;
  slug?: string | null;
  requestedScopes?: string[];
  membershipPolicy?: "public" | "invite" | string;
  error?: string | null;
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

/** Browser-safe root authentication mail configuration. The SMTP password is never returned. */
export interface RootEmailConfig {
  providerKey: string;
  smtpHost: string;
  smtpPort: number;
  tlsMode: "starttls" | "tls" | "plain";
  username: string;
  credentialConfigured: boolean;
  fromAddress: string;
  replyTo: string | null;
  mode: "test" | "production";
  enabled: boolean;
  version: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAdminInvite {
  email: string;
  expiresAt: string;
  registrationUrl: string;
}

export interface ManagedPlatformRouterConfig {
  endpoint: string;
  model: string;
  protocol: "openai-compatible" | "anthropic-messages" | "gemini-generate-content";
  enabled: boolean;
  credentialConfigured: boolean;
  assistantInstructions: string;
  assistantMaxOutputTokens: number;
  assistantTemperature: number;
  assistantMaxSteps: number;
  assistantTimeoutMs: number;
  assistantReasoningEffort: "low" | "medium" | "high";
}

/** Contact channels are supplied by the active platform; the kernel does not prescribe names. */
export type ContactExchange = Record<string, string>;

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

/** Domain-neutral supply offer returned by the kernel for non-priced or custom verticals. */
export interface MarketplaceOffer {
  offer_id: string;
  tenant_id: string;
  domain_id: string;
  supply_party_id: string;
  asset_id?: string | null;
  external_key: string;
  display_name: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  status: "draft" | "active" | "reserved" | "sold" | "withdrawn" | "expired" | string;
  published_at?: string | null;
  expires_at?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceOfferCandidate extends MarketplaceOffer {
  score: number;
  reasons: string[];
  risks?: string[];
}

export interface MarketplaceOfferPreference {
  tenant_id: string;
  domain_id: string;
  participant_id: string;
  offer_id: string;
  state: "saved" | "dismissed" | "neutral" | string;
  reason?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Contact-free demand projection returned only after the demand participant opts in. */
export interface MarketplaceDemandCandidate {
  intent_id: string;
  tenant_id: string;
  domain_id: string;
  narrative: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  score: number;
  reasons: string[];
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type MarketplaceOfferOutcome = MarketplaceOffer & { duplicate: boolean };

/** Root-control-plane projection; package-owned attributes and terms are intentionally absent. */
export interface MarketplaceOfferAdminRecord {
  offer_id: string;
  tenant_id: string;
  supply_party_id: string;
  domain_id: string;
  asset_id: string | null;
  external_key: string;
  display_name: string;
  status: string;
  published_at: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  store_id?: string | null;
  store_name?: string | null;
  store_path?: string | null;
  description?: string | null;
  image_url?: string | null;
  amount_minor?: string | null;
  currency?: string | null;
  currency_scale?: number | null;
}

export interface MarketplaceIntroduction {
  introduction_id: string;
  tenant_id: string;
  intent_id: string;
  offer_id: string;
  demand_party_id: string;
  supply_party_id: string;
  score: number;
  reasons: unknown;
  status: string;
  supply_contact_consent_at: string | null;
  contact_released_at: string | null;
  idempotency_key: string;
  expires_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceContactResponse {
  counterpart: {
    party_id: string;
    display_name: string;
    contact: ContactExchange;
  };
  introduction: MarketplaceIntroduction;
}

/** Public, contact-free recommendation returned by the domain adapter. */
export interface RecommendedBackendListing {
  listing_id?: string;
  offer_id?: string;
  tenant_id?: string;
  domain_id?: string;
  asset_id?: string | null;
  display_name: string;
  attributes: Record<string, unknown>;
  terms?: Record<string, unknown>;
  asking_amount?: string;
  currency?: string;
  currency_scale?: number;
  platform_path?: string;
  subplatform?: string;
  commission_bps?: number;
  commission_collection?: string;
  status?: string;
  match_score?: number;
  match_reasons?: string[];
  match_risks?: string[];
  [key: string]: unknown;
}

export interface MallSearchResponse {
  requestId: string;
  stores: Array<{ slug: string; path: string; displayName: string }>;
  recommendations: RecommendedBackendListing[];
  routing: {
    source: "ai" | "policy_fallback";
    degraded: boolean;
    rationale: string;
  };
}

export async function searchMallCatalog(input: {
  narrative: string;
  storePath?: string;
}): Promise<MallSearchResponse> {
  const response = await fetch("/api/mall/search", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as (MallSearchResponse & { error?: string }) | null;
  if (!response.ok || !body) {
    throw new MarketplaceApiError(response.status, body?.error || "商城搜索暂时不可用");
  }
  return body;
}

export async function askMallShoppingAssistant(
  question: string,
): Promise<{ requestId: string; answer: string; recommendations: RecommendedBackendListing[] }> {
  const response = await fetch("/api/mall/assistant", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await response.json().catch(() => null) as { requestId?: string; answer?: string; recommendations?: unknown; error?: string } | null;
  if (!response.ok || !body?.requestId || !body.answer) {
    throw new MarketplaceApiError(response.status, body?.error || "商城 AI 导购暂时不可用");
  }
  return { requestId: body.requestId, answer: body.answer, recommendations: Array.isArray(body.recommendations) ? body.recommendations as RecommendedBackendListing[] : [] };
}

export interface ContactResponse {
  counterpart: {
    party_id: string;
    display_name: string;
    contact: ContactExchange;
  };
  deal: OfflineDeal;
  settlement: {
    mode: string;
    platform_fee: string;
  };
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function inferBrowserMediaKind(mediaType: string): "image" | "document" | "video" | "audio" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType === "application/pdf" || mediaType === "application/json" || mediaType === "text/plain") return "document";
  return "file";
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function readApiError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.slice(0, 500) : null;
}

/** Redeem a one-time CLI-issued administrator invitation after Better Auth sign-in. */
export async function redeemPlatformAdminInvite(token: string): Promise<{
  redeemed: boolean;
  organizationId: string;
  role: "rootAdmin" | "subplatform_admin";
}> {
  const response = await fetch("/api/admin-invites/redeem", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = await response.json().catch(() => null) as {
    redeemed?: boolean;
    organizationId?: string;
    role?: "rootAdmin" | "subplatform_admin";
    error?: string;
  } | null;
  if (!response.ok || body?.redeemed !== true || !body.organizationId || !body.role) {
    throw new MarketplaceApiError(response.status, body?.error || "管理员注册链接兑换失败");
  }
  return {
    redeemed: true,
    organizationId: body.organizationId,
    role: body.role,
  };
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
  if (session?.platformPath) headers.set("x-matchplane-platform-path", session.platformPath);
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
  // A production build must never silently fall back to the API-disabled branch.
  // Operators can still opt out explicitly for a local development deployment.
  return process.env.NODE_ENV === "production";
}

export async function getPlatformSetupStatus(): Promise<PlatformSetupStatus> {
  const response = await fetch("/api/platform/setup", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as Partial<PlatformSetupStatus> | null;
  if (!response.ok || !body || (body.status !== "ok" && body.status !== "degraded")) {
    throw new MarketplaceApiError(response.status, "平台初始化状态暂时不可用");
  }
  return body as PlatformSetupStatus;
}

export async function getPlatformAiStatus(): Promise<PlatformAiStatus> {
  const response = await fetch("/api/platform/ai/status", {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as PlatformAiStatus & { error?: string } | null;
  if (!response.ok || !body?.router || !body.auth) {
    throw new MarketplaceApiError(response.status, body?.error || "AI 与登录配置读取失败");
  }
  return body;
}

/** Test the server-side hosted Agent without sending browser or user content. */
export async function testPlatformAi(): Promise<PlatformAiProbeResult> {
  const response = await fetch("/api/platform/ai/test", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as (PlatformAiProbeResult & { error?: string }) | null;
  if (!response.ok || !body?.status) {
    throw new MarketplaceApiError(response.status, body?.message || body?.error || "AI 连接测试失败");
  }
  return body;
}

export async function getManagedPlatformRouterConfig(): Promise<ManagedPlatformRouterConfig | null> {
  const response = await fetch("/api/platform/ai/config", { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => null) as { config?: ManagedPlatformRouterConfig | null; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "AI 配置读取失败");
  return body?.config ?? null;
}

export async function saveManagedPlatformRouterConfig(input: Omit<ManagedPlatformRouterConfig, "credentialConfigured"> & { apiKey?: string }): Promise<ManagedPlatformRouterConfig> {
  const response = await fetch("/api/platform/ai/config", {
    method: "PATCH", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { config?: ManagedPlatformRouterConfig; error?: string } | null;
  if (!response.ok || !body?.config) throw new MarketplaceApiError(response.status, body?.error || "AI 配置保存失败");
  return body.config;
}

export async function listManagedPlatformRouterModels(input: { endpoint: string; protocol: ManagedPlatformRouterConfig["protocol"]; apiKey?: string }): Promise<string[]> {
  const response = await fetch("/api/platform/ai/models", {
    method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { models?: string[]; error?: string } | null;
  if (!response.ok || !body?.models) throw new MarketplaceApiError(response.status, body?.error || "模型列表读取失败");
  return body.models;
}

export async function getRootEmailConfig(): Promise<RootEmailConfig | null> {
  const response = await fetch("/api/platform/email-config", {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { config?: RootEmailConfig | null; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "根邮箱配置读取失败");
  return body?.config ?? null;
}

export async function saveRootEmailConfig(input: Omit<RootEmailConfig, "credentialConfigured" | "version" | "updatedBy" | "createdAt" | "updatedAt"> & { smtpPassword?: string; expectedVersion?: number }): Promise<RootEmailConfig> {
  const response = await fetch("/api/platform/email-config", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { config?: RootEmailConfig; error?: string } | null;
  if (!response.ok || !body?.config) throw new MarketplaceApiError(response.status, body?.error || "根邮箱配置保存失败");
  return body.config;
}

export async function testRootEmailConfig(): Promise<void> {
  const response = await fetch("/api/platform/email-config/test", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "根邮箱测试失败");
}

export async function createPlatformAdminInvite(input: { email: string; expiresHours?: number }): Promise<PlatformAdminInvite> {
  const response = await fetch("/api/platform/admin-invites", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as (PlatformAdminInvite & { error?: string }) | null;
  if (!response.ok || !body?.registrationUrl) throw new MarketplaceApiError(response.status, body?.error || "平台管理员邀请创建失败");
  return body;
}

export async function getPublicPlatformSiteSettings(platformPath = "/"): Promise<PlatformSiteSettings> {
  const response = await fetch(`/api/platform/site-settings?platformPath=${encodeURIComponent(platformPath)}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { settings?: PlatformSiteSettings; error?: string } | null;
  if (!response.ok || !body?.settings) throw new MarketplaceApiError(response.status, body?.error || "平台备案信息读取失败");
  return body.settings;
}

export async function getPlatformSiteSettings(organizationId: string): Promise<PlatformSiteSettings> {
  const response = await fetch(`/api/platform/site-settings?organizationId=${encodeURIComponent(organizationId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { settings?: PlatformSiteSettings; error?: string } | null;
  if (!response.ok || !body?.settings) throw new MarketplaceApiError(response.status, body?.error || "平台备案设置读取失败");
  return body.settings;
}

export async function savePlatformSiteSettings(input: {
  organizationId: string;
  icpNumber: string;
  icpSubject: string;
  icpRecordUrl: string;
  publicSecurityNumber: string;
  publicSecurityUrl: string;
  expectedVersion?: number;
}): Promise<PlatformSiteSettings> {
  const response = await fetch("/api/platform/site-settings", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: input.organizationId,
      icpNumber: input.icpNumber.trim() || null,
      icpSubject: input.icpSubject.trim() || null,
      icpRecordUrl: input.icpRecordUrl.trim() || null,
      publicSecurityNumber: input.publicSecurityNumber.trim() || null,
      publicSecurityUrl: input.publicSecurityUrl.trim() || null,
      ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
    }),
  });
  const body = await response.json().catch(() => null) as { settings?: PlatformSiteSettings; error?: string } | null;
  if (!response.ok || !body?.settings) throw new MarketplaceApiError(response.status, body?.error || "平台备案设置保存失败");
  return body.settings;
}

export async function lookupPlatformSiteSettings(input: {
  organizationId: string;
  platformPath: string;
  hostname?: string;
}): Promise<PlatformSiteSettingsLookup> {
  const response = await fetch("/api/platform/site-settings", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "lookup", ...input }),
  });
  const body = await response.json().catch(() => null) as { settings?: PlatformSiteSettingsLookup; error?: string } | null;
  if (!response.ok || !body?.settings) throw new MarketplaceApiError(response.status, body?.error || "平台备案自动查询失败");
  return body.settings;
}

export async function getPlatformDomains(): Promise<PlatformDomainRecord[]> {
  const response = await fetch("/api/platform/domains", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as { domains?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "domain 列表读取失败");
  return Array.isArray(body?.domains) ? body.domains as PlatformDomainRecord[] : [];
}

export async function createPlatformDomain(input: { slug: string; name: string }): Promise<PlatformDomainRecord> {
  const response = await fetch("/api/platform/domains", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { domain?: PlatformDomainRecord; error?: string } | null;
  if (!response.ok || !body?.domain) throw new MarketplaceApiError(response.status, body?.error || "domain 创建失败");
  return body.domain;
}

export async function updatePlatformDomain(input: { id: string; name?: string; status?: "active" | "disabled" }): Promise<PlatformDomainRecord> {
  const response = await fetch("/api/platform/domains", {
    method: "PATCH",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { domain?: PlatformDomainRecord; error?: string } | null;
  if (!response.ok || !body?.domain) throw new MarketplaceApiError(response.status, body?.error || "domain 更新失败");
  return body.domain;
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

export async function discoverSubplatformSource(input: {
  domainId: string;
  parentOrganizationId?: string;
  sourceKind: "git" | "archive";
  sourceLocator: string;
  sourceDigest?: string;
  requestedScopes?: string[];
  membershipPolicy: "public" | "invite";
}): Promise<{ intakeId: string; state: string }> {
  const response = await fetch("/api/platform/subplatforms/discover", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { intakeId?: string; state?: string; error?: string } | null;
  if (!response.ok || !body?.intakeId) throw new MarketplaceApiError(response.status, body?.error || "子平台源码发现任务创建失败");
  return { intakeId: body.intakeId, state: body.state || "queued" };
}

export async function getSubplatformSourceIntake(intakeId: string): Promise<SubplatformSourceIntake> {
  const response = await fetch(`/api/platform/subplatforms/discover?intakeId=${encodeURIComponent(intakeId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await response.json().catch(() => null) as (Partial<SubplatformSourceIntake> & { error?: string }) | null;
  if (!response.ok || !body?.intakeId) throw new MarketplaceApiError(response.status, body?.error || "子平台源码发现状态读取失败");
  return body as SubplatformSourceIntake;
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
  idempotencyKey?: string;
}): Promise<PlatformIntentRoute> {
  const response = await fetch("/api/platform/match", {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      platformPath: input.platformPath,
      narrative: input.narrative,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }),
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

/** Execute a mounted child-owned retrieval adapter through the root authorization facade. */
export async function querySubplatformRetrieval(input: {
  requestId: string;
  platformPath: string;
  tenantId: string;
  domainId: string;
  narrative: string;
  requirements?: Record<string, unknown>;
  budgetMin?: string | null;
  budgetMax?: string | null;
  currency?: string | null;
  currencyScale?: number | null;
  limit?: number;
  traceId?: string | null;
}): Promise<RetrievalResult> {
  const response = await fetch("/api/platform/retrieval/query", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "matchplane.retrieval/v1",
      request_id: input.requestId,
      scope: {
        tenant_id: input.tenantId,
        domain_id: input.domainId,
        platform_path: input.platformPath,
      },
      input: {
        narrative: input.narrative,
        requirements: input.requirements ?? {},
        ...(input.budgetMin === undefined ? {} : { budget_min: input.budgetMin }),
        ...(input.budgetMax === undefined ? {} : { budget_max: input.budgetMax }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.currencyScale === undefined ? {} : { currency_scale: input.currencyScale }),
      },
      limit: input.limit ?? 20,
      ...(input.traceId === undefined ? {} : { trace_id: input.traceId }),
    }),
  });
  const body = await response.json().catch(() => null) as (Partial<RetrievalWireResult> & { error?: string }) | null;
  if (!response.ok || !body || body.protocol !== "matchplane.retrieval/v1") {
    throw new MarketplaceApiError(response.status, body?.error || "子平台检索暂时不可用");
  }
  const result = body as RetrievalWireResult;
  return {
    protocol: "matchplane.retrieval/v1",
    requestId: result.request_id,
    provider: result.provider,
    candidates: result.candidates.map((candidate) => ({
      assetId: candidate.asset_id,
      ...(candidate.offer_id === undefined ? {} : { offerId: candidate.offer_id }),
      ...(candidate.display_name === undefined ? {} : { displayName: candidate.display_name }),
      ...(candidate.attributes === undefined ? {} : { attributes: candidate.attributes }),
      ...(candidate.terms === undefined ? {} : { terms: candidate.terms }),
      score: candidate.score,
      reasons: candidate.reasons,
      ...(candidate.risks === undefined ? {} : { risks: candidate.risks }),
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    })),
    degraded: result.degraded,
    ...(result.generated_at === undefined ? {} : { generatedAt: result.generated_at }),
  };
}

interface RetrievalWireResult {
  protocol: "matchplane.retrieval/v1";
  request_id: string;
  provider: RetrievalResult["provider"];
  candidates: Array<{
    asset_id: string;
    offer_id?: string;
    display_name?: string;
    attributes?: Record<string, unknown>;
    terms?: Record<string, unknown>;
    score: number;
    reasons: string[];
    risks?: string[];
    metadata?: Record<string, unknown>;
  }>;
  degraded: boolean;
  generated_at?: string | null;
  error?: string;
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

export function createAdminRefund(input: {
  tenantId?: string;
  paymentId: string;
  amount: string;
  reason: string;
  idempotencyKey?: string;
}): Promise<RefundAdminRecord> {
  return paymentAdminRequest<RefundAdminRecord>("refunds", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      payment_id: input.paymentId,
      amount: input.amount,
      reason: input.reason,
      idempotency_key: input.idempotencyKey ?? `web-refund-${crypto.randomUUID()}`,
    }),
  });
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
  contact?: ContactExchange;
  preserveContact?: boolean;
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

export function createMarketplaceIntent(input: {
  session: PartySession;
  domainId: string;
  side: "demand" | "supply";
  narrative: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  supplyDiscoveryEnabled?: boolean;
  supplyDiscoveryExpiresAt?: string | null;
  idempotencyKey: string;
}): Promise<{ intent_id: string; [key: string]: unknown }> {
  return request<{ intent_id: string; [key: string]: unknown }>(
    "/v1/marketplace/intents",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        side: input.side,
        narrative: input.narrative,
        attributes: input.attributes ?? {},
        terms: input.terms ?? {},
        supply_discovery_enabled: input.supplyDiscoveryEnabled ?? false,
        supply_discovery_expires_at: input.supplyDiscoveryExpiresAt ?? null,
        idempotency_key: input.idempotencyKey,
      }),
    },
    input.session,
  );
}

export interface MarketplaceIntentState {
  intent_id: string;
  tenant_id: string;
  domain_id: string;
  participant_id: string;
  side: "demand" | "supply" | string;
  narrative: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  status: string;
  version: number;
  [key: string]: unknown;
}

/** Continue an existing conversation without creating a new demand on every turn. */
export function updateMarketplaceIntent(input: {
  session: PartySession;
  domainId: string;
  intentId: string;
  narrative: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  expectedVersion: number;
}): Promise<MarketplaceIntentState> {
  return request<MarketplaceIntentState>(
    `/v1/marketplace/intents/${encodeURIComponent(input.intentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        narrative: input.narrative,
        attributes: input.attributes ?? {},
        terms: input.terms ?? {},
        expected_version: input.expectedVersion,
      }),
    },
    input.session,
  );
}

export interface MarketplaceIntentProfileState {
  tenant_id: string;
  domain_id: string;
  participant_id: string;
  profile: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export function getMarketplaceProfile(input: {
  session: PartySession;
  domainId: string;
}): Promise<MarketplaceIntentProfileState | null> {
  const params = new URLSearchParams({
    tenant_id: input.session.tenantId,
    domain_id: input.domainId,
    participant_id: input.session.partyId,
  });
  return request<MarketplaceIntentProfileState | null>(
    `/v1/marketplace/profile?${params.toString()}`,
    { cache: "no-store" },
    input.session,
  );
}

/** Persist an opaque, subplatform-owned understanding; the kernel only versions and scopes it. */
export function upsertMarketplaceProfile(input: {
  session: PartySession;
  domainId: string;
  profile: Record<string, unknown>;
}): Promise<MarketplaceIntentProfileState> {
  return request<MarketplaceIntentProfileState>(
    "/v1/marketplace/profile",
    {
      method: "PUT",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        profile: input.profile,
      }),
    },
    input.session,
  );
}

export function recordMarketplaceBehaviorEvent(input: {
  session: PartySession;
  domainId: string;
  eventType: string;
  offerId?: string;
  intentId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ event_id: string; duplicate: boolean }> {
  return request<{ event_id: string; duplicate: boolean }>(
    "/v1/marketplace/events",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        ...(input.intentId ? { intent_id: input.intentId } : {}),
        ...(input.offerId ? { offer_id: input.offerId } : {}),
        event_type: input.eventType,
        ...(input.reason ? { reason: input.reason } : {}),
        metadata: input.metadata ?? {},
        idempotency_key: input.idempotencyKey ?? `web-${input.eventType}-${crypto.randomUUID()}`,
      }),
    },
    input.session,
  );
}

export function getMarketplaceOfferPreferences(input: {
  session: PartySession;
  domainId: string;
}): Promise<MarketplaceOfferPreference[]> {
  const params = new URLSearchParams({
    tenant_id: input.session.tenantId,
    domain_id: input.domainId,
    participant_id: input.session.partyId,
  });
  return request<{ preferences: MarketplaceOfferPreference[] }>(
    `/v1/marketplace/preferences?${params.toString()}`,
    { cache: "no-store" },
    input.session,
  ).then((response) => response.preferences);
}

export function setMarketplaceOfferPreference(input: {
  session: PartySession;
  domainId: string;
  offerId: string;
  state: "saved" | "dismissed" | "neutral";
  reason?: string;
}): Promise<MarketplaceOfferPreference> {
  return request<MarketplaceOfferPreference>(
    "/v1/marketplace/preferences",
    {
      method: "PUT",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        offer_id: input.offerId,
        state: input.state,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
    input.session,
  );
}

export function createMarketplaceSalesHandoff(input: {
  session: PartySession;
  domainId: string;
  intentId?: string;
  summary: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    "/v1/marketplace/sales-handoffs",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        ...(input.intentId ? { intent_id: input.intentId } : {}),
        summary: input.summary,
        idempotency_key: input.idempotencyKey ?? `web-sales-handoff-${crypto.randomUUID()}`,
      }),
    },
    input.session,
  );
}

export function getMarketplaceOfferMatches(input: {
  session: PartySession;
  domainId: string;
  intentId: string;
  limit?: number;
}): Promise<MarketplaceOfferCandidate[]> {
  return request<{ candidates: MarketplaceOfferCandidate[] }>(
    `/v1/marketplace/intents/${encodeURIComponent(input.intentId)}/matches`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        limit: input.limit ?? 20,
      }),
    },
    input.session,
  ).then((response) => response.candidates);
}

export function getMarketplaceDemandMatches(input: {
  session: PartySession;
  domainId: string;
  offerId: string;
  limit?: number;
}): Promise<MarketplaceDemandCandidate[]> {
  return request<{ offer_id: string; candidates: MarketplaceDemandCandidate[] }>(
    `/v1/marketplace/offers/${encodeURIComponent(input.offerId)}/demand-matches`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        offer_id: input.offerId,
        limit: input.limit ?? 20,
      }),
    },
    input.session,
  ).then((response) => response.candidates);
}

export function updateMarketplaceDemandDiscovery(input: {
  session: PartySession;
  domainId: string;
  intentId: string;
  enabled: boolean;
  expiresAt?: string | null;
}): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/v1/marketplace/intents/${encodeURIComponent(input.intentId)}/discovery`,
    {
      method: "PATCH",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        enabled: input.enabled,
        expires_at: input.expiresAt ?? null,
      }),
    },
    input.session,
  );
}

export function createMarketplaceIntroduction(input: {
  session: PartySession;
  domainId: string;
  intentId: string;
  offerId: string;
  score: number;
  reasons?: string[];
  idempotencyKey: string;
  expiresAt?: string;
}): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    "/v1/marketplace/introductions",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        intent_id: input.intentId,
        offer_id: input.offerId,
        participant_id: input.session.partyId,
        score: input.score,
        reasons: input.reasons ?? [],
        idempotency_key: input.idempotencyKey,
        expires_at: input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    },
    input.session,
  );
}

export function getMarketplaceIntroductions(input: {
  session: PartySession;
  domainId?: string;
}): Promise<MarketplaceIntroduction[]> {
  const params = new URLSearchParams({
    tenant_id: input.session.tenantId,
    participant_id: input.session.partyId,
  });
  if (input.domainId) params.set("domain_id", input.domainId);
  return request<{ introductions: MarketplaceIntroduction[] }>(
    `/v1/marketplace/introductions?${params.toString()}`,
    { cache: "no-store" },
    input.session,
  ).then((response) => response.introductions);
}

export function requestMarketplaceContact(input: {
  session: PartySession;
  domainId: string;
  introductionId: string;
  idempotencyKey?: string;
}): Promise<MarketplaceIntroduction> {
  return request<MarketplaceIntroduction>(
    `/v1/marketplace/introductions/${encodeURIComponent(input.introductionId)}/contact/request`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        idempotency_key: input.idempotencyKey ?? `web-contact-request-${input.introductionId}`,
      }),
    },
    input.session,
  );
}

export function consentMarketplaceContact(input: {
  session: PartySession;
  domainId: string;
  introductionId: string;
  idempotencyKey?: string;
}): Promise<MarketplaceIntroduction> {
  return request<MarketplaceIntroduction>(
    `/v1/marketplace/introductions/${encodeURIComponent(input.introductionId)}/contact/consent`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        idempotency_key: input.idempotencyKey ?? `web-contact-consent-${input.introductionId}`,
      }),
    },
    input.session,
  );
}

export function retrieveMarketplaceContact(input: {
  session: PartySession;
  domainId: string;
  introductionId: string;
  idempotencyKey?: string;
}): Promise<MarketplaceContactResponse> {
  return request<MarketplaceContactResponse>(
    `/v1/marketplace/introductions/${encodeURIComponent(input.introductionId)}/contact`,
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        participant_id: input.session.partyId,
        idempotency_key: input.idempotencyKey ?? `web-contact-release-${input.introductionId}`,
      }),
      cache: "no-store",
    },
    input.session,
  );
}

export function createMarketplaceOffer(input: {
  session: PartySession;
  domainId: string;
  externalKey: string;
  displayName: string;
  attributes: Record<string, unknown>;
  terms?: Record<string, unknown>;
}): Promise<MarketplaceOfferOutcome> {
  return request<MarketplaceOfferOutcome>(
    "/v1/marketplace/offers",
    {
      method: "POST",
      body: JSON.stringify({
        tenant_id: input.session.tenantId,
        domain_id: input.domainId,
        supply_party_id: input.session.partyId,
        external_key: input.externalKey,
        display_name: input.displayName,
        attributes: input.attributes,
        terms: input.terms ?? {},
      }),
    },
    input.session,
  );
}

/** Read the root-scoped generic offer queue for the administrator workspace. */
export async function getMarketplaceOfferAdminRecords(input?: {
  domainId?: string;
  status?: "draft" | "active" | "reserved" | "sold" | "withdrawn" | "expired";
  limit?: number;
}): Promise<MarketplaceOfferAdminRecord[]> {
  const query = new URLSearchParams();
  if (input?.domainId) query.set("domain_id", input.domainId);
  if (input?.status) query.set("status", input.status);
  if (input?.limit) query.set("limit", String(input.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await fetch(`/api/admin/marketplace/offers${suffix}`, {
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { offers?: unknown; error?: string } | null;
  if (!response.ok) throw new MarketplaceApiError(response.status, body?.error || "供给审核队列读取失败");
  return Array.isArray(body?.offers) ? body.offers as MarketplaceOfferAdminRecord[] : [];
}

/** Activate one draft through the Rust gateway's operator state transition. */
export async function activateMarketplaceOffer(input: {
  offerId: string;
  tenantId: string;
}): Promise<MarketplaceOfferAdminRecord & { catalog_sync?: { synced?: boolean; error?: string; platform_path?: string | null } }> {
  const response = await fetch(`/api/admin/marketplace/offers/${encodeURIComponent(input.offerId)}/activate`, {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: input.tenantId }),
  });
  const body = await response.json().catch(() => null) as (MarketplaceOfferAdminRecord & { error?: string }) | null;
  if (!response.ok || !body?.offer_id) throw new MarketplaceApiError(response.status, body?.error || "供给激活失败");
  return body;
}

/** Push the canonical offer projection to the selected child-owned catalog adapter. */
export async function syncMarketplaceOfferToChild(input: {
  offerId: string;
  tenantId: string;
  domainId: string;
  platformPath: string;
}): Promise<{ offerId: string; synced: boolean; platformPath: string | null }> {
  const response = await fetch("/api/platform/catalog/sync", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "matchplane.catalog/v1",
      request_id: crypto.randomUUID(),
      scope: {
        tenant_id: input.tenantId,
        domain_id: input.domainId,
        platform_path: input.platformPath,
      },
      offer_id: input.offerId,
    }),
  });
  const body = await response.json().catch(() => null) as { offer_id?: string; synced?: boolean; platform_path?: string | null; error?: string } | null;
  if (!response.ok && response.status !== 202) throw new MarketplaceApiError(response.status, body?.error || "子平台目录同步失败");
  if (!body?.offer_id) throw new MarketplaceApiError(502, "子平台目录同步返回了无效响应");
  return { offerId: body.offer_id, synced: body.synced === true, platformPath: body.platform_path ?? null };
}

/** Upload bytes transiently to the active child-owned media adapter. */
export async function uploadMarketplaceAttachment(input: {
  platformPath: string;
  tenantId: string;
  domainId: string;
  file: File;
  intentId?: string;
  kind?: "image" | "document" | "video" | "audio" | "file";
}): Promise<MarketplaceAttachment> {
  if (input.file.size < 1 || input.file.size > MAX_MEDIA_BYTES) {
    throw new MarketplaceApiError(413, "附件超过当前部署支持的大小上限");
  }
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const dataBase64 = bytesToBase64(bytes);
  const requestId = crypto.randomUUID();
  const response = await fetch(`${apiBase}/platform/media/upload`, {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: MEDIA_ATTACHMENT_PROTOCOL,
      request_id: requestId,
      scope: {
        tenant_id: input.tenantId,
        domain_id: input.domainId,
        platform_path: input.platformPath,
      },
      ...(input.intentId ? { intent_id: input.intentId } : {}),
      attachment: {
        kind: input.kind ?? inferBrowserMediaKind(input.file.type),
        file_name: input.file.name,
        media_type: input.file.type || "application/octet-stream",
        size_bytes: input.file.size,
        data_base64: dataBase64,
      },
    }),
  });
  const body = await readJson<unknown>(response);
  if (!response.ok) throw new MarketplaceApiError(response.status, readApiError(body) ?? "附件上传失败");
  const parsed = parseMediaUploadResponse(body, requestId, MAX_MEDIA_BYTES);
  if (!parsed.ok) throw new MarketplaceApiError(502, parsed.error);
  return parsed.value.attachment;
}

export function getMarketplaceOffers(input: {
  session: PartySession;
  domainId: string;
  limit?: number;
  offset?: number;
}): Promise<MarketplaceOffer[]> {
  const params = new URLSearchParams({
    tenant_id: input.session.tenantId,
    domain_id: input.domainId,
    supply_party_id: input.session.partyId,
    limit: String(input.limit ?? 50),
    offset: String(input.offset ?? 0),
  });
  return request<MarketplaceOffer[]>(
    `/v1/marketplace/offers?${params.toString()}`,
    { cache: "no-store" },
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

export function getSellerListingSubmissions(input: {
  session: PartySession;
  domainId: string;
  limit?: number;
  offset?: number;
}): Promise<ListingSubmission[]> {
  const params = new URLSearchParams({
    tenant_id: input.session.tenantId,
    domain_id: input.domainId,
    seller_party_id: input.session.partyId,
    limit: String(input.limit ?? 50),
    offset: String(input.offset ?? 0),
  });
  return request<ListingSubmission[]>(
    `/v1/marketplace/listing-submissions?${params.toString()}`,
    { cache: "no-store" },
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
    throw new MarketplaceApiError(409, "该供给不满足当前需求，请刷新匹配理由后再试");
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
