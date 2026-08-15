import { verifyPlatformApiKey } from "./lib/platform-api-key";
import { auth } from "./lib/auth";

export interface PlatformRequestActor {
  /** Stable ledger subject; API-key subjects are deliberately not user sessions. */
  subject: string;
  access: "session" | "api_key";
  organizationId: string | null;
}

/**
 * Authenticate a human platform chat or a server-side Agent. Better Auth remains the only
 * credential authority; API keys never create an impersonated browser session.
 */
export async function authenticatePlatformRequest(request: Request): Promise<PlatformRequestActor | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session) {
      return {
        subject: session.user.id,
        access: "session",
        organizationId: null,
      };
    }
  } catch {
    // A malformed/expired session may still be accompanied by a valid machine key.
  }

  const key = await verifyPlatformApiKey(request, { platform: ["read"] });
  if (!key || !isUuid(key.referenceId)) return null;
  return {
    subject: `api-key:${key.id}`,
    access: "api_key",
    organizationId: key.referenceId,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
