import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { readActiveDirectChildRoutes } from "../../../../../src/platform-child-routes";
import {
  isMountedPlatformPath,
  isPlatformPathAccessibleByOrganization,
} from "../../../../../src/platform-mount";
import { authenticatePlatformRequest } from "../../../../../src/platform-request-auth";
import {
  parseAgentHandoff,
  type AgentHandoffEnvelope,
} from "../../../../../src/platform-agent-handoff";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { requestSearchParams } from "../../../../../src/lib/request-url";
import { isActivePlatformPathVisible } from "../../../../../src/platform-visibility";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { isUuid } from "../../../../../src/lib/uuid";

export const runtime = "nodejs";

const HANDOFF_TTL_MINUTES = 15;

/**
 * Accept a caller-funded Agent handoff without invoking the platform model.
 * This is intentionally a protocol boundary: the caller owns its provider
 * credentials and token bill, while MatchPlane returns only active direct-child
 * capabilities that the caller is authorized to continue with.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { error: "请求来源未被平台信任" },
      { status: 403 },
    );
  }
  const actor = await authenticatePlatformRequest(request, {
    agent: ["handoff"],
  });
  if (!actor)
    return NextResponse.json(
      { error: "Better Auth session or agent API key is required" },
      { status: 401 },
    );

  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, 128 * 1024);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "Agent handoff 请求过大"
            : "请求必须是有效 JSON",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const parsed = parseAgentHandoff(body);
  if (!parsed.ok)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const handoff = parsed.value;

  if (!(await isMountedPlatformPath(handoff.platformPath))) {
    return NextResponse.json({ error: "平台路径尚未激活" }, { status: 404 });
  }
  if (
    actor.organizationId &&
    !(await isPlatformPathAccessibleByOrganization(
      handoff.platformPath,
      actor.organizationId,
    ))
  ) {
    return NextResponse.json(
      { error: "API key 不能访问该平台节点" },
      { status: 403 },
    );
  }

  const viewer = {
    authUserId: actor.access === "session" ? actor.subject : null,
    organizationId: actor.organizationId,
    isRootAdministrator: actor.isRootAdministrator,
  };
  if (!(await isActivePlatformPathVisible(handoff.platformPath, viewer))) {
    return NextResponse.json(
      { error: "当前平台节点不对该身份开放" },
      { status: 404 },
    );
  }

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  const children =
    rootTenantId && isUuid(rootTenantId)
      ? await readActiveDirectChildRoutes(
          handoff.platformPath,
          rootTenantId,
          viewer,
        )
      : [];
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MINUTES * 60 * 1000);
  const inserted = await authDatabase.query(
    `INSERT INTO platform_agent_handoffs
      (request_id, auth_subject, organization_id, platform_path, stage,
       narrative, requirements, agent, budget, selected_refs, status, expires_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb,
             $9::jsonb, $10::jsonb, 'accepted', $11)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING request_id AS "requestId", status, expires_at AS "expiresAt"`,
    [
      handoff.requestId,
      actor.subject,
      actor.organizationId,
      handoff.platformPath,
      handoff.stage,
      handoff.narrative,
      JSON.stringify(handoff.requirements),
      JSON.stringify(handoff.agent),
      JSON.stringify(handoff.budget),
      JSON.stringify(handoff.selectedRefs),
      expiresAt,
    ],
  );

  if (inserted.rowCount !== 1) {
    const existing = await authDatabase.query(
      `SELECT request_id AS "requestId", auth_subject AS "authSubject",
              status, expires_at AS "expiresAt",
              organization_id IS NOT DISTINCT FROM $2::uuid AS "sameOrganization",
              platform_path = $3 AS "samePlatformPath",
              stage = $4 AS "sameStage",
              narrative = $5 AS "sameNarrative",
              requirements = $6::jsonb AS "sameRequirements",
              agent = $7::jsonb AS "sameAgent",
              budget = $8::jsonb AS "sameBudget",
              selected_refs = $9::jsonb AS "sameSelectedRefs"
         FROM platform_agent_handoffs
        WHERE request_id = $1::uuid
        LIMIT 1`,
      [
        handoff.requestId,
        actor.organizationId,
        handoff.platformPath,
        handoff.stage,
        handoff.narrative,
        JSON.stringify(handoff.requirements),
        JSON.stringify(handoff.agent),
        JSON.stringify(handoff.budget),
        JSON.stringify(handoff.selectedRefs),
      ],
    );
    const row = existing.rows[0] as
      | {
          requestId?: string;
          authSubject?: string;
          status?: string;
          expiresAt?: string;
          sameOrganization?: boolean;
          samePlatformPath?: boolean;
          sameStage?: boolean;
          sameNarrative?: boolean;
          sameRequirements?: boolean;
          sameAgent?: boolean;
          sameBudget?: boolean;
          sameSelectedRefs?: boolean;
        }
      | undefined;
    if (!row || row.authSubject !== actor.subject) {
      return NextResponse.json(
        { error: "request_id 已被其他 Agent 使用" },
        { status: 409 },
      );
    }
    if (row.samePlatformPath !== true || row.sameStage !== true) {
      return NextResponse.json(
        { error: "同一 request_id 不能改变 handoff 范围" },
        { status: 409 },
      );
    }
    if (
      row.sameOrganization !== true ||
      row.sameNarrative !== true ||
      row.sameRequirements !== true ||
      row.sameAgent !== true ||
      row.sameBudget !== true ||
      row.sameSelectedRefs !== true
    ) {
      return NextResponse.json(
        { error: "同一 request_id 不能改变 handoff payload" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      handoffResponse(
        handoff,
        children,
        row.status ?? "accepted",
        row.expiresAt ?? expiresAt.toISOString(),
      ),
      {
        headers: {
          "cache-control": "no-store",
          "x-matchplane-idempotent": "true",
        },
      },
    );
  }

  return NextResponse.json(
    handoffResponse(handoff, children, "accepted", expiresAt.toISOString()),
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

/** Read back a handoff owned by the same session or API key. */
export async function GET(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json(
      { error: "请求来源未被平台信任" },
      { status: 403 },
    );
  }
  const actor = await authenticatePlatformRequest(request, {
    agent: ["handoff"],
  });
  if (!actor)
    return NextResponse.json(
      { error: "Better Auth session or agent API key is required" },
      { status: 401 },
    );
  const requestId = requestSearchParams(request).get("request_id");
  if (!isUuid(requestId))
    return NextResponse.json(
      { error: "request_id must be a UUID" },
      { status: 400 },
    );

  const result = await authDatabase.query(
    `SELECT request_id AS "requestId", auth_subject AS "authSubject",
            platform_path AS "platformPath", stage, status,
            expires_at AS "expiresAt", created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM platform_agent_handoffs
      WHERE request_id = $1::uuid
      LIMIT 1`,
    [requestId],
  );
  const row = result.rows[0] as
    | {
        requestId?: string;
        authSubject?: string;
        platformPath?: string;
        stage?: string;
        status?: string;
        expiresAt?: string;
        createdAt?: string;
        updatedAt?: string;
      }
    | undefined;
  if (!row || row.authSubject !== actor.subject)
    return NextResponse.json({ error: "handoff not found" }, { status: 404 });
  if (
    row.platformPath &&
    actor.organizationId &&
    !(await isPlatformPathAccessibleByOrganization(
      row.platformPath,
      actor.organizationId,
    ))
  ) {
    return NextResponse.json(
      { error: "API key 不能访问该平台节点" },
      { status: 403 },
    );
  }
  return NextResponse.json(
    {
      protocol: "matchplane.agent/v1",
      requestId: row.requestId,
      platformPath: row.platformPath,
      stage: row.stage,
      status: row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function handoffResponse(
  handoff: AgentHandoffEnvelope,
  children: Awaited<ReturnType<typeof readActiveDirectChildRoutes>>,
  status: string,
  expiresAt: string,
): Record<string, unknown> {
  return {
    protocol: "matchplane.agent/v1",
    requestId: handoff.requestId,
    stage: handoff.stage,
    status,
    costBearer: "caller",
    platformPath: handoff.platformPath,
    expiresAt,
    budget: handoff.budget,
    next: {
      mcpPath: "/api/mcp",
      manifestPath: `/api/platform/manifest?path=${encodeURIComponent(handoff.platformPath)}`,
      directChildren: children.map((child) => ({
        slug: child.slug,
        path: child.path,
        displayName: child.displayName,
        description: child.description,
        capabilities: child.capabilities,
        agentStages: child.agentStages,
        agentSkills: child.agentSkills,
        mcpTools: child.agentMcpTools,
      })),
    },
    restrictions: [
      "caller owns model credentials and token costs",
      "only active direct children are exposed",
      "handoff does not grant contact, payment, invoice, refund, or administrator authority",
    ],
  };
}
