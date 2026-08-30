import { betterAuth } from "better-auth";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import type { GenericOAuthConfig } from "better-auth/plugins";
import {
  admin as adminPlugin,
  emailOTP,
  genericOAuth,
  jwt,
  organization,
  getOrgAdapter,
  phoneNumber,
} from "better-auth/plugins";

import {
  adminAccessControl,
  organizationAccessControl,
  organizationOwner,
  rootAdmin,
  rootSuperAdmin,
  subplatformAdmin,
  subplatformMember,
  subplatformModerator,
} from "./permissions";
import { isRootEmailAuthConfigured, sendConfiguredAuthEmail } from "./mail";
import { sendConfiguredPhoneOtp } from "./sms";
import { isProductionEnvironment } from "./runtime";
import { readManagedNationalIdentityConfig } from "./national-identity-config";
import {
  createWeChatTokenExchange,
  createWeChatUserInfoLoader,
  isWeChatNativeEndpoint,
  readManagedWeChatOAuthConfig,
} from "./wechat-oauth-config";
import { isUuid } from "./uuid";
import {
  isReservedSuperAdminEmail,
  matchesReservedSuperAdminInvite,
  readSuperAdminBootstrapClaimToken,
} from "./super-admin-bootstrap";

const database = new Pool({
  connectionString:
    process.env.MATCHPLANE_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.MATCHPLANE_AUTH_POOL_SIZE ?? 10),
});

// Shared only with root-side platform management helpers; application routes must still use
// Better Auth APIs for credentials, sessions, roles, and API-key verification.
export const authDatabase = database;

const configuredBaseURL =
  process.env.BETTER_AUTH_URL?.trim() ||
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
  "http://localhost:4173";
const baseURL = configuredBaseURL.replace(/\/$/, "");
/** Canonical server-configured Better Auth base used for redirects and public callback metadata. */
export const authBaseURL = baseURL;
const parsedBaseURL = requiredAbsoluteUrl(baseURL, "BETTER_AUTH_URL");

const configuredRootAdminEmail =
  process.env.MATCHPLANE_ROOT_ADMIN_EMAIL?.trim().toLowerCase();
const configuredSecret = process.env.BETTER_AUTH_SECRET?.trim();
const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
const secret =
  configuredSecret ??
  (isProductionBuild ? randomBytes(32).toString("base64url") : undefined);
const trustedOrigins = parseTrustedOrigins(
  baseURL,
  process.env.BETTER_AUTH_TRUSTED_ORIGINS,
);
// MatchPlane's explicit deployment profile takes precedence over Next.js' build mode. Local
// Compose intentionally uses NODE_ENV=production for an optimized bundle while retaining the
// development profile and its local-only defaults.
const isProductionRuntime = isProductionEnvironment();
// Local Compose and test installations need a way to inspect the administrator workspace
// before an SMTP route exists. This switch is deliberately explicit and environment-gated:
// production never enables the demo-account bootstrap or suppresses the registration
// verification step, even if an operator accidentally carries the development variable into a
// production deployment.
const allowDevAuthBootstrap =
  (process.env.MATCHPLANE_ENVIRONMENT === "development" ||
    process.env.MATCHPLANE_ENVIRONMENT === "test") &&
  process.env.MATCHPLANE_ALLOW_DEMO_BOOTSTRAP === "true";
const configuredSocialProviders = configuredOAuthProviders();
const oidcEnabled = process.env.MATCHPLANE_OIDC_ENABLED !== "false";
const oidcIssuer = `${baseURL}/api/auth`;

/**
 * OIDC client ownership is scoped to this deployment's root tenant. The legacy fallback is kept
 * only for local installations that have not configured a tenant yet; production setup requires
 * MATCHPLANE_ROOT_TENANT_ID before any root client can be used.
 */
export function rootPlatformReferenceId(): string {
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  return tenantId && isUuid(tenantId)
    ? `root-platform:${tenantId}`
    : "root-platform";
}

if (
  isProductionRuntime &&
  !isProductionBuild &&
  (!secret || secret.startsWith("CHANGE_ME") || secret.length < 32)
) {
  throw new Error(
    "BETTER_AUTH_SECRET must be configured for the Next.js authentication service",
  );
}

if (isProductionRuntime && !isProductionBuild) {
  if (!process.env.MATCHPLANE_DATABASE_URL?.trim()) {
    throw new Error(
      "MATCHPLANE_DATABASE_URL must be configured for the Next.js authentication service",
    );
  }
  if (!isHttpsOrigin(baseURL)) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin in production");
  }
  // A missing address is a safe, observable first-run state: the web service can expose the
  // bounded setup status and tell the operator what to configure.  A supplied placeholder is
  // still fatal so a deployment can never accidentally promote an example account.
  if (
    configuredRootAdminEmail &&
    isPlaceholderEmail(configuredRootAdminEmail)
  ) {
    throw new Error(
      "MATCHPLANE_ROOT_ADMIN_EMAIL must be an operator-owned address in production",
    );
  }
}

/**
 * MatchPlane authentication authority.
 *
 * Better Auth owns password hashing, email verification, reset tokens, sessions, and
 * organization membership. Marketplace bearer capabilities remain a server-side integration
 * boundary for the Rust domain API and are only issued after this session is verified.
 */
export const auth = betterAuth({
  database,
  baseURL,
  basePath: "/api/auth",
  secret,
  // Never reflect the request's Origin header here. It is attacker-controlled and doing so
  // would turn CSRF protection into an allow-any-origin policy. Operators may explicitly add
  // known front-end origins through BETTER_AUTH_TRUSTED_ORIGINS.
  trustedOrigins,
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
    // Session hydration is a read-only, cookie-bound check. Keeping it on the shared
    // IP bucket lets one stale browser tab make every other signed-in tab appear logged out.
    customRules: { "/get-session": false },
  },
  account: {
    accountLinking: {
      enabled: true,
      // A user must explicitly start the link flow from their authenticated account page.
      disableImplicitLinking: true,
      updateUserInfoOnLink: false,
      // WeChat commonly has no verified email. Its OAuth proof is accepted only inside the
      // explicit authenticated link flow; it never becomes an implicit email-account match.
      trustedProviders: ["wechat"],
      allowDifferentEmails: true,
    },
  },
  user: {
    additionalFields: {
      marketplaceRole: { type: "string", required: false, input: true },
      legalTermsVersion: { type: "number", required: false, input: true },
      legalPrivacyVersion: { type: "number", required: false, input: true },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Verification is a registration trust step, not a second factor for an existing
    // account. Operators must be able to sign in with the password they already set even
    // when the deployment has no mail route configured.
    requireEmailVerification: false,
    autoSignIn: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: (data) =>
      sendConfiguredAuthEmail({
        recipient: data.user.email,
        subject: "重置你的 MatchPlane 密码",
        text: `请打开以下链接重置密码：${data.url}`,
        html: `<p>请打开以下链接重置密码：</p><p><a href="${escapeHtml(data.url)}">重置密码</a></p>`,
      }),
  },
  emailVerification: {
    sendOnSignUp: false,
    sendOnSignIn: false,
    autoSignInAfterVerification: true,
    sendVerificationEmail: (data) =>
      sendConfiguredAuthEmail({
        recipient: data.user.email,
        subject: "验证你的 MatchPlane 邮箱",
        text: `请打开以下链接完成邮箱验证：${data.url}`,
        html: `<p>请打开以下链接完成邮箱验证：</p><p><a href="${escapeHtml(data.url)}">验证邮箱</a></p>`,
      }),
  },
  plugins: [
    ...(oidcEnabled
      ? [
          jwt({
            jwks: {
              keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
              rotationInterval: 60 * 60 * 24 * 30,
              gracePeriod: 60 * 60 * 24 * 30,
            },
            jwt: {
              issuer: oidcIssuer,
              expirationTime: "15m",
            },
            // OAuth/OIDC owns its own tokens. Do not add a signed JWT to ordinary
            // Better Auth session responses where it could be mistaken for a platform
            // capability.
            disableSettingJwtHeader: true,
          }),
          oauthProvider({
            scopes: ["openid", "profile", "email"],
            loginPage: "/login",
            consentPage: "/oauth/consent",
            requirePKCE: true,
            allowDynamicClientRegistration: false,
            clientRegistrationDefaultScopes: ["openid", "profile", "email"],
            clientRegistrationAllowedScopes: ["openid", "profile", "email"],
            grantTypes: ["authorization_code", "refresh_token"],
            disableJwtPlugin: false,
            storeClientSecret: "hashed",
            storeTokens: "hashed",
            prefix: {
              opaqueAccessToken: "mp_at_",
              refreshToken: "mp_rt_",
              clientSecret: "mp_cs_",
            },
            advertisedMetadata: {
              scopes_supported: ["openid", "profile", "email"],
              claims_supported: [
                "sub",
                "iss",
                "aud",
                "exp",
                "iat",
                "sid",
                "email",
                "email_verified",
                "name",
              ],
            },
            silenceWarnings: {
              oauthAuthServerConfig: true,
              openidConfig: true,
            },
            // Cross-origin clients are root-managed confidential applications.  Keep the
            // ownership scope stable across root administrators while rejecting all
            // organization-scoped users from the provider's CRUD surface.
            clientReference: ({ user }) =>
              isRootPlatformRole(user?.role)
                ? rootPlatformReferenceId()
                : undefined,
            clientPrivileges: ({ action, user }) =>
              isRootPlatformRole(user?.role) &&
              ["create", "read", "update", "delete", "list", "rotate"].includes(
                action,
              ),
          }),
        ]
      : []),
    emailOTP({
      otpLength: 6,
      expiresIn: 5 * 60,
      allowedAttempts: 3,
      storeOTP: "hashed",
      sendVerificationOnSignUp: false,
      disableSignUp: true,
      overrideDefaultEmailVerification: true,
      rateLimit: { window: 60, max: 3 },
      sendVerificationOTP: (data) => {
        const resettingPassword = data.type === "forget-password";
        return sendConfiguredAuthEmail({
          recipient: data.email,
          subject: resettingPassword
            ? "重置你的 MatchPlane 密码"
            : "你的 MatchPlane 登录验证码",
          text: `你的 MatchPlane${resettingPassword ? "密码重置" : "登录"}验证码是 ${data.otp}。验证码 5 分钟内有效，请勿转发给他人。`,
          html: `<p>你的 MatchPlane${resettingPassword ? "密码重置" : "登录"}验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:0.3em">${escapeHtml(data.otp)}</p><p>验证码 5 分钟内有效，请勿转发给他人。</p>`,
        });
      },
    }),
    phoneNumber({
      otpLength: 6,
      expiresIn: 5 * 60,
      allowedAttempts: 3,
      // Phone OTP remains an existing-account factor. Registration is brokered by MatchPlane.
      requireVerification: false,
      phoneNumberValidator: (value) => /^\+[1-9]\d{7,14}$/.test(value),
      sendOTP: sendConfiguredPhoneOtp,
    }),
    passkey({
      rpName: "MatchPlane",
      rpID: parsedBaseURL.hostname,
      origin: baseURL,
    }),
    ...(configuredSocialProviders.length
      ? [
          genericOAuth({
            config: configuredSocialProviders.map((provider) => ({
              ...provider,
              disableImplicitSignUp: true,
            })),
          }),
        ]
      : []),
    apiKey({
      configId: "platform",
      references: "organization",
      apiKeyHeaders: ["x-matchplane-api-key", "x-api-key"],
      defaultKeyLength: 48,
      defaultPrefix: "mpk_",
      requireName: true,
      enableMetadata: true,
      enableSessionForAPIKeys: false,
      keyExpiration: {
        defaultExpiresIn: 90 * 24 * 60 * 60,
        minExpiresIn: 1,
        maxExpiresIn: 365,
      },
      rateLimit: {
        enabled: true,
        timeWindow: 60 * 60 * 1000,
        maxRequests: 10_000,
      },
      permissions: {
        defaultPermissions: {
          platform: ["read"],
        },
      },
    }),
    adminPlugin({
      ac: adminAccessControl,
      roles: { rootSuperAdmin, rootAdmin },
      adminRoles: ["rootSuperAdmin"],
      defaultRole: "user",
    }),
    organization({
      ac: organizationAccessControl,
      roles: {
        owner: organizationOwner,
        admin: subplatformAdmin,
        subplatform_admin: subplatformAdmin,
        moderator: subplatformModerator,
        member: subplatformMember,
      },
      allowUserToCreateOrganization: false,
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 32 },
      schema: {
        organization: {
          additionalFields: {
            tenantId: { type: "string", required: false, input: false },
            domainId: { type: "string", required: false, input: false },
            sourceRepository: { type: "string", required: false, input: false },
            parentOrganizationId: {
              type: "string",
              required: false,
              input: false,
            },
          },
        },
        member: {
          additionalFields: {
            labels: { type: "string[]", required: false, input: true },
          },
        },
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          const legal = await currentLegalVersions();
          const acceptedTermsVersion = legalVersionFromUser(
            user,
            "legalTermsVersion",
          );
          const acceptedPrivacyVersion = legalVersionFromUser(
            user,
            "legalPrivacyVersion",
          );
          if (
            !legal ||
            acceptedTermsVersion !== legal.terms ||
            acceptedPrivacyVersion !== legal.privacy
          ) {
            throw new Error("请先阅读并同意当前用户协议和隐私政策");
          }
          const acceptedLegalData = {
            legalTermsVersion: legal.terms,
            legalPrivacyVersion: legal.privacy,
          };
          const bootstrapClaimToken = readSuperAdminBootstrapClaimToken(
            context?.headers,
          );
          const bootstrapReservation = await authorizeReservedSuperAdminInvite(
            user.email,
            bootstrapClaimToken,
          );
          if (bootstrapReservation === "authorized") {
            return {
              data: { ...user, ...acceptedLegalData, role: "rootSuperAdmin" },
            };
          }
          if (bootstrapReservation === "reserved") {
            // Do not let an unproved password signup squat the operator's reserved email. The
            // browser that claimed the CLI token carries the only valid promotion proof.
            throw new Error("超级管理员注册链接无效或已过期");
          }
          if (!allowDevAuthBootstrap && !(await isRootEmailAuthConfigured())) {
            throw new Error("普通用户注册暂未开放");
          }
          return { data: { ...user, ...acceptedLegalData } };
        },
        after: async (user) => {
          if (
            (user as typeof user & { role?: string | null }).role ===
            "rootSuperAdmin"
          ) {
            await consumeReservedSuperAdminInvite(user.email, user.id);
          }
          await recordLegalAcceptance(user);
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          const user = await context?.context.internalAdapter.findUserById(
            session.userId,
          );
          const role =
            (user as (typeof user & { role?: string | null }) | null)?.role ??
            "user";
          if (role === "user" && user?.emailVerified !== true) {
            throw new Error("普通账号完成邮箱验证后才能登录");
          }
        },
      },
    },
  },
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
});

async function authorizeReservedSuperAdminInvite(
  email: string,
  claimToken: string | null,
): Promise<"none" | "reserved" | "authorized"> {
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!tenantId || !isUuid(tenantId)) return "none";
  const result = await authDatabase.query<{
    registrationEmail: string | null;
    targetEmail: string | null;
    tokenHash: string;
  }>(
    `SELECT registration_email AS "registrationEmail",
            target_email AS "targetEmail",
            token_hash AS "tokenHash"
       FROM root_superadmin_invites
      WHERE tenant_id = $1::uuid
        AND used_at IS NULL
        AND expires_at > clock_timestamp()`,
    [tenantId],
  );
  const invite = result.rows[0];
  if (!isReservedSuperAdminEmail(invite, email)) return "none";
  return matchesReservedSuperAdminInvite(invite, email, claimToken)
    ? "authorized"
    : "reserved";
}

async function currentLegalVersions(): Promise<{
  terms: number;
  privacy: number;
} | null> {
  const tenantId = await legalTenantId();
  if (!tenantId) return null;
  const result = await authDatabase.query<{
    kind: "terms" | "privacy";
    version: string;
  }>(
    `SELECT kind, version::text FROM mall_legal_documents
      WHERE tenant_id = $1::uuid AND kind = ANY($2::text[])`,
    [tenantId, ["terms", "privacy"]],
  );
  const terms = result.rows.find((row) => row.kind === "terms");
  const privacy = result.rows.find((row) => row.kind === "privacy");
  const termsVersion = Number(terms?.version);
  const privacyVersion = Number(privacy?.version);
  if (
    !Number.isSafeInteger(termsVersion) ||
    termsVersion < 1 ||
    !Number.isSafeInteger(privacyVersion) ||
    privacyVersion < 1
  )
    return null;
  return { terms: termsVersion, privacy: privacyVersion };
}

function legalVersionFromUser(
  user: unknown,
  key: "legalTermsVersion" | "legalPrivacyVersion",
): number | null {
  const value =
    user && typeof user === "object"
      ? (user as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

async function recordLegalAcceptance(user: {
  id: string;
  legalTermsVersion?: unknown;
  legalPrivacyVersion?: unknown;
}): Promise<void> {
  const tenantId = await legalTenantId();
  if (!tenantId) return;
  const termsVersion = legalVersionFromUser(user, "legalTermsVersion");
  const privacyVersion = legalVersionFromUser(user, "legalPrivacyVersion");
  if (!termsVersion || !privacyVersion) return;
  await authDatabase.query(
    `INSERT INTO user_legal_acceptances (tenant_id, user_id, terms_version, privacy_version)
     VALUES ($1::uuid, $2::uuid, $3::bigint, $4::bigint)
     ON CONFLICT DO NOTHING`,
    [tenantId, user.id, termsVersion, privacyVersion],
  );
}

async function legalTenantId(): Promise<string | null> {
  const configured = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (configured && isUuid(configured)) return configured;
  const result = await authDatabase.query<{ id: string }>(
    `SELECT tenant.id::text AS id
       FROM tenants tenant
       JOIN "organization" organization
         ON organization."tenantId" = tenant.id::text
        AND organization."rootPlatform" = true
        AND organization."parentOrganizationId" IS NULL
      WHERE tenant.status = 'active'
      ORDER BY tenant.created_at ASC
      LIMIT 2`,
  );
  return result.rows.length === 1 ? (result.rows[0]?.id ?? null) : null;
}

async function consumeReservedSuperAdminInvite(
  email: string,
  userId: string,
): Promise<void> {
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!tenantId || !isUuid(tenantId)) return;
  await authDatabase.query(
    `UPDATE root_superadmin_invites
        SET used_at = clock_timestamp(), used_by = $2::uuid
      WHERE tenant_id = $1::uuid
        AND used_at IS NULL
        AND lower(registration_email) = lower($3)`,
    [tenantId, userId, email],
  );
}

/**
 * Apply a previously verified, one-time operator invite without pretending that the invitee is
 * already an administrator. The database adapter is still Better Auth's own adapter; this
 * helper is kept server-only and is never exposed to browser callers directly.
 */
export async function applyPlatformAdminInviteRole(input: {
  userId: string;
  organizationId: string;
  role: "rootAdmin" | "subplatform_admin";
}): Promise<{ userId: string; organizationId: string; role: string }> {
  const context = await auth.$context;
  const user = await context.internalAdapter.findUserById(input.userId);
  if (!user) throw new Error("invitee account no longer exists");
  const userWithRole = user as typeof user & { role?: string | null };

  if (input.role === "rootAdmin") {
    if (userWithRole.role !== "rootSuperAdmin") {
      await context.internalAdapter.updateUser(input.userId, {
        role: "rootAdmin",
      });
    }
    return {
      userId: input.userId,
      organizationId: input.organizationId,
      role:
        userWithRole.role === "rootSuperAdmin" ? "rootSuperAdmin" : "rootAdmin",
    };
  }

  // The plugin context returned by this Better Auth build is structurally compatible with
  // AuthContext, but its generic options are intentionally narrower. Keep the cast at this
  // server-only integration boundary rather than leaking Better Auth internals into routes.
  const organizationAdapter = getOrgAdapter(context as never);
  const member = await organizationAdapter.findMemberByOrgId({
    userId: input.userId,
    organizationId: input.organizationId,
  });
  if (!member) {
    await organizationAdapter.createMember({
      organizationId: input.organizationId,
      userId: input.userId,
      role: "admin",
    });
    return {
      userId: input.userId,
      organizationId: input.organizationId,
      role: "admin",
    };
  }
  if (member.role !== "owner" && member.role !== "admin") {
    await organizationAdapter.updateMember(member.id, "admin");
  }
  return {
    userId: input.userId,
    organizationId: input.organizationId,
    role: member.role === "owner" ? "owner" : "admin",
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function parseTrustedOrigins(
  base: string,
  additional: string | undefined,
): string[] {
  const values = [
    base,
    ...(additional ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  return [
    ...new Set(
      values.map(
        (value) =>
          requiredAbsoluteUrl(value, "BETTER_AUTH_TRUSTED_ORIGINS").origin,
      ),
    ),
  ];
}

function requiredAbsoluteUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch (cause) {
    throw new Error(`${field} must contain valid absolute URLs`, { cause });
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPlaceholderEmail(value: string): boolean {
  return (
    value.endsWith("@example.com") ||
    value.endsWith("@example.org") ||
    value.endsWith("@example.net")
  );
}

function isRootPlatformRole(role: unknown): boolean {
  return role === "rootSuperAdmin" || role === "rootAdmin";
}

/**
 * Social login is deliberately opt-in. A provider is exposed only when its complete server-side
 * OAuth configuration is present; client code receives the provider id, never these credentials.
 */
export function configuredOAuthProviderIds(): string[] {
  return configuredSocialProviders.map((provider) => provider.providerId);
}

/**
 * The national network identity provider is deliberately separate from the
 * fallback/social list.  It is promoted by the login UI only when a complete
 * operator-approved adapter is configured; an unset adapter keeps the normal
 * login screen unchanged.
 */
export function configuredPrimaryOAuthProviderIds(): string[] {
  return configuredSocialProviders
    .filter((provider) => provider.providerId === "national_identity")
    .map((provider) => provider.providerId);
}

export function configuredFallbackOAuthProviderIds(): string[] {
  return configuredSocialProviders
    .filter((provider) => provider.providerId !== "national_identity")
    .map((provider) => provider.providerId);
}

function configuredOAuthProviders(): GenericOAuthConfig[] {
  const definitions = [
    {
      providerId: "national_identity",
      envKey: "NATIONAL_IDENTITY",
      defaultScopes: ["openid"],
    },
    {
      providerId: "google",
      envKey: "GOOGLE",
      defaultScopes: ["openid", "profile", "email"],
    },
    {
      providerId: "wechat",
      envKey: "WECHAT",
      // WeChat Open Platform website QR login only understands its own scope.
      defaultScopes: ["snsapi_login"],
    },
    {
      providerId: "qq",
      envKey: "QQ",
      defaultScopes: ["openid", "profile", "email"],
    },
    {
      providerId: "alipay",
      envKey: "ALIPAY",
      defaultScopes: ["openid", "profile", "email"],
    },
  ] as const;

  return definitions.flatMap(({ providerId, envKey, defaultScopes }) => {
    const prefix = `MATCHPLANE_${envKey}_OAUTH_`;
    const managedNationalIdentity =
      providerId === "national_identity"
        ? readManagedNationalIdentityConfig()
        : null;
    const managedWeChat =
      providerId === "wechat" ? readManagedWeChatOAuthConfig() : null;
    // A saved but disabled managed record intentionally wins over deployment
    // variables so an operator can turn the integration off from the mall
    // settings without deleting credentials from the host.
    if (managedNationalIdentity && !managedNationalIdentity.enabled) return [];
    if (managedWeChat && !managedWeChat.enabled) return [];
    const clientId =
      managedNationalIdentity?.clientId ??
      managedWeChat?.appId ??
      process.env[`${prefix}CLIENT_ID`]?.trim();
    const clientSecret =
      managedNationalIdentity?.clientSecret ??
      managedWeChat?.appSecret ??
      process.env[`${prefix}CLIENT_SECRET`]?.trim();
    // Some approved identity gateways publish OIDC discovery, while others
    // provide a fixed authorization/token/userinfo contract.  Never invent a
    // public endpoint here: operators must supply the URLs from their signed
    // application-access agreement or official SDK gateway.
    const discoveryUrl = safeOAuthUrl(
      managedNationalIdentity?.discoveryUrl ??
        process.env[`${prefix}DISCOVERY_URL`],
    );
    const authorizationUrl = safeOAuthUrl(
      managedNationalIdentity?.authorizationUrl ??
        managedWeChat?.authorizationUrl ??
        process.env[`${prefix}AUTHORIZATION_URL`],
    );
    const tokenUrl = safeOAuthUrl(
      managedNationalIdentity?.tokenUrl ??
        managedWeChat?.tokenUrl ??
        process.env[`${prefix}TOKEN_URL`],
    );
    const userInfoUrl = safeOAuthUrl(
      managedNationalIdentity?.userInfoUrl ??
        managedWeChat?.userInfoUrl ??
        process.env[`${prefix}USERINFO_URL`],
    );
    const hasEndpointContract = Boolean(
      discoveryUrl || (authorizationUrl && tokenUrl && userInfoUrl),
    );
    if (!clientId || !clientSecret || !hasEndpointContract) {
      const anyConfigured = [
        clientId,
        clientSecret,
        discoveryUrl,
        authorizationUrl,
        tokenUrl,
        userInfoUrl,
      ].some(Boolean);
      if (anyConfigured)
        console.warn(
          `${providerId} OAuth is not enabled: complete ${prefix} configuration is required`,
        );
      return [];
    }

    // WeChat's own sns endpoints do not implement standard OAuth2. Apply the
    // native-protocol adapter only for WeChat-hosted endpoints so a
    // standards-compliant proxy or mock gateway keeps the default flow.
    const wechatNativeProtocol =
      providerId === "wechat" &&
      !discoveryUrl &&
      isWeChatNativeEndpoint(tokenUrl);

    return [
      {
        providerId,
        name:
          providerId === "national_identity" ? "国家网络身份认证" : providerId,
        clientId,
        clientSecret,
        ...(discoveryUrl
          ? { discoveryUrl, requireIdTokenVerification: true }
          : {
              authorizationUrl,
              tokenUrl,
              userInfoUrl,
            }),
        accountSubject: ({ profile }) => {
          const subject = firstProfileString(
            profile,
            providerId === "national_identity"
              ? [
                  "sub",
                  "id",
                  "network_id",
                  "net_id",
                  "user_id",
                  "uid",
                  "openid",
                ]
              : ["sub", "id", "openid", "unionid", "user_id", "uid"],
          );
          if (!subject)
            throw new Error(
              `${providerId} OAuth profile has no stable subject`,
            );
          // The national service's subject is an opaque network identifier, but
          // hashing it before persisting still keeps raw identity material out of
          // the Better Auth account table while preserving stable linking.
          return providerId === "national_identity"
            ? opaqueIdentitySubject(subject)
            : subject;
        },
        scopes:
          managedNationalIdentity?.scopes ??
          managedWeChat?.scopes ??
          parseOAuthScopes(process.env[`${prefix}SCOPES`], defaultScopes),
        ...(wechatNativeProtocol &&
        clientId &&
        clientSecret &&
        tokenUrl &&
        userInfoUrl
          ? {
              // The qrconnect page reads appid (client_id is ignored) and the
              // sns token endpoint does not understand PKCE parameters.
              pkce: false,
              authorizationUrlParams: { appid: clientId },
              getToken: createWeChatTokenExchange({
                tokenUrl,
                appId: clientId,
                appSecret: clientSecret,
              }),
              getUserInfo: createWeChatUserInfoLoader({ userInfoUrl }),
            }
          : {}),
        mapProfileToUser: (profile: Record<string, unknown>) => {
          const subject = firstProfileString(
            profile,
            providerId === "national_identity"
              ? [
                  "sub",
                  "id",
                  "network_id",
                  "net_id",
                  "user_id",
                  "uid",
                  "openid",
                ]
              : ["sub", "id", "openid", "unionid", "user_id", "uid"],
          );
          const email =
            providerId === "national_identity"
              ? `national-${opaqueIdentitySubject(subject || "account")}@identity.matchplane.invalid`
              : (firstProfileString(profile, ["email", "email_address"]) ??
                `${providerId}.${subject || "account"}@oauth.matchplane.invalid`);
          return {
            name:
              firstProfileString(profile, ["name", "nickname", "nick_name"]) ??
              (providerId === "national_identity"
                ? "网络身份用户"
                : `${providerId} 用户`),
            email,
            // Never treat the mere presence of an email field as proof that the provider
            // verified it.  This keeps an unverified social profile from becoming the
            // configured root-admin identity or silently linking to a password account.
            // The national provider normally does not return an email at all; its
            // synthetic address is an internal Better Auth key, not a contact route.
            emailVerified:
              providerId === "national_identity"
                ? false
                : firstProfileBoolean(profile, [
                    "email_verified",
                    "emailVerified",
                    "verified_email",
                  ]),
            image: firstProfileString(profile, [
              "avatar",
              "avatar_url",
              "headimgurl",
              "picture",
            ]),
          };
        },
      } satisfies GenericOAuthConfig,
    ];
  });
}

function safeOAuthUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && isProductionRuntime) return undefined;
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseOAuthScopes(
  value: string | undefined,
  defaults: readonly string[] = ["openid", "profile", "email"],
): string[] {
  const scopes = (value ?? defaults.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => /^[a-zA-Z0-9._:-]{1,64}$/.test(scope));
  return scopes.length ? [...new Set(scopes)] : ["openid"];
}

function opaqueIdentitySubject(value: string): string {
  return createHash("sha256")
    .update(`matchplane:national-identity:${value}`)
    .digest("hex");
}

function firstProfileString(
  profile: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function firstProfileBoolean(
  profile: Record<string, unknown>,
  keys: string[],
): boolean {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|1|yes)$/i.test(value.trim()))
      return true;
  }
  return false;
}
