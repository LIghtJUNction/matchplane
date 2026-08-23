import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ContactUser = {
  email?: unknown;
  emailVerified?: unknown;
  phoneNumber?: unknown;
  phoneNumberVerified?: unknown;
};

export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id)
    return NextResponse.json(
      { error: "请先登录" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  const user = session.user as ContactUser;
  const channels = [
    ...(user.emailVerified === true && typeof user.email === "string"
      ? [{ type: "email" as const, value: user.email }]
      : []),
    ...(user.phoneNumberVerified === true && typeof user.phoneNumber === "string"
      ? [{ type: "phone" as const, value: user.phoneNumber }]
      : []),
  ];
  return NextResponse.json(
    { channels },
    { headers: { "cache-control": "no-store" } },
  );
}
