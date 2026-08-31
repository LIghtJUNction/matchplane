import { NextResponse } from "next/server";

import {
  ACQUISITION_SUBJECT_COOKIE,
  ACQUISITION_SUBJECT_COOKIE_MAX_AGE,
  AcquisitionStorageError,
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

  let link: Awaited<ReturnType<typeof resolveActiveAcquisitionLink>>;
  try {
    link = await resolveActiveAcquisitionLink(token);
  } catch (cause) {
    if (cause instanceof AcquisitionStorageError) return notFound();
    throw cause;
  }
  if (!link) return notFound();

  const subject = anonymousAcquisitionSubject(request);
  try {
    await recordAcquisitionLanding(link, subject.digest);
  } catch (cause) {
    if (!(cause instanceof AcquisitionStorageError)) throw cause;
    // Keep this message free of tokens, cookies, request metadata, and internal identifiers.
    console.warn("acquisition touchpoint storage unavailable");
  }

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
