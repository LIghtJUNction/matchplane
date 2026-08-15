import { GET as serveQueryAsset } from "../route";

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
  const platformPath = url.searchParams.get("path");
  const assetPath = (await context.params).assetPath;
  if (!platformPath || !assetPath?.length) return new Response("Not found", { status: 404 });
  const mountSegments = platformPath.split("/").filter(Boolean);
  if (mountSegments.length === 0 || assetPath.slice(0, mountSegments.length).join("/") !== mountSegments.join("/")) {
    return new Response("Not found", { status: 404 });
  }
  const file = assetPath.slice(mountSegments.length).join("/");
  if (!file) return new Response("Not found", { status: 404 });
  url.pathname = "/api/platform/plugin-assets";
  url.searchParams.set("file", file);
  return serveQueryAsset(new Request(url, request));
}
