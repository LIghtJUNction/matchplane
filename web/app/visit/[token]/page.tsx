import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AcquisitionLandingPage } from "../../../src/components/AcquisitionLandingPage";
import {
  loadAcquisitionLanding,
  type AcquisitionLanding,
} from "../../../src/lib/acquisition-landing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: "商品详情 · MatchPlane",
  description: "查看店铺当前公开的商品详情。",
  robots: {
    index: false,
    follow: false,
  },
  referrer: "no-referrer",
};

export default async function VisitLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let landing: AcquisitionLanding | null;
  try {
    landing = await loadAcquisitionLanding(token);
  } catch {
    return notFound();
  }
  if (!landing) return notFound();

  return <AcquisitionLandingPage landing={landing} />;
}
