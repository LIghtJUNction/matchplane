import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);
  const result = await authDatabase.query<LegalRow>(
    `SELECT tenant.name AS "mallName", document.kind, document.content, document.version::text AS version,
            document.updated_at AS "updatedAt"
       FROM tenants tenant
       JOIN mall_legal_documents document ON document.tenant_id = tenant.id
      WHERE tenant.id = $1::uuid AND tenant.status = 'active'
      ORDER BY document.kind`,
    [tenantId],
  );
  const documents = mapDocuments(result.rows);
  if (!documents) return jsonError("商城法律页面尚未初始化", 503);
  return NextResponse.json({
    mallName: result.rows[0]?.mallName ?? "商城",
    documents,
  }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  if ((session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return jsonError("只有商城负责人可以修改法律页面", 403);
  }
  let input: LegalUpdateInput;
  try {
    input = await readJsonBody(request, 256 * 1024) as LegalUpdateInput;
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "法律页面内容不能超过 100000 个字符" : "请求必须是有效 JSON", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const termsContent = normalizedContent(input.termsContent);
  const privacyContent = normalizedContent(input.privacyContent);
  const termsVersion = positiveInteger(input.termsVersion);
  const privacyVersion = positiveInteger(input.privacyVersion);
  if (!termsContent || !privacyContent || !termsVersion || !privacyVersion) {
    return jsonError("请填写完整的用户协议、隐私政策及版本", 400);
  }
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const existing = await client.query<LegalRow>(
      `SELECT tenant.name AS "mallName", document.kind, document.content, document.version::text AS version,
              document.updated_at AS "updatedAt"
         FROM tenants tenant
         JOIN mall_legal_documents document ON document.tenant_id = tenant.id
        WHERE tenant.id = $1::uuid AND tenant.status = 'active'
        FOR UPDATE`,
      [tenantId],
    );
    const current = mapDocuments(existing.rows);
    if (!current) {
      await client.query("ROLLBACK");
      return jsonError("商城法律页面尚未初始化", 409);
    }
    if (current.terms.version !== termsVersion || current.privacy.version !== privacyVersion) {
      await client.query("ROLLBACK");
      return jsonError("法律页面已被其他人更新，请刷新后重试", 409);
    }
    const terms = await updateDocument(client, tenantId, "terms", termsContent, session.user.id);
    const privacy = await updateDocument(client, tenantId, "privacy", privacyContent, session.user.id);
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, '/', $3::uuid, 'mall.legal.updated', 'success', $4::jsonb)`,
      [randomUUID(), tenantId, session.user.id, JSON.stringify({ terms_version: terms.version, privacy_version: privacy.version })],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      mallName: existing.rows[0]?.mallName ?? "商城",
      documents: { terms, privacy },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("mall legal update failed", error);
    return jsonError("法律页面保存失败", 500);
  } finally {
    client?.release();
  }
}

interface LegalUpdateInput {
  termsContent?: unknown;
  privacyContent?: unknown;
  termsVersion?: unknown;
  privacyVersion?: unknown;
}

interface LegalRow {
  mallName: string;
  kind: "terms" | "privacy";
  content: string;
  version: string;
  updatedAt: string;
}

interface LegalDocument {
  content: string;
  version: number;
  updatedAt: string;
}

function mapDocuments(rows: LegalRow[]): { terms: LegalDocument; privacy: LegalDocument } | null {
  const terms = rows.find((row) => row.kind === "terms");
  const privacy = rows.find((row) => row.kind === "privacy");
  if (!terms || !privacy) return null;
  return {
    terms: { content: terms.content, version: Number(terms.version), updatedAt: terms.updatedAt },
    privacy: { content: privacy.content, version: Number(privacy.version), updatedAt: privacy.updatedAt },
  };
}

async function updateDocument(client: PoolClient, tenantId: string, kind: "terms" | "privacy", content: string, userId: string): Promise<LegalDocument> {
  const updated = await client.query<LegalRow>(
    `UPDATE mall_legal_documents
        SET content = $3, version = version + 1, updated_by = $4::uuid, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND kind = $2
      RETURNING '' AS "mallName", kind, content, version::text AS version, updated_at AS "updatedAt"`,
    [tenantId, kind, content, userId],
  );
  const row = updated.rows[0];
  if (!row) throw new Error("legal document disappeared during update");
  return { content: row.content, version: Number(row.version), updatedAt: row.updatedAt };
}

function normalizedContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const content = value.trim();
  return content.length >= 1 && content.length <= 100000 ? content : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function configuredTenantId(): string | null {
  // Bracket access keeps this deployment-owned value runtime-bound in Next's production bundle.
  // A direct member read may be substituted during build for newly introduced route chunks.
  const value = process.env["MATCHPLANE_ROOT_TENANT_ID"]?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value) ? value : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
