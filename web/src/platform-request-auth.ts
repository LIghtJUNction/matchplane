import { verifyPlatformApiKey } from "./lib/platform-api-key";
import { auth } from "./lib/auth";

export interface PlatformRequestActor {
  /** Stable ledger subject; API-key subjects are deliberately not user sessions. */
  subject: string;
  access: "session" | "api_key";
  organizationId: string | null;
  /** Root administrators may inspect private descendants without becoming child members. */
  isRootAdministrator: boolean;
}

/**
 * Authenticate a human platform chat or a server-side Agent. Better Auth remains the only
 * credential authority; API keys never create an impersonated browser session.
 */
export async function authenticatePlatformRequest(
  request: Request,
  requiredPermissions: Record<string, string[]> = { platform: ["read"] },
  options: { allowSession?: boolean } = {},
): Promise<PlatformRequestActor | null> {
  if (options.allowSession !== false) {
    try {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session) {
        const role = (session.user as { role?: unknown }).role;
        return {
          subject: session.user.id,
          access: "session",
          organizationId: null,
          isRootAdministrator: role === "rootSuperAdmin" || role === "rootAdmin",
        };
      }
    } catch {
      // A malformed/expired session may still be accompanied by a valid machine key.
    }
  }

  const key = await verifyPlatformApiKey(request, requiredPermissions);
  if (!key || !isUuid(key.referenceId)) return null;
  return {
    subject: `api-key:${key.id}`,
    access: "api_key",
    organizationId: key.referenceId,
    isRootAdministrator: false,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
