/**
 * MatchPlane's deployment profile is authoritative when present. Next.js sets
 * NODE_ENV=production for optimized standalone builds, including the local
 * Compose profile, so NODE_ENV alone must not turn a development installation
 * into a production tenant/HTTPS gate.
 */
export interface RuntimeEnvironment {
  MATCHPLANE_ENVIRONMENT?: string;
  NODE_ENV?: string;
}

export function runtimeEnvironment(environment: RuntimeEnvironment = process.env): string | undefined {
  const profile = environment.MATCHPLANE_ENVIRONMENT?.trim();
  return profile || environment.NODE_ENV?.trim() || undefined;
}

export function isProductionEnvironment(environment: RuntimeEnvironment = process.env): boolean {
  return runtimeEnvironment(environment) === "production";
}
