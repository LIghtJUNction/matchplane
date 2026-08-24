import { NextResponse } from "next/server";

import {
  PlatformRouterConflictError,
  PlatformRouterLockTimeoutError,
  PlatformRouterStateIndeterminateError,
  PlatformRouterStorageUncertainError,
  PlatformRouterTransactionError,
  type PlatformRouterMutationResult,
} from "../../../../src/lib/platform-router-config";
import { PlatformRouterConfigValidationError } from "../../../../src/lib/platform-router-config/contract";
import { PlatformRouterAuditPendingError } from "../../../../src/lib/platform-router-config/transaction";

export type PlatformRouterMutationPhase = "stage" | "precondition";

export function committedMutationResponse<T extends object>(
  body: T,
  mutation: PlatformRouterMutationResult<unknown>,
  requestId: string,
): Response {
  const { committed, auditPending, maintenancePending, generationId } =
    mutation;
  return NextResponse.json(
    {
      ...body,
      requestId,
      committed,
      auditPending,
      maintenancePending,
      generationId,
    },
    {
      status: auditPending || maintenancePending ? 202 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}

export function platformRouterMutationErrorResponse(
  cause: unknown,
  phase: PlatformRouterMutationPhase,
  requestId: string,
): Response {
  if (cause instanceof PlatformRouterConfigValidationError) {
    return error(
      phase === "stage"
        ? "AI 配置字段无效"
        : "AI 配置前置条件不满足",
      phase === "stage" ? 400 : 409,
      requestId,
    );
  }
  if (cause instanceof PlatformRouterConflictError) {
    return error("AI 待测配置已变更，请重试", 409, requestId);
  }
  if (
    cause instanceof PlatformRouterLockTimeoutError ||
    cause instanceof PlatformRouterAuditPendingError
  ) {
    return error("AI 配置暂时繁忙，请稍后重试", 503, requestId, {
      "retry-after": "1",
    });
  }
  if (
    cause instanceof PlatformRouterStateIndeterminateError ||
    cause instanceof PlatformRouterStorageUncertainError
  ) {
    return error("AI 配置状态无法安全确认", 500, requestId);
  }
  if (cause instanceof PlatformRouterTransactionError) {
    return error("AI 配置事务无法安全完成", 500, requestId);
  }
  return error("AI 配置事务无法安全完成", 500, requestId);
}

function error(
  message: string,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return NextResponse.json(
    { error: message, requestId },
    {
      status,
      headers: { "cache-control": "no-store", ...extraHeaders },
    },
  );
}
