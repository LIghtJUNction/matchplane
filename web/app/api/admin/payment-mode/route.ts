import { forwardPaymentAdmin } from "../../../../src/lib/payment-admin";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return forwardPaymentAdmin(request, "/v1/admin/payment-mode", "GET");
}

export async function POST(request: Request): Promise<Response> {
  return forwardPaymentAdmin(request, "/v1/admin/payment-mode", "POST");
}
