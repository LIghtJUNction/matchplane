import { auth } from "./auth";

export interface VerifiedPlatformApiKey {
  id: string;
  referenceId: string;
  permissions: Record<string, string[]> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Verifies a platform machine credential with Better Auth. Callers must still compare
 * `referenceId` with the requested organization and apply the platform-tree policy.
 */
export async function verifyPlatformApiKey(
  request: Request,
  permissions?: Record<string, string[]>,
): Promise<VerifiedPlatformApiKey | null> {
  const key = request.headers.get("x-matchplane-api-key") ?? request.headers.get("x-api-key");
  if (!key?.trim()) return null;
  try {
    const result = await auth.api.verifyApiKey({
      body: {
        configId: "platform",
        key,
        permissions,
      },
    });
    if (!result.valid || !result.key) return null;
    return {
      id: result.key.id,
      referenceId: result.key.referenceId,
      permissions: result.key.permissions ?? null,
      metadata: isRecord(result.key.metadata) ? result.key.metadata : null,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
