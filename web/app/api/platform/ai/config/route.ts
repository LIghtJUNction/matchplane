import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedCookieOrigin } from "../../../../../src/lib/request-origin";
import {
  activateTransactionalManagedPlatformRouterDraft,
  getManagedPlatformRouterState,
  managedPlatformRouterStateFromTransactionalState,
  stageTransactionalManagedPlatformRouterConfig,
  type ManagedRouterProtocol,
} from "../../../../../src/lib/platform-router-config";
import {
  committedMutationResponse,
  platformRouterMutationErrorResponse,
} from "../mutation-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AuthorizedAdmin {
  id: string;
  role: "rootSuperAdmin" | "rootAdmin";
}

export async function GET(request: Request): Promise<Response> {
  const requestId = safeRequestId(request.headers.get("x-request-id"));
  const guard = await requireAdmin(request, false, requestId);
  if (guard instanceof Response) return guard;
  return NextResponse.json(
    { ...getManagedPlatformRouterState(), requestId },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(request: Request): Promise<Response> {
  const requestId = safeRequestId(request.headers.get("x-request-id"));
  const guard = await requireAdmin(request, true, requestId);
  if (guard instanceof Response) return guard;
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return error("AI 配置必须是对象", 400, requestId);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "AI 配置请求过大"
        : "AI 配置必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
      requestId,
    );
  }

  if (body.action === "activate") {
    try {
      const mutation = await activateTransactionalManagedPlatformRouterDraft({
        actor: guard.id,
        requestId,
      });
      return committedMutationResponse(
        managedPlatformRouterStateFromTransactionalState(mutation.state),
        mutation,
        requestId,
      );
    } catch (cause) {
      return platformRouterMutationErrorResponse(
        cause,
        "precondition",
        requestId,
      );
    }
  }

  try {
    const mutation = await stageTransactionalManagedPlatformRouterConfig(
      {
        endpoint: text(body.endpoint),
        model: text(body.model),
        protocol: body.protocol as ManagedRouterProtocol,
        enabled: body.enabled === true,
        apiKey: optionalText(body.apiKey),
        assistantInstructions: optionalText(body.assistantInstructions),
        assistantMaxOutputTokens: numberValue(body.assistantMaxOutputTokens),
        assistantTemperature: numberValue(body.assistantTemperature),
        assistantMaxSteps: numberValue(body.assistantMaxSteps),
        assistantTimeoutMs: numberValue(body.assistantTimeoutMs),
        assistantReasoningEffort: optionalText(body.assistantReasoningEffort),
        modelReasoningEfforts: Array.isArray(body.modelReasoningEfforts)
          ? body.modelReasoningEfforts
          : undefined,
      },
      { actor: guard.id, requestId },
    );
    return committedMutationResponse(
      managedPlatformRouterStateFromTransactionalState(mutation.state),
      mutation,
      requestId,
    );
  } catch (cause) {
    return platformRouterMutationErrorResponse(cause, "stage", requestId);
  }
}

async function requireAdmin(
  request: Request,
  write: boolean,
  requestId: string,
): Promise<AuthorizedAdmin | Response> {
  if (!hasTrustedCookieOrigin(request))
    return error("请求来源未被平台信任", 403, requestId);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401, requestId);
  const role = (session.user as { role?: string | null }).role;
  if (role !== "rootSuperAdmin" && (write || role !== "rootAdmin"))
    return error(
      write
        ? "只有超级管理员可以保存 AI 配置"
        : "只有根平台管理员可以查看 AI 配置",
      403,
      requestId,
    );
  return {
    id: String((session.user as { id?: string }).id ?? "unknown"),
    role,
  };
}

function safeRequestId(value: string | null): string {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:-]{1,128}$/.test(normalized)
    ? normalized
    : randomUUID();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function error(message: string, status: number, requestId?: string): Response {
  return NextResponse.json(
    { error: message, ...(requestId ? { requestId } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}
