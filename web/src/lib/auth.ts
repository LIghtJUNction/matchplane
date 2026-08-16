import { betterAuth } from "better-auth";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { GenericOAuthConfig } from "better-auth/plugins";
import {
  admin as adminPlugin,
  emailOTP,
  genericOAuth,
  jwt,
  magicLink,
  organization,
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
import { sendConfiguredAuthEmail } from "./mail";

const database = new Pool({
  connectionString: process.env.MATCHPLANE_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.MATCHPLANE_AUTH_POOL_SIZE ?? 10),
});

// Shared only with root-side platform management helpers; application routes must still use
// Better Auth APIs for credentials, sessions, roles, and API-key verification.
export const authDatabase = database;

const baseURL = (
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
  "http://localhost:4173"
).trim().replace(/\/$/, "");

const configuredRootAdminEmail = process.env.MATCHPLANE_ROOT_ADMIN_EMAIL?.trim().toLowerCase();
const configuredSecret = process.env.BETTER_AUTH_SECRET?.trim();
const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";
const secret = configuredSecret ?? (isProductionBuild ? randomBytes(32).toString("base64url") : undefined);
const trustedOrigins = parseTrustedOrigins(baseURL, process.env.BETTER_AUTH_TRUSTED_ORIGINS);
const isProductionRuntime = process.env.NODE_ENV === "production" && process.env.MATCHPLANE_ENVIRONMENT === "production";
// Local Compose and test installations need a way to inspect the administrator workspace
// before an SMTP route exists. This switch is deliberately explicit and environment-gated:
// production always keeps Better Auth email verification enabled, even if an operator
// accidentally carries the development variable into a production deployment.
const allowDemoBootstrap =
  (process.env.MATCHPLANE_ENVIRONMENT === "development" || process.env.MATCHPLANE_ENVIRONMENT === "test")
  && process.env.MATCHPLANE_ALLOW_DEMO_BOOTSTRAP === "true";
const configuredSocialProviders = configuredOAuthProviders();
const oidcEnabled = process.env.MATCHPLANE_OIDC_ENABLED !== "false";
const oidcIssuer = `${baseURL}/api/auth`;

if (
  isProductionRuntime &&
  !isProductionBuild &&
  (!secret || secret.startsWith("CHANGE_ME") || secret.length < 32)
) {
  throw new Error("BETTER_AUTH_SECRET must be configured for the Next.js authentication service");
}

if (isProductionRuntime && !isProductionBuild) {
  if (!process.env.MATCHPLANE_DATABASE_URL?.trim()) {
    throw new Error("MATCHPLANE_DATABASE_URL must be configured for the Next.js authentication service");
  }
  if (!isHttpsOrigin(baseURL)) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin in production");
  }
  if (!configuredRootAdminEmail || isPlaceholderEmail(configuredRootAdminEmail)) {
    throw new Error("MATCHPLANE_ROOT_ADMIN_EMAIL must be an operator-owned address in production");
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
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: !allowDemoBootstrap,
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
    sendOnSignUp: !allowDemoBootstrap,
    sendOnSignIn: !allowDemoBootstrap,
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
    ...(oidcEnabled ? [jwt({
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
    }), oauthProvider({
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
      clientReference: ({ user }) => isRootPlatformRole(user?.role) ? "root-platform" : undefined,
      clientPrivileges: ({ action, user }) =>
        isRootPlatformRole(user?.role) && ["create", "read", "update", "delete", "list", "rotate"].includes(action),
    })] : []),
    emailOTP({
      otpLength: 6,
      expiresIn: 5 * 60,
      allowedAttempts: 3,
      storeOTP: "hashed",
      rateLimit: { window: 60, max: 3 },
      sendVerificationOTP: (data) =>
        sendConfiguredAuthEmail({
          recipient: data.email,
          subject: "你的 MatchPlane 登录验证码",
          text: `你的 MatchPlane 登录验证码是 ${data.otp}。验证码 5 分钟内有效，请勿转发给他人。`,
          html: `<p>你的 MatchPlane 登录验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:0.3em">${escapeHtml(data.otp)}</p><p>验证码 5 分钟内有效，请勿转发给他人。</p>`,
        }),
    }),
    magicLink({
      expiresIn: 5 * 60,
      storeToken: "hashed",
      rateLimit: { window: 60, max: 5 },
      sendMagicLink: (data) =>
        sendConfiguredAuthEmail({
          recipient: data.email,
          subject: "继续你的 MatchPlane 匹配",
          text: `请打开以下链接继续登录：${data.url}\n\n链接 5 分钟内有效。`,
          html: `<p>请打开以下链接继续登录：</p><p><a href="${escapeHtml(data.url)}">继续登录 MatchPlane</a></p><p>链接 5 分钟内有效。</p>`,
        }),
    }),
    ...(configuredSocialProviders.length
      ? [genericOAuth({ config: configuredSocialProviders })]
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
            parentOrganizationId: { type: "string", required: false, input: false },
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
        before: async (user) => {
          if (
            !configuredRootAdminEmail ||
            user.email.toLowerCase() !== configuredRootAdminEmail ||
            (user.emailVerified !== true && !allowDemoBootstrap)
          ) {
            return;
          }
          return { data: { ...user, role: "rootSuperAdmin" } };
        },
      },
      update: {
        after: async (user, context) => {
          if (
            !configuredRootAdminEmail ||
            user.email.toLowerCase() !== configuredRootAdminEmail ||
            user.emailVerified !== true ||
            user.role === "rootSuperAdmin"
          ) {
            return;
          }
          // Email verification and magic-link/OTP flows update the user after the
          // initial row is created. Promote only after that proof exists, then let
          // the hook's idempotency guard prevent a second write.
          await context?.context.internalAdapter.updateUser(user.id, { role: "rootSuperAdmin" });
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character,
  );
}

function parseTrustedOrigins(base: string, additional: string | undefined): string[] {
  const values = [base, ...(additional ?? "").split(",").map((value) => value.trim()).filter(Boolean)];
  return [...new Set(values.map((value) => new URL(value).origin))];
}

function isHttpsOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPlaceholderEmail(value: string): boolean {
  return value.endsWith("@example.com") || value.endsWith("@example.org") || value.endsWith("@example.net");
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

function configuredOAuthProviders(): GenericOAuthConfig[] {
  const definitions = [
    { providerId: "wechat", envKey: "WECHAT" },
    { providerId: "qq", envKey: "QQ" },
    { providerId: "alipay", envKey: "ALIPAY" },
  ] as const;

  return definitions.flatMap(({ providerId, envKey }) => {
    const prefix = `MATCHPLANE_${envKey}_OAUTH_`;
    const clientId = process.env[`${prefix}CLIENT_ID`]?.trim();
    const clientSecret = process.env[`${prefix}CLIENT_SECRET`]?.trim();
    const authorizationUrl = safeOAuthUrl(process.env[`${prefix}AUTHORIZATION_URL`]);
    const tokenUrl = safeOAuthUrl(process.env[`${prefix}TOKEN_URL`]);
    const userInfoUrl = safeOAuthUrl(process.env[`${prefix}USERINFO_URL`]);
    if (!clientId || !clientSecret || !authorizationUrl || !tokenUrl || !userInfoUrl) {
      const anyConfigured = [clientId, clientSecret, authorizationUrl, tokenUrl, userInfoUrl].some(Boolean);
      if (anyConfigured) console.warn(`${providerId} OAuth is not enabled: complete ${prefix} configuration is required`);
      return [];
    }

    return [{
      providerId,
      clientId,
      clientSecret,
      accountSubject: ({ profile }) => {
        const subject = firstProfileString(profile, ["sub", "id", "openid", "unionid", "user_id", "uid"]);
        if (!subject) throw new Error(`${providerId} OAuth profile has no stable subject`);
        return subject;
      },
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      scopes: parseOAuthScopes(process.env[`${prefix}SCOPES`]),
      mapProfileToUser: (profile: Record<string, unknown>) => {
        const subject = firstProfileString(profile, ["sub", "id", "openid", "unionid", "user_id", "uid"]);
        const email = firstProfileString(profile, ["email", "email_address"])
          ?? `${providerId}.${subject || "account"}@oauth.matchplane.invalid`;
        return {
          name: firstProfileString(profile, ["name", "nickname", "nick_name"]) ?? `${providerId} 用户`,
          email,
          // Never treat the mere presence of an email field as proof that the provider
          // verified it.  This keeps an unverified social profile from becoming the
          // configured root-admin identity or silently linking to a password account.
          emailVerified: firstProfileBoolean(profile, ["email_verified", "emailVerified", "verified_email"]),
          image: firstProfileString(profile, ["avatar", "avatar_url", "headimgurl", "picture"]),
        };
      },
    } satisfies GenericOAuthConfig];
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

function parseOAuthScopes(value: string | undefined): string[] {
  const scopes = (value ?? "openid,profile,email")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => /^[a-zA-Z0-9._:-]{1,64}$/.test(scope));
  return scopes.length ? [...new Set(scopes)] : ["openid"];
}

function firstProfileString(profile: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstProfileBoolean(profile: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|1|yes)$/i.test(value.trim())) return true;
  }
  return false;
}
