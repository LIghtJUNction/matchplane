import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { admitPlatformAiCall } from "../../../../src/platform-ai-admission";
import {
  PlatformAssistantUnavailableError,
  PlatformRouterQuotaExceededError,
  reviseShoppingMemoryWithAi,
} from "../../../../src/platform-router";
import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  deleteShoppingMemory,
  parseShoppingMemoryMutation,
  readShoppingMemory,
  ShoppingMemoryValidationError,
  writeShoppingMemory,
} from "../../../../src/shopping-memory";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { jsonError as sharedJsonError } from "../../../../src/lib/json-error";
import { configuredTenantId } from "../../../../src/lib/store-access";

function jsonError(
  error: string,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return sharedJsonError(error, status, {
    "cache-control": "private, no-store",
    ...headers,
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const PER_SUBJECT_LIMIT = 20;
const GLOBAL_LIMIT = 120;
type ShoppingMemorySnapshot = Awaited<ReturnType<typeof readShoppingMemory>>;

export async function GET(request: Request) {
  const context = await requestContext(request);
  if (context instanceof NextResponse) return context;
  try {
    return response({
      memory: await readShoppingMemory(context.tenantId, context.authUserId),
    });
  } catch {
    process.stderr.write("[shopping-memory] read failed\n");
    return jsonError("暂时无法读取购物记忆，请稍后重试", 500);
  }
}

export async function PUT(request: Request) {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const context = await requestContext(request);
  if (context instanceof NextResponse) return context;
  try {
    const mutation = parseShoppingMemoryMutation(
      await readJsonBody(request, MAX_BODY_BYTES),
    );
    const memory = await writeShoppingMemory({
      tenantId: context.tenantId,
      authUserId: context.authUserId,
      mutation,
    });
    if (!memory)
      return jsonError("购物记忆已在其他页面更新，请刷新后重试", 409);
    return response({ memory });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return jsonError("购物记忆内容过多", 413);
    if (error instanceof ShoppingMemoryValidationError)
      return jsonError(error.message, 400);
    process.stderr.write("[shopping-memory] update failed\n");
    return jsonError("暂时无法保存购物记忆，请稍后重试", 500);
  }
}

export async function POST(request: Request) {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const context = await requestContext(request);
  if (context instanceof NextResponse) return context;
  const requestId = randomUUID();
  try {
    const body = (await readJsonBody(request, MAX_BODY_BYTES)) as {
      suggestion?: unknown;
      expectedVersion?: unknown;
    };
    const suggestion =
      typeof body.suggestion === "string" ? body.suggestion.trim() : "";
    if (!suggestion || suggestion.length > 2_000)
      return jsonError("请用 1 到 2000 个字符说明要修改的内容", 400);
    if (
      !Number.isSafeInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 0
    )
      return jsonError("记忆版本无效，请刷新后重试", 400);

    const current = await readShoppingMemory(
      context.tenantId,
      context.authUserId,
    );
    if (current.version !== Number(body.expectedVersion))
      return jsonError("购物记忆已在其他页面更新，请刷新后重试", 409);

    const revision = await reviseShoppingMemoryWithAi({
      suggestion,
      memory: current,
      admitCall: async () => {
        const admitted = await admitPlatformAiCall({
          subject: context.authUserId,
          requestId,
          platformPath: "/",
          perSubjectLimit: boundedInteger(
            process.env.MATCHPLANE_GUEST_AI_REQUESTS_PER_HOUR,
            PER_SUBJECT_LIMIT,
            1_000,
          ),
          globalLimit: boundedInteger(
            process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR,
            GLOBAL_LIMIT,
            100_000,
          ),
        });
        if (!admitted) throw new PlatformRouterQuotaExceededError();
      },
    });
    const mutation = parseShoppingMemoryMutation({
      enabled: current.enabled,
      facts: revision.facts,
      expectedVersion: current.version,
    });
    const memory = await writeShoppingMemory({
      tenantId: context.tenantId,
      authUserId: context.authUserId,
      mutation,
      source: "assistant_revision",
    });
    if (!memory)
      return jsonError("购物记忆已在其他页面更新，请刷新后重试", 409);
    await recordAiRevision({
      requestId,
      tenantId: context.tenantId,
      authUserId: context.authUserId,
      model: revision.model,
      usage: revision.usage,
      version: memory.version,
    }).catch(() =>
      process.stderr.write("[shopping-memory] revision audit failed\n"),
    );
    return NextResponse.json(
      { memory, message: revision.message },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return jsonError("购物记忆修改建议过长", 413);
    if (error instanceof ShoppingMemoryValidationError)
      return jsonError(error.message, 400);
    if (error instanceof PlatformRouterQuotaExceededError)
      return jsonError(error.message, 429, { "retry-after": "3600" });
    if (error instanceof PlatformAssistantUnavailableError)
      return jsonError(error.message, 502);
    process.stderr.write("[shopping-memory] AI revision failed\n");
    return jsonError("暂时无法修改购物记忆，请稍后重试", 500);
  }
}

export async function DELETE(request: Request) {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const context = await requestContext(request);
  if (context instanceof NextResponse) return context;
  try {
    return response({
      memory: await deleteShoppingMemory({
        tenantId: context.tenantId,
        authUserId: context.authUserId,
      }),
    });
  } catch {
    process.stderr.write("[shopping-memory] delete failed\n");
    return jsonError("暂时无法删除购物记忆，请稍后重试", 500);
  }
}

async function requestContext(
  request: Request,
): Promise<{ tenantId: string; authUserId: string } | NextResponse> {
  let session = null;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    session = null;
  }
  if (!session?.user?.id) return jsonError("请先登录再管理购物记忆", 401);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城租户尚未配置完整", 503);
  return { tenantId, authUserId: session.user.id };
}


function response(body: { memory: ShoppingMemorySnapshot }) {
  return NextResponse.json(body, {
    headers: { "cache-control": "private, no-store" },
  });
}

async function recordAiRevision(input: {
  requestId: string;
  tenantId: string;
  authUserId: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  version: number;
}) {
  await authDatabase.query(
    `INSERT INTO platform_audit_events
       (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
     VALUES ($1::uuid, $2::uuid, '/', $3::uuid,
             'shopping.memory.ai_revised', 'success', $4::jsonb)`,
    [
      randomUUID(),
      input.tenantId,
      input.authUserId,
      JSON.stringify({
        request_id: input.requestId,
        model: input.model,
        prompt_tokens: input.usage?.promptTokens ?? null,
        completion_tokens: input.usage?.completionTokens ?? null,
        total_tokens: input.usage?.totalTokens ?? null,
        version: input.version,
      }),
    ],
  );
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}
