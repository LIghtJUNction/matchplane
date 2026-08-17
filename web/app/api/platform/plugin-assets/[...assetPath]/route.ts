import { GET as serveQueryAsset } from "../route";
import { isMountedPlatformPath } from "../../../../../src/platform-mount";

export const runtime = "nodejs";

/**
 * Path-shaped companion to the query endpoint. It makes relative URLs inside
 * a plugin's static HTML resolve to the same verified artifact directory.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ assetPath: string[] }> },
): Promise<Response> {
  const url = new URL(request.url);
  const assetPath = (await context.params).assetPath;
  if (!assetPath?.length) return new Response("Not found", { status: 404 });
  const requestedPath = url.searchParams.get("path");
  const resolved = requestedPath
    ? { platformPath: requestedPath, file: assetPath.slice(requestedPath.split("/").filter(Boolean).length).join("/") }
    : await inferMountedAssetPath(assetPath);
  if (!resolved?.platformPath || !resolved.file) return new Response("Not found", { status: 404 });
  const platformPath = resolved.platformPath;
  const mountSegments = platformPath.split("/").filter(Boolean);
  if (mountSegments.length === 0 || assetPath.slice(0, mountSegments.length).join("/") !== mountSegments.join("/")) {
    return new Response("Not found", { status: 404 });
  }
  url.pathname = "/api/platform/plugin-assets";
  url.searchParams.set("path", platformPath);
  url.searchParams.set("file", resolved.file);
  return serveQueryAsset(new Request(url, request));
}

/**
 * Relative URLs inside a plugin HTML document do not retain the entry URL's
 * `?path=` query. Resolve the longest active platform prefix instead of
 * guessing a one-level mount; this keeps nested child platforms routable while
 * the query endpoint remains the single authorization and file-safety boundary.
 */
async function inferMountedAssetPath(assetPath: string[]): Promise<{ platformPath: string; file: string } | null> {
  if (assetPath.length < 2 || assetPath.length > 96) return null;
  for (let prefixLength = assetPath.length - 1; prefixLength >= 1; prefixLength -= 1) {
    const platformPath = `/${assetPath.slice(0, prefixLength).join("/")}`;
    if (!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(platformPath)) continue;
    if (!(await isMountedPlatformPath(platformPath))) continue;
    const file = assetPath.slice(prefixLength).join("/");
    if (file) return { platformPath, file };
  }
  return null;
}
