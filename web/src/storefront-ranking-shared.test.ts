import { describe, expect, it } from "vitest";

import { isSafePublicAttributeKey } from "./storefront-ranking-shared";

describe("isSafePublicAttributeKey", () => {
  it.each([
    "vin",
    "vehicle_vin",
    "vehicle_identification_number",
    "chassis_number",
    "license_plate",
    "plate_no",
    "registration_document_url",
    "vehicle_license_file",
    "owner_name",
    "supplier_phone",
    "supplier_id",
    "purchase_price",
    "buy_price",
    "acquisition_cost",
    "procurement_amount",
    "reconditioning_cost",
    "prep_cost",
    "profit_margin",
    "inventory_location",
    "warehouse_slot",
    "internal_notes",
    "internal_comment",
    "车架号",
    "车牌号码",
    "行驶证",
    "车辆合格证",
    "车主姓名",
    "供应方地址",
    "采购价",
    "收购成本",
    "整备成本",
    "利润",
    "精确库位",
    "内部备注",
  ])("rejects private vehicle key %s", (key) => {
    expect(isSafePublicAttributeKey(key)).toBe(false);
  });

  it.each([
    "brand",
    "vehicle.model",
    "model_year",
    "registration_date",
    "plate_registration_date",
    "mileage_km",
    "engine_displacement_l",
    "energy_type",
    "transmission",
    "emission_standard",
    "exterior_color",
    "condition_summary",
    "chassis_condition_summary",
    "inspection_summary",
    "city",
    "owner_count",
    "上牌年月",
    "公开车况",
  ])("accepts safe public vehicle key %s", (key) => {
    expect(isSafePublicAttributeKey(key)).toBe(true);
  });

  it.each([
    "seller_contact",
    "seller_phone",
    "contact_email",
    "wechat",
    "supply_party",
    "联系电话",
    "手机",
    "微信",
    "邮箱",
  ])("keeps the existing contact boundary for %s", (key) => {
    expect(isSafePublicAttributeKey(key)).toBe(false);
  });
});
