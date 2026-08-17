/**
 * Normalize the optional retry key accepted by the platform routing boundary.
 * It is deliberately opaque: the platform stores it only as a bounded lookup
 * key and never treats it as an identity or a capability.
 */
export function normalizeMatchIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}
