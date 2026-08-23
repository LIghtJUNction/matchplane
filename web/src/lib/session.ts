import { auth } from "./auth";
import { jsonError } from "./json-error";
import { hasTrustedBrowserOrigin } from "./request-origin";
import { isUuid } from "./uuid";

/**
 * Returns the signed-in user id, `null` when anonymous, or `"unavailable"` when
 * session verification itself failed.
 */
export async function authenticatedUserId(
  request: Request,
  logLabel = "session verification failed",
): Promise<string | null | "unavailable"> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const id = session?.user?.id;
    return typeof id === "string" && isUuid(id) ? id : null;
  } catch (error) {
    console.error(logLabel, error);
    return "unavailable";
  }
}

/** Browser-origin + Better Auth root-admin gate shared by platform admin routes. */
export async function requireRootManager(
  request: Request,
  forbiddenMessage: string,
): Promise<Response | null> {
  if (!hasTrustedBrowserOrigin(request)) {
    return jsonError("请求来源未被平台信任", 403);
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("Better Auth session is required", 401);
  const role = (session.user as { role?: unknown }).role;
  if (role !== "rootSuperAdmin" && role !== "rootAdmin") {
    return jsonError(forbiddenMessage, 403);
  }
  return null;
}
