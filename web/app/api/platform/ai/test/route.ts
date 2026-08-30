import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import {
  readOptionalJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedCookieOrigin } from "../../../../../src/lib/request-origin";
import {
  getPlatformRouterEffectiveStatus,
  managedPlatformRouterStateFromTransactionalState,
  markTransactionalManagedPlatformRouterDraftTested,
  platformRouterPolicyIssues,
  prepareTransactionalManagedPlatformRouterDraftProbe,
  type PlatformRouterDraftProbe,
} from "../../../../../src/lib/platform-router-config";
import {
  probePlatformRouter,
  type PlatformRouterProbeConfiguration,
} from "../../../../../src/platform-router";
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

/** Run a bounded server-side probe without returning credentials or provider response bodies. */
export async function POST(request: Request): Promise<Response> {
  const requestId = safeRequestId(request.headers.get("x-request-id"));
  const authorized = await authorize(request, requestId);
  if (authorized instanceof Response) return authorized;
  const candidate = await candidateRequested(request, requestId);
  if (candidate instanceof Response) return candidate;
  if (candidate && authorized.role !== "rootSuperAdmin")
    return response(
      { error: "只有超级管理员可以测试待测 AI 配置", requestId },
      403,
    );

  if (!candidate) return activeProbe(request, requestId);

  let prepared: PlatformRouterDraftProbe;
  try {
    prepared = prepareTransactionalManagedPlatformRouterDraftProbe();
  } catch (cause) {
    return platformRouterMutationErrorResponse(
      cause,
      "precondition",
      requestId,
    );
  }

  const issues = platformRouterPolicyIssues(prepared.draft);
  if (issues.length)
    return blocked(
      "待测配置不符合 M0 AI 生效要求",
      requestId,
      issues,
    );

  let probe: Awaited<ReturnType<typeof probePlatformRouter>>;
  try {
    probe = await probePlatformRouter({
      requestId,
      signal: request.signal,
      configuration: configurationForDraft(prepared.secret),
    });
  } catch (cause) {
    return platformRouterMutationErrorResponse(
      cause,
      "precondition",
      requestId,
    );
  }

  if (probe.status !== "ready") {
    return response(
      {
        ...probe,
        requestId,
        code: "upstream_configuration",
        preferredHttpStatus: 451,
      },
      451,
    );
  }

  try {
    const mutation = await markTransactionalManagedPlatformRouterDraftTested({
      actor: authorized.id,
      requestId,
      expectedGenerationId: prepared.expectedGenerationId,
      expectedDraftDigest: prepared.expectedDraftDigest,
      status: "ready",
    });
    return committedMutationResponse(
      {
        ...probe,
        ...managedPlatformRouterStateFromTransactionalState(mutation.state),
      },
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

async function activeProbe(
  request: Request,
  requestId: string,
): Promise<Response> {
  const effective = getPlatformRouterEffectiveStatus();
  if (!effective.ready)
    return blocked(
      "当前生效配置不符合 M0 AI 要求",
      requestId,
      effective.issues,
    );
  try {
    const probe = await probePlatformRouter({
      requestId,
      signal: request.signal,
    });
    const ready = probe.status === "ready" || probe.status === "slow";
    return response(
      {
        ...probe,
        requestId,
        ...(ready
          ? {}
          : {
              code: "upstream_configuration",
              preferredHttpStatus: 451,
            }),
      },
      ready ? 200 : 451,
    );
  } catch (cause) {
    return platformRouterMutationErrorResponse(
      cause,
      "precondition",
      requestId,
    );
  }
}

async function authorize(
  request: Request,
  requestId: string,
): Promise<AuthorizedAdmin | Response> {
  if (!hasTrustedCookieOrigin(request))
    return response({ error: "请求来源未被平台信任", requestId }, 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return response(
      { error: "Better Auth session is required", requestId },
      401,
    );
  const user = session.user as { id?: string; role?: string | null };
  if (user.role !== "rootSuperAdmin" && user.role !== "rootAdmin")
    return response(
      { error: "只有根平台管理员可以测试托管 AI", requestId },
      403,
    );
  return { id: String(user.id ?? "unknown"), role: user.role };
}

async function candidateRequested(
  request: Request,
  requestId: string,
): Promise<boolean | Response> {
  try {
    const value = await readOptionalJsonBody<unknown>(request, 4 * 1024);
    if (value === undefined) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return response({ error: "AI 测试请求必须是对象", requestId }, 400);
    }
    const body = value as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length === 0) return false;
    if (keys.length === 1 && body.candidate === false) return false;
    if (keys.length === 1 && body.candidate === true) return true;
    return response({ error: "AI 测试请求字段无效", requestId }, 400);
  } catch (cause) {
    const tooLarge = cause instanceof RequestBodyTooLargeError;
    return response(
      {
        error: tooLarge ? "AI 测试请求过大" : "AI 测试请求必须是有效 JSON",
        requestId,
      },
      tooLarge ? 413 : 400,
    );
  }
}

function configurationForDraft(
  draft: PlatformRouterDraftProbe["secret"],
): PlatformRouterProbeConfiguration {
  return {
    endpoint: draft.endpoint,
    apiKey: draft.apiKey,
    model: draft.model,
    protocol: draft.protocol,
    managed: true,
    assistantInstructions: draft.assistantInstructions,
    assistantMaxOutputTokens: draft.assistantMaxOutputTokens,
    assistantTemperature: draft.assistantTemperature,
    assistantMaxSteps: draft.assistantMaxSteps,
    assistantTimeoutMs: draft.assistantTimeoutMs,
    assistantReasoningEffort: draft.assistantReasoningEffort,
  };
}

function blocked(
  message: string,
  requestId: string,
  issues: string[],
): Response {
  return response(
    {
      status: "unconfigured",
      outcome: "configuration_mismatch",
      phase: "configuration",
      message,
      code: "upstream_configuration",
      preferredHttpStatus: 451,
      issues,
      requestId,
    },
    451,
  );
}

function safeRequestId(value: string | null): string {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:-]{1,128}$/.test(normalized)
    ? normalized
    : randomUUID();
}

function response(body: unknown, status: number): Response {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
