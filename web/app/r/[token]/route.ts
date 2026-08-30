import { NextResponse } from "next/server";

import {
  ACQUISITION_SUBJECT_COOKIE,
  ACQUISITION_SUBJECT_COOKIE_MAX_AGE,
  anonymousAcquisitionSubject,
  recordAcquisitionLanding,
  resolveActiveAcquisitionLink,
} from "../../../src/lib/acquisition-links";

export const runtime = "nodejs";
// Redirect resolution and attribution must never be statically cached.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  try {
    const link = await resolveActiveAcquisitionLink(token);
    if (!link) return notFound();

    const subject = anonymousAcquisitionSubject(request);
    await recordAcquisitionLanding(link, subject.digest);

    const response = new NextResponse(null, {
      status: 307,
      headers: {
        location: `/visit/${token}`,
        "cache-control": "no-store, private",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      },
    });
    if (subject.shouldSetCookie) {
      response.cookies.set({
        name: ACQUISITION_SUBJECT_COOKIE,
        value: subject.value,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: ACQUISITION_SUBJECT_COOKIE_MAX_AGE,
      });
    }
    return response;
  } catch {
    // Public failures intentionally collapse to the same response.  In particular, never log the
    // path token or turn a storage failure into a link-existence oracle.
    return notFound();
  }
}

function notFound(): Response {
  return NextResponse.json(
    { error: "访问链接不存在或已不可用" },
    {
      status: 404,
      headers: {
        "cache-control": "no-store, private",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
