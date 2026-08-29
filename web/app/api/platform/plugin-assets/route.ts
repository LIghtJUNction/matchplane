import { promises as fs } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { requestSearchParams } from "../../../../src/lib/request-url";
import { isMountedPlatformPath } from "../../../../src/platform-mount";
import { normalizePlatformPath } from "../../../../src/platform-agent-handoff";
import { authenticatePlatformRequest } from "../../../../src/platform-request-auth";
import { isActivePlatformPathVisible } from "../../../../src/platform-visibility";
import { isUuid } from "../../../../src/lib/uuid";

export const runtime = "nodejs";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const assetTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/**
 * Serve only the active registration's verified static artifact. The route
 * never fetches a remote URL and never executes plugin server code.
 */
export async function GET(request: Request): Promise<Response> {
  const searchParams = requestSearchParams(request);
  const platformPath = normalizePlatformPath(searchParams.get("path"));
  if (!platformPath || platformPath === "/")
    return NextResponse.json(
      { error: "plugin asset path is invalid" },
      { status: 400 },
    );
  if (!(await isMountedPlatformPath(platformPath)))
    return NextResponse.json({ error: "平台路径尚未激活" }, { status: 404 });
  const actor = await authenticatePlatformRequest(request);
  const viewer = actor
    ? {
        authUserId: actor.access === "session" ? actor.subject : null,
        organizationId: actor.organizationId,
        isRootAdministrator: actor.isRootAdministrator,
      }
    : undefined;
  if (!(await isActivePlatformPathVisible(platformPath, viewer))) {
    return NextResponse.json(
      { error: "plugin asset is not available" },
      { status: 404 },
    );
  }

  const rootTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  const artifactRoot = process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT?.trim();
  if (
    !rootTenantId ||
    !isUuid(rootTenantId) ||
    !artifactRoot ||
    !path.isAbsolute(artifactRoot)
  ) {
    return NextResponse.json(
      { error: "plugin artifact host is not configured" },
      { status: 404 },
    );
  }

  const registration = await readActiveArtifact(platformPath, rootTenantId);
  if (!registration?.artifactLocator || !registration.buildDigest) {
    return NextResponse.json(
      { error: "active platform has no verified static artifact" },
      { status: 404 },
    );
  }
  const requestedBuild = searchParams.get("build");
  if (requestedBuild && requestedBuild !== registration.buildDigest) {
    return NextResponse.json(
      { error: "plugin artifact digest is not active" },
      { status: 404 },
    );
  }

  const file = searchParams.get("file") || registration.artifactEntry;
  if (!isSafeRelativePath(file, 512))
    return NextResponse.json(
      { error: "plugin asset file is invalid" },
      { status: 400 },
    );
  if (!isSafeRelativePath(registration.artifactLocator, 512)) {
    console.error("invalid artifact locator in active registration", {
      platformPath,
    });
    return NextResponse.json(
      { error: "plugin artifact locator is invalid" },
      { status: 500 },
    );
  }

  const root = path.resolve(artifactRoot);
  const artifactDirectory = path.resolve(root, registration.artifactLocator);
  const requestedFile = path.resolve(artifactDirectory, file);
  if (
    !isWithin(root, artifactDirectory) ||
    !isWithin(artifactDirectory, requestedFile)
  ) {
    return NextResponse.json(
      { error: "plugin asset escapes its artifact root" },
      { status: 400 },
    );
  }

  try {
    const [rootReal, artifactReal, fileReal] = await Promise.all([
      fs.realpath(root),
      fs.realpath(artifactDirectory),
      fs.realpath(requestedFile),
    ]);
    if (
      !isWithin(rootReal, artifactReal) ||
      !isWithin(artifactReal, fileReal)
    ) {
      return NextResponse.json(
        { error: "plugin asset symlink escapes its artifact root" },
        { status: 400 },
      );
    }
    const info = await fs.stat(fileReal);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
      return NextResponse.json(
        { error: "plugin asset is not a bounded file" },
        { status: 404 },
      );
    }
    const content = await fs.readFile(fileReal);
    return new Response(content, {
      headers: {
        // Visibility can depend on a Better Auth session or organization-scoped API key.
        // A shared immutable cache would replay an invite-only artifact without re-running
        // that authorization check, so even digest-addressed plugin responses stay uncacheable.
        "cache-control": "private, no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        "content-type":
          assetTypes[path.extname(fileReal).toLowerCase()] ??
          "application/octet-stream",
        // The host intentionally uses an opaque sandbox origin (`allow-scripts` without
        // `allow-same-origin`). Static module assets therefore need anonymous CORS/CORP.
        // Visibility is still enforced before the response and the response is never cached.
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "plugin asset not found" },
      { status: 404 },
    );
  }
}

interface ActiveArtifact {
  artifactLocator: string | null;
  artifactEntry: string;
  buildDigest: string | null;
}

async function readActiveArtifact(
  platformPath: string,
  rootTenantId: string,
): Promise<ActiveArtifact | null> {
  try {
    const result = await authDatabase.query(
      `WITH RECURSIVE platform_tree AS (
         SELECT o.id, o.slug, o."parentOrganizationId", o."tenantId",
                '/'::text AS platform_path, true AS path_active, 0 AS depth
           FROM "organization" o
          WHERE o."tenantId" = $1::text
            AND o."parentOrganizationId" IS NULL
            AND o."rootPlatform" = true
         UNION ALL
         SELECT child.id, child.slug, child."parentOrganizationId", child."tenantId",
                CASE WHEN platform_tree.platform_path = '/' THEN '/' || child.slug
                     ELSE platform_tree.platform_path || '/' || child.slug END,
                platform_tree.path_active AND EXISTS (
                  SELECT 1 FROM subplatform_registrations registration
                   WHERE registration.tenant_id = $1::uuid
                     AND registration.slug = child.slug
                     AND registration.state = 'active'
                ),
                platform_tree.depth + 1
           FROM "organization" child
           JOIN platform_tree ON child."parentOrganizationId" = platform_tree.id
            AND child."tenantId" = platform_tree."tenantId"
          WHERE platform_tree.depth < 64
       )
       SELECT r.artifact_locator AS "artifactLocator",
              r.artifact_entry AS "artifactEntry",
              encode(r.build_digest, 'hex') AS "buildDigest"
         FROM platform_tree tree
         JOIN LATERAL (
           SELECT artifact_locator, artifact_entry, build_digest
             FROM subplatform_registrations registration
             JOIN domains domain
               ON domain.id = registration.domain_id
              AND domain.tenant_id = registration.tenant_id
              AND domain.status = 'active'
            WHERE registration.tenant_id = $1::uuid
              AND registration.slug = tree.slug
              AND registration.state = 'active'
            ORDER BY registration.version DESC
            LIMIT 1
         ) r ON true
        WHERE tree.platform_path = $2 AND tree.path_active
        LIMIT 1`,
      [rootTenantId, platformPath],
    );
    const row = result.rows[0] as ActiveArtifact | undefined;
    return row ?? null;
  } catch (error) {
    console.error("active plugin artifact lookup failed", error);
    return null;
  }
}

function isSafeRelativePath(value: string, maximum: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
