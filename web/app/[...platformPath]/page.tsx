import { App } from "../../src/App";
import { isMountedPlatformPath } from "../../src/platform-mount";
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
  return <App initialPath={initialPath} />;
}
