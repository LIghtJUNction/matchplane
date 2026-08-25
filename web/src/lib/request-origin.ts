/**
 * Browser cookie mutations must originate from an operator-configured front-end origin.
 * Browser GET/HEAD requests commonly omit Origin, so authenticated read paths use the session
 * check and remain readable without a synthetic Origin header. Machine calls normally have no
 * Cookie header and are intentionally left to their API-key authorization path.
 */
import { isProductionEnvironment } from "./runtime";

export function hasTrustedBrowserOrigin(request: Request): boolean {
  if (!request.headers.get("cookie")) return true;
  if (request.method === "GET" || request.method === "HEAD") return true;
  return isTrustedOrigin(request.headers.get("origin"));
}

/** Strict CSRF boundary for cookie-session mutations: require a cookie and Origin. */
export function hasTrustedCookieOrigin(request: Request): boolean {
  return (
    Boolean(request.headers.get("cookie")) &&
    isTrustedOrigin(request.headers.get("origin"))
  );
}

function isTrustedOrigin(rawOrigin: string | null): boolean {
  const origin = rawOrigin?.trim();
  if (!origin) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    return false;

  const configured = [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (!isProductionEnvironment()) {
    configured.push("http://localhost:4173", "http://127.0.0.1:4173");
  }

  return configured.some((value) => {
    try {
      return new URL(value).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}
