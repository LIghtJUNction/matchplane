import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import {
  auth,
  applyPlatformAdminInviteRole,
  authDatabase,
} from "../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { isUuid } from "../../../../src/lib/uuid";
import { jsonError } from "../../../../src/lib/json-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redeem a CLI-issued administrator link exactly once for the current Better Auth user. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("Better Auth session is required", 401);
  // A CLI invitation grants an administrative role; do not let an unverified
  // password/OTP account turn a leaked link into privileged access. OAuth-based
  // identity providers that are trusted for admin use must map their verified
  // proof to Better Auth's emailVerified flag before the invite can be redeemed.
  if (session.user.emailVerified !== true) {
    return jsonError("完成账号验证后即可兑换管理员注册链接", 403);
  }

  let input: Record<string, unknown>;
  try {
    input = await readJsonBody<Record<string, unknown>>(request, 16 * 1024);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "管理员注册链接请求过大"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const token = parseToken(input.token);
  if (!token) return jsonError("管理员注册链接无效或已过期", 400);

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!isUuid(rootTenantId)) return jsonError("root tenant 尚未配置", 503);

  const client = await authDatabase.connect();
  let invite: InviteRow | undefined;
  // Once Better Auth has been called, keep the database claim leased on any later failure. A
  // role update and the invite marker live in different stores; releasing the claim here could
  // let another account redeem the same token while the first account already has the role.
  let roleApplicationAttempted = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<InviteRow>(
      `SELECT invite.id::text AS "inviteId",
              invite.organization_id::text AS "organizationId",
              invite.role,
              invite.target_email AS "targetEmail",
              organization."tenantId" AS "tenantId",
              organization."rootPlatform" AS "rootPlatform",
              invite.claimed_by::text AS "claimedBy",
              invite.claim_expires_at AS "claimExpiresAt"
         FROM platform_admin_invites invite
         JOIN "organization" organization ON organization.id = invite.organization_id
        WHERE invite.token_hash = $1
          AND invite.used_at IS NULL
          AND invite.expires_at > clock_timestamp()
          AND organization."tenantId" = $2
        FOR UPDATE`,
      [sha256(token), rootTenantId],
    );
    invite = result.rows[0];
    if (!invite) {
      await client.query("ROLLBACK");
      return jsonError("管理员注册链接无效或已过期", 410);
    }
    if (
      invite.targetEmail &&
      invite.targetEmail.toLowerCase() !== session.user.email.toLowerCase()
    ) {
      await client.query("ROLLBACK");
      return jsonError("管理员邀请仅限指定邮箱注册", 403);
    }
    if (invite.role === "rootAdmin" && invite.rootPlatform !== true) {
      await client.query("ROLLBACK");
      return jsonError("根管理员邀请的目标组织无效", 409);
    }
    if (invite.role === "subplatform_admin" && invite.rootPlatform === true) {
      await client.query("ROLLBACK");
      return jsonError("子平台管理员邀请不能指向根组织", 409);
    }
    // A claim is an account binding, not a lease that another account may inherit. If the
    // process dies after Better Auth grants the role but before used_at is persisted, allowing
    // takeover after claim_expires_at would grant the same bearer invite to two accounts.
    // Known pre-application failures clear the claim below; an uncertain crash remains safely
    // retryable only by the same verified account.
    if (invite.claimedBy && invite.claimedBy !== session.user.id) {
      await client.query("ROLLBACK");
      return jsonError("管理员注册链接已绑定到其他账号", 409);
    }

    // Claim the invite in a short transaction before calling Better Auth. Better Auth owns the
    // user and organization records and uses its own adapter connection, so this durable account
    // binding prevents a crash between role application and used_at from allowing a different
    // account to reuse the token. The same user can safely retry because role application is
    // idempotent.
    const claimed = await client.query(
      `UPDATE platform_admin_invites
          SET claimed_by = $2::uuid,
              claimed_at = clock_timestamp(),
              claim_expires_at = clock_timestamp() + interval '10 minutes'
        WHERE id = $1::uuid
          AND used_at IS NULL
          AND (claimed_by IS NULL OR claimed_by = $2::uuid)`,
      [invite.inviteId, session.user.id],
    );
    if (claimed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return jsonError("管理员注册链接已被其他操作占用，请稍后重试", 409);
    }
    await client.query("COMMIT");

    roleApplicationAttempted = true;
    const applied = await applyPlatformAdminInviteRole({
      userId: session.user.id,
      organizationId: invite.organizationId,
      role: invite.role,
    });

    await client.query("BEGIN");
    const marked = await client.query(
      `UPDATE platform_admin_invites
          SET used_at = clock_timestamp(),
              used_by = $2::uuid,
              claimed_by = NULL,
              claimed_at = NULL,
              claim_expires_at = NULL
        WHERE id = $1::uuid
          AND used_at IS NULL
          AND claimed_by = $2::uuid`,
      [invite.inviteId, session.user.id],
    );
    if (marked.rowCount !== 1) {
      await client.query("ROLLBACK");
      throw new Error("管理员邀请认领状态已改变");
    }
    await client.query("COMMIT");
    return NextResponse.json(
      {
        redeemed: true,
        organizationId: invite.organizationId,
        role: applied.role,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (invite && !roleApplicationAttempted) {
      // Release a known pre-application failure immediately when possible. If cleanup cannot
      // finish, the account binding remains and the same user can retry without a replacement.
      await client
        .query("BEGIN")
        .then(async () => {
          await client.query(
            `UPDATE platform_admin_invites
              SET claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
            WHERE id = $1::uuid AND used_at IS NULL AND claimed_by = $2::uuid`,
            [invite?.inviteId, session.user.id],
          );
          await client.query("COMMIT");
        })
        .catch(async () => {
          await client.query("ROLLBACK").catch(() => undefined);
        });
    } else if (invite && roleApplicationAttempted) {
      // Keep the durable account binding. A retry by the same verified user can idempotently
      // apply the role again and mark the invite; a different account must not inherit a role
      // from a token whose cross-store completion is still uncertain.
      console.warn(
        "platform admin invite role applied; retaining account binding after completion failure",
        {
          inviteId: invite.inviteId,
          userId: session.user.id,
        },
      );
    }
    console.error("platform admin invite redemption failed", error);
    return jsonError("管理员邀请暂时无法兑换，请稍后重试", 503);
  } finally {
    client.release();
  }
}

interface InviteRow {
  inviteId: string;
  organizationId: string;
  role: "rootAdmin" | "subplatform_admin";
  targetEmail: string | null;
  tenantId: string;
  rootPlatform: boolean;
  claimedBy: string | null;
  claimExpiresAt: Date | string | null;
}

function parseToken(value: unknown): string | null {
  return typeof value === "string" && /^mpa_[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

