import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { verifyFederationEnrollment } from "../../../../../src/federation-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_ENROLLMENT_BODY_BYTES = 512 * 1024;

/**
 * Server-to-server enrollment endpoint. It intentionally has no browser/session auth: possession
 * of the one-time invite plus a valid node signature is the enrollment proof. A root admin still
 * has to activate the resulting pending binding before it enters the platform tree.
 */
export async function POST(request: Request): Promise<Response> {
  let body: EnrollmentBody;
  try {
    body = await parseBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "enrollment 请求体过大" }, { status: 413 });
    }
    body = {};
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 16 || token.length > 256) {
    return NextResponse.json({ error: "一次性 enrollment token 无效" }, { status: 400 });
  }
  const signedInput = body.enrollment && typeof body.enrollment === "object" && !Array.isArray(body.enrollment)
    ? body.enrollment
    : body;
  const verified = verifyFederationEnrollment(signedInput);
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 400 });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const invite = await client.query<InviteRow>(
      `SELECT id::text, tenant_id::text AS "tenantId", parent_organization_id::text AS "parentOrganizationId",
              domain_id::text AS "domainId", expires_at AS "expiresAt"
         FROM platform_federation_invites
        WHERE token_hash = decode($1, 'hex')
          AND used_at IS NULL
          AND expires_at > clock_timestamp()
        FOR UPDATE`,
      [tokenHash],
    );
    const invitation = invite.rows[0];
    if (!invitation) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "enrollment token 不存在、已使用或已过期" }, { status: 410 });
    }

    const duplicate = await client.query(
      `SELECT 1
         FROM platform_federation_bindings
        WHERE tenant_id = $1::uuid
          AND (node_id = $2::uuid OR slug = $3 OR mcp_server_key = $4)
        LIMIT 1`,
      [invitation.tenantId, verified.value.nodeId, verified.value.slug, verified.value.mcpServerKey],
    );
    if (duplicate.rowCount !== 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "nodeId、slug 或 mcpServerKey 已被当前平台占用" }, { status: 409 });
    }
    const binding = await client.query<BindingRow>(
      `INSERT INTO platform_federation_bindings
         (id, invite_id, tenant_id, domain_id, parent_organization_id, node_id, slug, display_name,
          endpoint, mcp_server_key, public_key, manifest, manifest_digest, signature, created_by)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
               $8, $9, $10, $11::jsonb, decode($12, 'hex'), $13, $14)
       RETURNING id::text`,
      [
        invitation.id,
        invitation.tenantId,
        invitation.domainId,
        invitation.parentOrganizationId,
        verified.value.nodeId,
        verified.value.slug,
        verified.value.displayName,
        verified.value.endpoint,
        verified.value.mcpServerKey,
        verified.value.publicKey,
        JSON.stringify(verified.value.manifest),
        verified.value.manifestDigest,
        verified.value.signature,
        `federation:${verified.value.nodeId}`,
      ],
    );
    await client.query(
      `UPDATE platform_federation_invites
          SET used_at = clock_timestamp(), used_by_node_id = $2::uuid
        WHERE id = $1::uuid`,
      [invitation.id, verified.value.nodeId],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      bindingId: binding.rows[0]?.id,
      status: "pending",
      tenantId: invitation.tenantId,
      domainId: invitation.domainId,
      parentOrganizationId: invitation.parentOrganizationId,
      slug: verified.value.slug,
      manifestDigest: verified.value.manifestDigest,
      next: "root_admin_must_activate_binding",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("federation enrollment failed", error);
    return NextResponse.json({ error: "联邦入驻保存失败" }, { status: 500 });
  } finally {
    client.release();
  }
}

interface EnrollmentBody {
  token?: unknown;
  enrollment?: unknown;
  protocol?: unknown;
  nodeId?: unknown;
  slug?: unknown;
  displayName?: unknown;
  endpoint?: unknown;
  mcpServerKey?: unknown;
  publicKey?: unknown;
  signature?: unknown;
  manifest?: unknown;
}

interface InviteRow {
  id: string;
  tenantId: string;
  parentOrganizationId: string;
  domainId: string;
  expiresAt: string;
}

interface BindingRow {
  id: string;
}

async function parseBody(request: Request): Promise<EnrollmentBody> {
  try {
    const value = await readJsonBody<unknown>(request, MAX_ENROLLMENT_BODY_BYTES);
    return value && typeof value === "object" && !Array.isArray(value) ? value as EnrollmentBody : {};
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return {};
  }
}
