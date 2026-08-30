import type { InvoiceSetting } from "../../../../src/api";
import { forwardPaymentAdmin } from "../../../../src/lib/payment-admin";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return canonicalInvoiceSettingResponse(
    await forwardPaymentAdmin(request, "/v1/admin/invoice-mode", "GET"),
  );
}

export async function POST(request: Request): Promise<Response> {
  return canonicalInvoiceSettingResponse(
    await forwardPaymentAdmin(request, "/v1/admin/invoice-mode", "POST"),
  );
}

async function canonicalInvoiceSettingResponse(
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return malformedInvoiceSettingResponse();
  }
  const setting = canonicalInvoiceSetting(value);
  if (!setting) return malformedInvoiceSettingResponse();

  return Response.json(setting, { status: response.status });
}

function canonicalInvoiceSetting(value: unknown): InvoiceSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.hasOwn(input, "provider_id") ||
    typeof input.tenant_id !== "string" ||
    !input.tenant_id ||
    (input.active_mode !== "test" && input.active_mode !== "production") ||
    !Object.hasOwn(input, "active_provider_id") ||
    (input.active_provider_id !== null &&
      (typeof input.active_provider_id !== "string" ||
        !input.active_provider_id)) ||
    typeof input.updated_by !== "string" ||
    !input.updated_by ||
    !Number.isSafeInteger(input.version) ||
    (input.version as number) < 0 ||
    typeof input.updated_at !== "string" ||
    !input.updated_at
  ) {
    return null;
  }

  return {
    tenant_id: input.tenant_id,
    active_mode: input.active_mode,
    provider_id: input.active_provider_id,
    updated_by: input.updated_by,
    version: input.version as number,
    updated_at: input.updated_at,
  };
}

function malformedInvoiceSettingResponse(): Response {
  return Response.json(
    { error: "支付管理服务返回的发票设置无效" },
    { status: 502 },
  );
}
