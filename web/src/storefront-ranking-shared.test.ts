import { describe, expect, it } from "vitest";

import { isSafePublicAttributeKey } from "./storefront-ranking-shared";

describe("isSafePublicAttributeKey", () => {
  it.each([
    "seller_contact",
    "supplier_phone",
    "contact_email",
    "wechat",
    "api_credential",
    "authorization",
    "private_notes",
    "secret_token",
    "session_cookie",
    "supply_party_id",
    "raw_manifest",
    "purchase_price",
    "acquisition_cost",
    "unit_cost",
    "operating_expense",
    "profit_margin",
    "reserve_price",
    "exact_location",
    "warehouse_slot",
    "internal_comment",
    "联系电话",
    "邮箱",
    "访问凭据",
    "私密备注",
    "采购价",
    "经营成本",
    "利润",
    "精确位置",
    "内部备注",
  ])("rejects domain-neutral private key %s", (key) => {
    expect(isSafePublicAttributeKey(key)).toBe(false);
  });

  it.each([
    "brand",
    "model",
    "material",
    "size",
    "condition_summary",
    "city",
    "certification_summary",
    "vin",
    "chassis_number",
    "license_plate",
    "registration_document_url",
    "vehicle_costume_color",
    "车架号",
    "车牌号码",
    "公开车况",
    "行业认证",
  ])("leaves industry-specific policy to package review for %s", (key) => {
    expect(isSafePublicAttributeKey(key)).toBe(true);
  });
});
