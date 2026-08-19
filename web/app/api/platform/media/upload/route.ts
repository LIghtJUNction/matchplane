import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { executeAuthenticatedChildTool } from "../../../../../src/platform-child-tool";
import { isMountedPlatformPath, readActivePlatformScope } from "../../../../../src/platform-mount";
import { isProductionEnvironment } from "../../../../../src/lib/runtime";
import {
  DEFAULT_MAX_MEDIA_BYTES,
  MAX_MEDIA_BYTES,
  extractMcpMediaUploadResult,
  parseMediaUploadRequest,
  parseMediaUploadResponse,
} from "../../../../../src/media-attachment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser/Agent facade for a child-owned media adapter. The root validates the bounded envelope
 * and forwards bytes transiently; it never stores, scans, indexes, or serves the raw file.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);

  const maximumBytes = configuredMaximumBytes();
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, jsonBodyLimit(maximumBytes));
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "附件请求超过当前部署的大小上限" : "附件请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const parsed = parseMediaUploadRequest(body, maximumBytes);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const input = parsed.value;

  if (!(await isMountedPlatformPath(input.scope.platform_path))) return jsonError("当前平台路径尚未激活", 404);

  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    const scope = await readActivePlatformScope(input.scope.platform_path);
    if (isProductionEnvironment() && (!scope || scope.tenantId !== input.scope.tenant_id || scope.domainId !== input.scope.domain_id)) {
      return jsonError("附件作用域与 active 子平台不匹配", 403);
    }
    if (scope) {
      const member = await authDatabase.query(
        `SELECT 1 FROM "member"
          WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
          LIMIT 1`,
        [scope.organizationId, session.user.id],
      );
      if (member.rowCount !== 1) return jsonError("请先加入当前子平台", 403);
    }
  } else if (!request.headers.get("x-matchplane-api-key") && !request.headers.get("x-api-key")) {
    return jsonError("Better Auth session or media API key is required", 401);
  }

  const execution = await executeAuthenticatedChildTool({
    request,
    platformPath: input.scope.platform_path,
    toolName: "media.upload",
    arguments: input as unknown as Record<string, unknown>,
    requestId: input.request_id,
    permissions: { media: ["upload"] },
    tenantId: input.scope.tenant_id,
    domainId: input.scope.domain_id,
    allowSession: Boolean(session),
  });
  if (!execution.ok) return jsonError(readError(execution.payload) ?? "子平台媒体适配器暂时不可用", execution.status >= 400 ? execution.status : 502);

  const extracted = extractMcpMediaUploadResult(execution.payload);
  if (!extracted.ok) return jsonError(extracted.error, 502);
  const response = parseMediaUploadResponse(extracted.value, input.request_id, maximumBytes);
  if (!response.ok) return jsonError(response.error, 502);
  return NextResponse.json(response.value, {
    headers: { "cache-control": "no-store" },
  });
}

function configuredMaximumBytes(): number {
  const raw = process.env.MATCHPLANE_MEDIA_MAX_BYTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_MEDIA_BYTES;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_MAX_MEDIA_BYTES;
  return Math.min(parsed, MAX_MEDIA_BYTES);
}

function jsonBodyLimit(maximumBytes: number): number {
  // Base64 adds up to one third overhead; the envelope contributes a bounded amount of metadata.
  return Math.ceil(maximumBytes * 4 / 3) + 128 * 1024;
}

function readError(payload: Record<string, unknown>): string | null {
  return typeof payload.error === "string" && payload.error.length <= 500 ? payload.error : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
