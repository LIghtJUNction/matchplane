import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { readJsonBody } from "../../../../src/lib/body-limit";
import { jsonError } from "../../../../src/lib/json-error";
import { requireRootManager } from "../../../../src/lib/session";
import { configuredTenantId } from "../../../../src/lib/store-access";
import { isUuid } from "../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Root-domain control plane. Domains are platform scopes, not marketplace records; keeping their
 * lifecycle here lets a first-run deployment add a child mount without rerunning the CLI.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireRootManager(request, "只有根平台管理员可以管理 domain");
  if (guard) return guard;
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("根平台 tenant 尚未配置", 503);
  const result = await authDatabase.query<DomainRow>(
    `SELECT id::text, slug, name, status, version, created_at, updated_at
       FROM domains
      WHERE tenant_id = $1::uuid
      ORDER BY slug ASC`,
    [tenantId],
  );
  return NextResponse.json({ domains: result.rows }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const guard = await requireRootManager(request, "只有根平台管理员可以管理 domain");
  if (guard) return guard;
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("根平台 tenant 尚未配置", 503);
  const input = await parseJson(request);
  const slug = normalizeSlug(input.slug);
  const name = normalizeName(input.name);
  if (!slug) return jsonError("slug 只能使用小写字母、数字和短横线，长度为 2..63", 400);
  if (!name) return jsonError("name 必须为 1..200 个字符", 400);
  const domainId = typeof input.id === "string" && isUuid(input.id) ? input.id : randomUUID();
  try {
    const result = await authDatabase.query<DomainRow>(
      `INSERT INTO domains (id, tenant_id, slug, name)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       RETURNING id::text, slug, name, status, version, created_at, updated_at`,
      [domainId, tenantId, slug, name],
    );
    return NextResponse.json({ domain: result.rows[0] }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isUniqueViolation(error)) return jsonError("该 domain slug 已存在，不能覆盖现有平台范围", 409);
    console.error("platform domain creation failed", error);
    return jsonError("domain 创建失败", 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireRootManager(request, "只有根平台管理员可以管理 domain");
  if (guard) return guard;
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("根平台 tenant 尚未配置", 503);
  const input = await parseJson(request);
  if (typeof input.id !== "string" || !isUuid(input.id)) return jsonError("id 必须是 UUID", 400);
  const status = input.status === "active" || input.status === "disabled" ? input.status : undefined;
  const name = input.name === undefined ? undefined : normalizeName(input.name);
  if (input.name !== undefined && !name) return jsonError("name 必须为 1..200 个字符", 400);
  if (!status && !name) return jsonError("至少提供 status 或 name", 400);
  const result = await authDatabase.query<DomainRow>(
    `UPDATE domains
        SET name = COALESCE($3, name),
            status = COALESCE($4, status),
            version = version + 1,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id::text, slug, name, status, version, created_at, updated_at`,
    [tenantId, input.id, name ?? null, status ?? null],
  );
  if (result.rowCount !== 1) return jsonError("domain 不存在", 404);
  return NextResponse.json({ domain: result.rows[0] }, { headers: { "cache-control": "no-store" } });
}

interface DomainRow {
  id: string;
  slug: string;
  name: string;
  status: "active" | "disabled";
  version: number;
  created_at: string;
  updated_at: string;
}



async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(normalized) ? normalized : null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 200 ? normalized : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

