/**
 * Creates a browser UUID for correlation and idempotency fields.
 * `crypto.randomUUID()` is unavailable on some HTTP origins, while
 * `getRandomValues()` remains available there.
 */
export function createClientUuid(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = [...bytes]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }

  // These values are identifiers, not credentials. This branch keeps the UI usable in legacy
  // browsers that expose neither Web Crypto API while preserving practical uniqueness.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}
