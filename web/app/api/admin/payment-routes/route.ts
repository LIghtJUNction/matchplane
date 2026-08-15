import { forwardPaymentAdmin } from "../../../../src/lib/payment-admin";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return forwardPaymentAdmin(request, "/v1/admin/payment-routes", "GET");
}

export function POST(request: Request): Promise<Response> {
  return forwardPaymentAdmin(request, "/v1/admin/payment-routes", "POST");
}
