import { NextResponse } from "next/server";

/** Bounded JSON error response used by MatchPlane route handlers. */
export function jsonError(
  error: string,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}
