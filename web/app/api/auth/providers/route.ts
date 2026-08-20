import { NextResponse } from "next/server";

import {
  configuredFallbackOAuthProviderIds,
  configuredPrimaryOAuthProviderIds,
} from "../../../../src/lib/auth";
import { isRootEmailAuthConfigured } from "../../../../src/lib/mail";
import { isPhoneOtpConfigured } from "../../../../src/lib/sms";

export const runtime = "nodejs";
// Provider availability is deployment configuration. Do not let a build-time
// prerender freeze an empty (or development) provider list into production.
export const dynamic = "force-dynamic";

/** Public capability discovery for the login screen. Secrets and provider endpoints stay server-side. */
export async function GET(): Promise<Response> {
  const emailAuth = await isRootEmailAuthConfigured();
  const phoneAuth = isPhoneOtpConfigured();
  return NextResponse.json(
    {
      // National network identity is a promoted option only when the server has
      // a complete, operator-approved public-service adapter. It remains
      // voluntary; all fallback methods stay available to the same account.
      primary: configuredPrimaryOAuthProviderIds(),
      password: true,
      // Code and magic-link delivery are deployment capabilities, not merely Better Auth
      // plugins. Keep the methods hidden until the corresponding gateway is configured.
      emailOtp: emailAuth,
      phoneOtp: phoneAuth,
      passkey: true,
      magicLink: emailAuth,
      social: configuredFallbackOAuthProviderIds(),
    },
    { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" } },
  );
}
