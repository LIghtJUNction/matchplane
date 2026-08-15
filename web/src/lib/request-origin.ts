/**
 * Browser cookie requests must originate from an operator-configured front-end origin.
 * Machine calls normally have no Cookie header and are intentionally left to their API-key
 * authorization path.  A missing Origin is kept compatible with non-browser clients; when a
 * browser supplies one, an attacker-controlled cross-site Origin fails closed.
 */
export function hasTrustedBrowserOrigin(request: Request): boolean {
  if (!request.headers.get("cookie")) return true;
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;

  const configured = [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (process.env.NODE_ENV !== "production") {
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
