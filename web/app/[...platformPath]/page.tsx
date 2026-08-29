import { notFound } from "next/navigation";
import { App } from "../../src/App";
import { readActivePlatformManifest } from "../../src/platform-manifest";
import { isMountedPlatformPath } from "../../src/platform-mount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function storeIdentityFromManifest(manifest: string | null): {
  name?: string;
  description?: string;
} {
  if (!manifest) return {};
  try {
    const value = JSON.parse(manifest) as {
      displayName?: unknown;
      description?: unknown;
    };
    const name =
      typeof value.displayName === "string"
        ? value.displayName.trim()
        : "";
    const description =
      typeof value.description === "string"
        ? value.description.trim()
        : "";
    const identity: { name?: string; description?: string } = {};
    if (name) identity.name = name;
    if (description) identity.description = description;
    return identity;
  } catch {
    return {};
  }
}

/**
 * Every registered platform owns a URL path, but it still renders through the same
 * root application contract. The server seeds the public store identity; App loads
 * the remaining manifest contract without embedding vertical fields in this route.
 */
export default async function PlatformPathPage({
  params,
}: {
  params: Promise<{ platformPath: string[] }>;
}) {
  const { platformPath } = await params;
  const initialPath = `/${platformPath.join("/")}`;
  if (!(await isMountedPlatformPath(initialPath))) notFound();
  const identity = storeIdentityFromManifest(
    await readActivePlatformManifest(initialPath),
  );
  return (
    <App
      initialPath={initialPath}
      initialStoreName={identity.name}
      initialStoreDescription={identity.description}
    />
  );
}
