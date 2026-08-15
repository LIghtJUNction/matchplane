import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";

export const runtime = "nodejs";

/**
 * Readiness probe for the Next.js/Better Auth process. A live HTTP process is not
 * considered ready until its database pool can execute a trivial query.
 */
export async function GET(): Promise<Response> {
  try {
    await authDatabase.query("SELECT 1");
    return NextResponse.json({ status: "ok", service: "matchplane-web" }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("web readiness check failed", error);
    return NextResponse.json({ status: "degraded", service: "matchplane-web" }, { status: 503 });
  }
}
