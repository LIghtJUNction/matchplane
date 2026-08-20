import { NextResponse } from "next/server";

import { auth } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { probePlatformRouter } from "../../../../../src/platform-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run a tiny server-side model health check for a root administrator.
 *
 * The browser never supplies an endpoint, model, prompt, or credential. The probe uses only the
 * web service's operator-owned environment and returns bounded status metadata, so a failed
 * provider cannot leak its response body or secret into the admin UI.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });
  const role = (session.user as { role?: string | null }).role;
  if (role !== "rootSuperAdmin" && role !== "rootAdmin") {
    return NextResponse.json({ error: "只有根平台管理员可以测试托管 AI" }, { status: 403 });
  }

  const probe = await probePlatformRouter();
  return NextResponse.json(probe, {
    status: probe.status === "ready" ? 200 : probe.status === "unconfigured" ? 409 : 502,
    headers: { "cache-control": "no-store" },
  });
}
