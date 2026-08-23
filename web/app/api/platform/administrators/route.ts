import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { jsonError } from "../../../../src/lib/json-error";
import { requireRootManager } from "../../../../src/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Root-scoped account directory. Better Auth owns the user and role records; this route only
 * returns the small profile needed to distinguish registered customers from mall operators.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireRootManager(request, "只有根平台管理员可以查看账号");
  if (denied) return denied;
  try {
    const result = await auth.api.listUsers({
      query: { limit: 1000, offset: 0, sortBy: "createdAt", sortDirection: "desc" },
      headers: request.headers,
    });
    const accounts = result.users.map(toPublicUser);
    return NextResponse.json(
      {
        accounts,
        // Compatibility for the pre-storefront console. Callers must prefer `accounts`: this
        // directory contains every registered account, not only mall operators.
        administrators: accounts,
        total: result.total,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("root administrator listing failed", error);
    return jsonError("账号列表暂时不可用；请确认 Better Auth 迁移已完成", 503);
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


