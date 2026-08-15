import { App } from "../../src/App";

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
  return <App initialPath={`/${platformPath.join("/")}`} />;
}
