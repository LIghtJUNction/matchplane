import { NextResponse } from "next/server";

import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { executeAuthenticatedChildTool } from "../../../../../src/platform-child-tool";
import {
  extractMcpRetrievalResult,
  parseRetrievalQuery,
  parseRetrievalResult,
  RETRIEVAL_PROTOCOL,
  type RetrievalQuery,
  type RetrievalResult,
} from "../../../../../src/retrieval-protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Root-owned authorization facade for the subplatform retrieval ABI.
 *
 * The root does not embed a vector database or interpret domain attributes. It verifies the
 * recursive path and tenant/domain scope, then forwards the exact versioned envelope to the
 * operator-configured child MCP server.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);

  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, 128 * 1024);
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "检索请求不能超过 128 KiB" : "检索请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }

  const parsed = parseRetrievalQuery(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  if (parsed.value.platformPath === "/") return jsonError("根平台没有自有检索索引，请指定已激活的子平台路径", 400);

  const query = parsed.value;
  const execution = await executeAuthenticatedChildTool({
    request,
    platformPath: query.platformPath,
    toolName: "retrieval.query",
    arguments: toWireQuery(query),
    requestId: query.requestId,
    permissions: { retrieval: ["query"] },
    tenantId: query.tenantId,
    domainId: query.domainId,
    allowSession: true,
  });
  if (!execution.ok) {
    const status = execution.status >= 400 ? execution.status : 502;
    return jsonError(readError(execution.payload) ?? "子平台检索暂时不可用", status);
  }

  const extracted = extractMcpRetrievalResult(execution.payload);
  if (!extracted.ok) return jsonError(extracted.error, 502);
  const result = parseRetrievalResult(extracted.value, query.requestId, query.limit);
  if (!result.ok) return jsonError(result.error, 502);
  return NextResponse.json(toWireResult(result.value), {
    headers: {
      "cache-control": "no-store",
      "x-matchplane-platform-path": query.platformPath,
    },
  });
}

function toWireQuery(query: RetrievalQuery): Record<string, unknown> {
  return {
    protocol: RETRIEVAL_PROTOCOL,
    request_id: query.requestId,
    scope: {
      tenant_id: query.tenantId,
      domain_id: query.domainId,
      platform_path: query.platformPath,
    },
    input: {
      narrative: query.input.narrative,
      requirements: query.input.requirements,
      ...(query.input.budgetMin === undefined ? {} : { budget_min: query.input.budgetMin }),
      ...(query.input.budgetMax === undefined ? {} : { budget_max: query.input.budgetMax }),
      ...(query.input.currency === undefined ? {} : { currency: query.input.currency }),
      ...(query.input.currencyScale === undefined ? {} : { currency_scale: query.input.currencyScale }),
    },
    limit: query.limit,
    ...(query.traceId === undefined ? {} : { trace_id: query.traceId }),
  };
}

function toWireResult(result: RetrievalResult): Record<string, unknown> {
  return {
    protocol: RETRIEVAL_PROTOCOL,
    request_id: result.requestId,
    provider: {
      id: result.provider.id,
      version: result.provider.version,
      ...(result.provider.model === undefined ? {} : { model: result.provider.model }),
    },
    candidates: result.candidates.map((candidate) => ({
      asset_id: candidate.assetId,
      ...(candidate.offerId === undefined ? {} : { offer_id: candidate.offerId }),
      ...(candidate.displayName === undefined ? {} : { display_name: candidate.displayName }),
      ...(candidate.attributes === undefined ? {} : { attributes: candidate.attributes }),
      ...(candidate.terms === undefined ? {} : { terms: candidate.terms }),
      score: candidate.score,
      reasons: candidate.reasons,
      ...(candidate.risks === undefined ? {} : { risks: candidate.risks }),
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    })),
    degraded: result.degraded,
    ...(result.generatedAt === undefined ? {} : { generated_at: result.generatedAt }),
  };
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
