import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  appendPlatformRouterAudit,
  getManagedPlatformRouterDraftConfig,
  getPlatformRouterEffectiveStatus,
  markManagedPlatformRouterDraftTested,
  platformRouterPolicyIssues,
  readManagedPlatformRouterDraftConfig,
  type ManagedPlatformRouterDraftConfig,
} from "../../../../../src/lib/platform-router-config";
import {
  probePlatformRouter,
  type PlatformRouterProbeConfiguration,
} from "../../../../../src/platform-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AuthorizedAdmin {
  id: string;
  role: "rootSuperAdmin" | "rootAdmin";
}

type DraftSecret = NonNullable<
  ReturnType<typeof readManagedPlatformRouterDraftConfig>
>;

/** Run a bounded server-side probe without returning credentials or provider response bodies. */
export async function POST(request: Request): Promise<Response> {
  const authorized = await authorize(request);
  if (authorized instanceof Response) return authorized;
  const candidate = await candidateRequested(request);
  if (candidate && authorized.role !== "rootSuperAdmin")
    return response({ error: "只有超级管理员可以测试待测 AI 配置" }, 403);

  const requestId = safeRequestId(request.headers.get("x-request-id"));
  const prepared = prepareProbe(candidate, requestId);
  if (prepared instanceof Response) return prepared;
  const probe = await probePlatformRouter({
    requestId,
    signal: request.signal,
    ...(prepared.secret
      ? { configuration: configurationForDraft(prepared.secret) }
      : {}),
  });

  const recordingFailure = recordCandidateProbe(
    prepared.draft,
    probe.status,
    requestId,
    authorized.id,
  );
  if (recordingFailure) return recordingFailure;

  const ready =
    probe.status === "ready" || (!candidate && probe.status === "slow");
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
}

async function authorize(
  request: Request,
): Promise<AuthorizedAdmin | Response> {
  if (!hasTrustedBrowserOrigin(request))
    return response({ error: "请求来源未被平台信任" }, 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return response({ error: "Better Auth session is required" }, 401);
  const user = session.user as { id?: string; role?: string | null };
  if (user.role !== "rootSuperAdmin" && user.role !== "rootAdmin")
    return response({ error: "只有根平台管理员可以测试托管 AI" }, 403);
  return { id: String(user.id ?? "unknown"), role: user.role };
}

async function candidateRequested(request: Request): Promise<boolean> {
  try {
    const body = (await request.json()) as { candidate?: unknown };
    return body?.candidate === true;
  } catch {
    return false;
  }
}

function prepareProbe(
  candidate: boolean,
  requestId: string,
):
  | {
      secret: DraftSecret | null;
      draft: ManagedPlatformRouterDraftConfig | null;
    }
  | Response {
  if (!candidate) {
    const effective = getPlatformRouterEffectiveStatus();
    return effective.ready
      ? { secret: null, draft: null }
      : blocked("当前生效配置不符合 M0 AI 要求", requestId, effective.issues);
  }

  const secret = readManagedPlatformRouterDraftConfig();
  const draft = getManagedPlatformRouterDraftConfig();
  if (!secret || !draft)
    return blocked("没有可测试的 AI 待测配置", requestId, [
      "candidate_not_configured",
    ]);
  const issues = platformRouterPolicyIssues(draft);
  return issues.length
    ? blocked("待测配置不符合 M0 AI 生效要求", requestId, issues)
    : { secret, draft };
}

function configurationForDraft(
  draft: DraftSecret,
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

function recordCandidateProbe(
  draft: ManagedPlatformRouterDraftConfig | null,
  probeStatus: string,
  requestId: string,
  actor: string,
): Response | null {
  if (!draft) return null;
  try {
    if (probeStatus === "ready")
      markManagedPlatformRouterDraftTested(requestId);
    appendPlatformRouterAudit({
      action: "test",
      actor,
      requestId,
      endpoint: draft.endpoint,
      model: draft.model,
      enabled: draft.enabled,
      keyChanged: draft.keyChanged,
    });
    return null;
  } catch {
    return response({ error: "AI 测试状态无法安全记录", requestId }, 500);
  }
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
