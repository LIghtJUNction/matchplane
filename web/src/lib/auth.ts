import { betterAuth } from "better-auth";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { apiKey } from "@better-auth/api-key";
import { admin as adminPlugin, organization } from "better-auth/plugins";

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
    requireEmailVerification: true,
    autoSignIn: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: (data, request) =>
      sendConfiguredAuthEmail({
        request,
        recipient: data.user.email,
        subject: "重置你的 MatchPlane 密码",
        text: `请打开以下链接重置密码：${data.url}`,
        html: `<p>请打开以下链接重置密码：</p><p><a href="${escapeHtml(data.url)}">重置密码</a></p>`,
      }),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: (data, request) =>
      sendConfiguredAuthEmail({
        request,
        recipient: data.user.email,
        subject: "验证你的 MatchPlane 邮箱",
        text: `请打开以下链接完成邮箱验证：${data.url}`,
        html: `<p>请打开以下链接完成邮箱验证：</p><p><a href="${escapeHtml(data.url)}">验证邮箱</a></p>`,
      }),
  },
  plugins: [
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
          if (!configuredRootAdminEmail || user.email.toLowerCase() !== configuredRootAdminEmail) {
            return;
          }
          return { data: { ...user, role: "rootSuperAdmin" } };
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
