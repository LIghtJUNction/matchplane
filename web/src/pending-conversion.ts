export const PENDING_CONVERSION_KEY = "matchplane.pending-conversion.v1";
export const PENDING_CONVERSION_TTL_MS = 30 * 60 * 1000;

export interface PendingConversion {
  version: 1;
  storePath: string;
  offerId: string;
  action:
    | "contact_listing"
    | "store_ai_contact_consent"
    | "store_ai_handoff";
  conversionAttemptId: string;
  intentLevel?: "warm" | "high" | "urgent";
  productIds?: string[];
  createdAt: number;
  expiresAt: number;
  actorId?: string;
  intentId?: string;
  idempotencyKey?: string;
}

function isStorePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/[a-z0-9][a-z0-9-]{1,62}$/.test(value)
  );
}

function isPendingConversion(value: unknown): value is PendingConversion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Partial<PendingConversion>;
  return (
    pending.version === 1 &&
    isStorePath(pending.storePath) &&
    typeof pending.offerId === "string" &&
    pending.offerId.length > 0 &&
    pending.offerId.length <= 128 &&
    (pending.action === "contact_listing" ||
      pending.action === "store_ai_contact_consent" ||
      pending.action === "store_ai_handoff") &&
    (pending.action !== "store_ai_handoff" ||
      ((pending.intentLevel === "warm" ||
        pending.intentLevel === "high" ||
        pending.intentLevel === "urgent") &&
        Array.isArray(pending.productIds) &&
        pending.productIds.length <= 16 &&
        pending.productIds.every(
          (productId) =>
            typeof productId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              productId,
            ),
        ))) &&
    typeof pending.conversionAttemptId === "string" &&
    /^[a-zA-Z0-9-]{8,80}$/.test(pending.conversionAttemptId) &&
    typeof pending.createdAt === "number" &&
    Number.isFinite(pending.createdAt) &&
    typeof pending.expiresAt === "number" &&
    Number.isFinite(pending.expiresAt) &&
    pending.expiresAt > pending.createdAt &&
    pending.expiresAt - pending.createdAt <= PENDING_CONVERSION_TTL_MS
  );
}

export function savePendingConversion(
  input: Pick<PendingConversion, "storePath" | "offerId" | "action"> &
    Partial<
      Pick<
        PendingConversion,
        "conversionAttemptId" | "intentLevel" | "productIds"
      >
    >,
  now = Date.now(),
): PendingConversion | null {
  if (typeof window === "undefined") return null;
  const pending: PendingConversion = {
    version: 1,
    ...input,
    conversionAttemptId: input.conversionAttemptId ?? crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + PENDING_CONVERSION_TTL_MS,
  };
  if (!isPendingConversion(pending)) return null;
  try {
    window.sessionStorage.setItem(
      PENDING_CONVERSION_KEY,
      JSON.stringify(pending),
    );
    return pending;
  } catch {
    return null;
  }
}

export function ensurePendingConversion(
  input: Pick<PendingConversion, "storePath" | "offerId" | "action"> &
    Partial<
      Pick<
        PendingConversion,
        "conversionAttemptId" | "intentLevel" | "productIds"
      >
    >,
): PendingConversion | null {
  const existing = readPendingConversion();
  if (
    existing &&
    existing.storePath === input.storePath &&
    existing.offerId === input.offerId &&
    existing.action === input.action
  )
    return existing;
  return savePendingConversion(input);
}

export function readPendingConversion(now = Date.now()): PendingConversion | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_CONVERSION_KEY);
    if (!raw) return null;
    const pending: unknown = JSON.parse(raw);
    if (!isPendingConversion(pending) || pending.expiresAt <= now) {
      clearPendingConversion();
      return null;
    }
    return pending;
  } catch {
    clearPendingConversion();
    return null;
  }
}

export function updatePendingConversion(
  offerId: string,
  patch: Pick<PendingConversion, "actorId" | "intentId" | "idempotencyKey">,
): PendingConversion | null {
  const pending = readPendingConversion();
  if (!pending || pending.offerId !== offerId) return null;
  const updated: PendingConversion = { ...pending, ...patch };
  try {
    window.sessionStorage.setItem(
      PENDING_CONVERSION_KEY,
      JSON.stringify(updated),
    );
    return updated;
  } catch {
    return null;
  }
}

export function clearPendingConversion(offerId?: string): void {
  if (typeof window === "undefined") return;
  if (offerId) {
    try {
      const raw = window.sessionStorage.getItem(PENDING_CONVERSION_KEY);
      if (!raw) return;
      const pending = JSON.parse(raw) as Partial<PendingConversion>;
      if (pending.offerId !== offerId) return;
    } catch {
      // A malformed value is always safe to remove.
    }
  }
  try {
    window.sessionStorage.removeItem(PENDING_CONVERSION_KEY);
  } catch {
    // Local browser storage is an optional UX cache, never a business boundary.
  }
}
