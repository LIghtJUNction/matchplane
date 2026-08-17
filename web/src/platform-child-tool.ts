import { randomUUID } from "node:crypto";

import { readActiveDirectChildRoutes } from "./platform-child-routes";
import { normalizePlatformPath } from "./platform-agent-handoff";
import { isMountedPlatformPath, isPlatformPathAccessibleByOrganization } from "./platform-mount";
import { authenticatePlatformRequest, type PlatformRequestActor } from "./platform-request-auth";
import { invokeSubplatformMcpTool, resolveSubplatformMcpEndpoint } from "./platform-agent-tool";
import { isActivePlatformPathVisible } from "./platform-visibility";

export interface ChildToolExecution {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

/** Authenticate a request and invoke one manifest-allowlisted active child tool. */
export async function executeAuthenticatedChildTool(input: {
  request: Request;
  platformPath: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId?: string;
  permissions?: Record<string, string[]>;
  tenantId?: string;
  domainId?: string;
  /** Generic child tools are machine-to-machine by default; browser facades may opt in explicitly. */
  allowSession?: boolean;
}): Promise<ChildToolExecution> {
  const actor = await authenticatePlatformRequest(
    input.request,
    input.permissions ?? { agent: ["tool"] },
    { allowSession: input.allowSession === true },
  );
  if (!actor) return failure(401, "Better Auth session or required Agent permission is required");
  return executeAuthorizedChildTool({ ...input, actor });
}

export async function executeAuthorizedChildTool(input: {
  actor: PlatformRequestActor;
  platformPath: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId?: string;
  tenantId?: string;
  domainId?: string;
}): Promise<ChildToolExecution> {
  const platformPath = normalizePlatformPath(input.platformPath);
  if (!platformPath || platformPath === "/") return failure(400, "platform_path must identify an active child node");
  if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(input.toolName)) return failure(400, "tool_name is invalid");

  if (!(await isMountedPlatformPath(platformPath))) return failure(404, "平台路径尚未激活");
  if (input.actor.organizationId && !(await isPlatformPathAccessibleByOrganization(platformPath, input.actor.organizationId))) {
    return failure(403, "API key 不能访问该平台节点");
  }
  const viewer = {
    authUserId: input.actor.access === "session" ? input.actor.subject : null,
    organizationId: input.actor.organizationId,
    isRootAdministrator: input.actor.isRootAdministrator,
  };
  if (!(await isActivePlatformPathVisible(platformPath, viewer))) return failure(404, "当前平台节点不对该身份开放");

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!rootTenantId || !isUuid(rootTenantId)) return failure(503, "root tenant 尚未配置");
  const children = await readActiveDirectChildRoutes(parentPlatformPath(platformPath), rootTenantId, viewer).catch(() => null);
  if (!children) return failure(503, "子平台注册目录暂时不可用");
  const child = children.find((candidate) => candidate.path === platformPath);
  if (!child) return failure(404, "当前平台节点没有可用的 active registration");
  if (input.tenantId && child.tenantId !== input.tenantId) return failure(403, "请求 tenant 与平台节点不一致");
  if (input.domainId && child.domainId !== input.domainId) return failure(403, "请求 domain 与平台节点不一致");
  if (!child.agentMcpTools.includes(input.toolName)) return failure(403, "该 MCP tool 未被子平台 manifest 声明");

  const endpoint = await resolveSubplatformMcpEndpoint(child.mcpServerKey);
  if (!endpoint) return failure(503, "子平台 MCP endpoint 尚未由部署管理员配置");
  const requestId = input.requestId?.trim() || randomUUID();
  const result = await invokeSubplatformMcpTool({
    endpoint,
    toolName: input.toolName,
    arguments: input.arguments,
    requestId,
    platformPath,
    actorSubject: input.actor.subject,
  });
  return { ok: result.ok, status: result.status, payload: result.payload };
}

function failure(status: number, error: string): ChildToolExecution {
  return { ok: false, status, payload: { error } };
}

function parentPlatformPath(platformPath: string): string {
  const slash = platformPath.lastIndexOf("/");
  return slash <= 0 ? "/" : platformPath.slice(0, slash);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
