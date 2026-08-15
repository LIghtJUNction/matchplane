import { NextResponse } from "next/server";

import { configuredOAuthProviderIds } from "../../../../src/lib/auth";

export const runtime = "nodejs";

/** Public capability discovery for the login screen. Secrets and provider endpoints stay server-side. */
export function GET(): Response {
  return NextResponse.json(
    {
      password: true,
      emailOtp: true,
      magicLink: true,
      social: configuredOAuthProviderIds(),
    },
    { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" } },
  );
}
