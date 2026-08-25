import { App } from "../../src/App";
import { isMountedPlatformPath } from "../../src/platform-mount";
import { readActivePlatformManifest } from "../../src/platform-manifest";
import { notFound } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every registered platform owns a URL path, but it still renders through the same
 * root application contract. The manifest loaded by App decides the labels and
 * domain adapters; this route deliberately contains no vertical fields.
 */
export default async function PlatformPathPage({
  params,
}: {
  params: Promise<{ platformPath: string[] }>;
}) {
  const { platformPath } = await params;
  const initialPath = `/${platformPath.join("/")}`;
  if (!(await isMountedPlatformPath(initialPath))) notFound();
  // Server-render the store identity so the first paint (and any crawler) shows
  // the display name instead of the URL slug while the client manifest loads.
  let initialStoreName: string | undefined;
  let initialStoreDescription: string | undefined;
  const manifest = await readActivePlatformManifest(initialPath);
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as {
        displayName?: unknown;
        description?: unknown;
      };
      if (typeof parsed.displayName === "string" && parsed.displayName.trim())
        initialStoreName = parsed.displayName.trim();
      if (typeof parsed.description === "string" && parsed.description.trim())
        initialStoreDescription = parsed.description.trim();
    } catch {
      // The client-side manifest load remains the fallback identity source.
    }
  }
  return (
    <App
      initialPath={initialPath}
      initialStoreName={initialStoreName}
      initialStoreDescription={initialStoreDescription}
    />
  );
}
