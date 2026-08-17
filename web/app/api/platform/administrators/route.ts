import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Root-platform user-role control plane. Better Auth owns the user and role records. */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireRootManager(request);
  if (guard.response) return guard.response;
  try {
    const result = await auth.api.listUsers({
      query: { limit: 1000, offset: 0, sortBy: "createdAt", sortDirection: "desc" },
      headers: request.headers,
    });
    return NextResponse.json(
      { administrators: result.users.map(toPublicUser), total: result.total },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("root administrator listing failed", error);
    return jsonError("账号列表暂时不可用；请确认 Better Auth 迁移已完成", 503);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireRootManager(request);
  if (guard.response) return guard.response;
  if (!guard.isRootSuperAdmin) return jsonError("只有根超级管理员可以修改根管理员权限", 403);

  const input = await parseJson(request);
  const userId = readBoundedText(input.userId, 128);
  const role = input.role === "rootAdmin" || input.role === "user" ? input.role : null;
  if (!userId) return jsonError("userId 无效", 400);
  if (!role) return jsonError("role 只能是 rootAdmin 或 user", 400);
  if (userId === guard.userId) return jsonError("不能移除当前登录的根超级管理员", 400);

  try {
    const target = await auth.api.getUser({ query: { id: userId }, headers: request.headers });
    const configuredRootEmail = process.env.MATCHPLANE_ROOT_ADMIN_EMAIL?.trim().toLowerCase();
    if (role === "rootAdmin" && target.emailVerified !== true) {
      return jsonError("目标账号必须先完成邮箱验证，才能获得根平台管理员权限", 409);
    }
    if (role === "user" && configuredRootEmail && target.email.toLowerCase() === configuredRootEmail) {
      return jsonError("配置的根管理员账号不能被降级", 400);
    }
    const result = role === "rootAdmin"
      ? await auth.api.setRole({
          body: { userId, role },
          headers: request.headers,
        })
      : await auth.api.adminUpdateUser({
          body: { userId, data: { role: "user" } },
          headers: request.headers,
        });
    const updatedUser = "user" in result ? result.user : result;
    return NextResponse.json({ administrator: toPublicUser(updatedUser) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("root administrator role update failed", error);
    return jsonError("根管理员权限更新失败；Better Auth 拒绝了这次变更", 403);
  }
}

interface PublicUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role?: string | null;
  createdAt: Date;
  banned?: boolean | null;
}

function toPublicUser(user: PublicUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role ?? "user",
    createdAt: user.createdAt,
    ...(user.banned === true ? { banned: true } : {}),
  };
}

async function requireRootManager(request: Request): Promise<{ userId: string; isRootSuperAdmin: boolean; response?: undefined } | { response: Response }> {
  if (!hasTrustedBrowserOrigin(request)) return { response: jsonError("请求来源未被平台信任", 403) };
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError("Better Auth session is required", 401) };
  const role = (session.user as { role?: unknown }).role;
  if (role !== "rootSuperAdmin" && role !== "rootAdmin") return { response: jsonError("只有根平台管理员可以查看账号", 403) };
  return { userId: session.user.id, isRootSuperAdmin: role === "rootSuperAdmin" };
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
