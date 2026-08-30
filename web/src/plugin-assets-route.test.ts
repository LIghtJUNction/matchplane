import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  authenticatePlatformRequest,
  databaseQuery,
  isMountedPlatformPath,
  isVisible,
} = vi.hoisted(() => ({
  authenticatePlatformRequest: vi.fn(),
  databaseQuery: vi.fn(),
  isMountedPlatformPath: vi.fn(),
  isVisible: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  authDatabase: { query: databaseQuery },
}));
vi.mock("./platform-agent-handoff", () => ({
  normalizePlatformPath: (value: unknown) =>
    typeof value === "string" && /^\/[a-z0-9-]+$/.test(value) ? value : null,
}));
vi.mock("./platform-mount", () => ({ isMountedPlatformPath }));
vi.mock("./platform-request-auth", () => ({ authenticatePlatformRequest }));
vi.mock("./platform-visibility", () => ({ isActivePlatformPathVisible: isVisible }));

import { GET } from "../app/api/platform/plugin-assets/route";

const digest = "a".repeat(64);
const tenantId = "123e4567-e89b-42d3-a456-426614174000";
let artifactRoot = "";
let previousArtifactRoot: string | undefined;
let previousTenantId: string | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "matchplane-plugin-assets-"));
  await mkdir(path.join(artifactRoot, "builds", digest), { recursive: true });
  await writeFile(path.join(artifactRoot, "builds", digest, "index.html"), "private plugin");
  previousArtifactRoot = process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT;
  previousTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID;
  process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT = artifactRoot;
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
});

afterAll(async () => {
  if (previousArtifactRoot === undefined) delete process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT;
  else process.env.MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT = previousArtifactRoot;
  if (previousTenantId === undefined) delete process.env.MATCHPLANE_ROOT_TENANT_ID;
  else process.env.MATCHPLANE_ROOT_TENANT_ID = previousTenantId;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("plugin asset response caching", () => {
  beforeEach(() => {
    authenticatePlatformRequest.mockReset();
    databaseQuery.mockReset();
    isMountedPlatformPath.mockReset();
    isVisible.mockReset();
    isMountedPlatformPath.mockResolvedValue(true);
    isVisible.mockImplementation(async (_platformPath: string, viewer: unknown) => Boolean(viewer));
    databaseQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{
        buildDigest: digest,
        artifactLocator: `builds/${digest}`,
        artifactEntry: "index.html",
      }],
    });
  });

  it("does not put an authenticated invite-only artifact in a shared immutable cache", async () => {
    authenticatePlatformRequest
      .mockResolvedValueOnce({
        access: "session",
        subject: "223e4567-e89b-42d3-a456-426614174000",
        organizationId: null,
        isRootAdministrator: false,
      })
      .mockResolvedValueOnce(null);
    const url = `https://matx.test/api/platform/plugin-assets?path=%2Fprivate-store&build=${digest}&file=index.html`;

    const authenticated = await GET(new Request(url));

    const authenticatedBody = await authenticated.text();
    expect(authenticated.status, authenticatedBody).toBe(200);
    expect(authenticated.headers.get("cache-control")).toBe("private, no-store");
    expect(authenticatedBody).toBe("private plugin");

    const anonymous = await GET(new Request(url));
    expect(anonymous.status).toBe(404);
  });
});
