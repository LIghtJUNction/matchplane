export const MAX_PUBLIC_MATCH_REASONS = 8;
export const MAX_PUBLIC_MATCH_REASON_CHARACTERS = 500;

const PRIVATE_ATTRIBUTE_KEY =
  /accesskey|apikey|authorization|bearer|contact|cookie|credential|email|manifest|oauth|password|phone|private|providerhint|secret|session|supplyparty|terms|token|wechat/;
const PRIVATE_VEHICLE_ATTRIBUTE_KEY = [
  /^(?:vehicle)?vin(?:number|code|last\d*)?$/,
  /vehicleidentificationnumber|chassis(?:number|no|code|id)|frame(?:number|no|code|id)/,
  /licenseplate|plate(?:number|no|code|id)|registration(?:number|no|code|id)/,
  /registration(?:document|certificate|card)|vehicle(?:document|certificate|license)/,
  /ownershipdocument|drivers?license|identitydocument|idcard/,
  /document(?:url|uri|file|image|ref)|certificate(?:number|no|code|id|url|uri|file|image|ref)/,
  /invoice(?:number|no|code|id|url|uri|file|image|ref)|owner(?:name|address|information)/,
  /supplier|vendor/,
  /(?:purchase|procurement|acquisition|buying|buy)(?:price|cost|amount)/,
  /costprice|(?:reconditioning|refurbishment|refurb|preparation|prep|repair)(?:cost|expense)/,
  /grossprofit|netprofit|expectedprofit|profitmargin|grossmargin/,
  /reserveprice|floorprice|internalprice/,
  /exactlocation|inventorylocation|storagelocation|warehouselocation/,
  /warehouse(?:bin|slot)|storage(?:slot|spot)|parkinglocation/,
  /(?:internal|staff|admin)(?:note|notes|memo|remark|comment)/,
];
const PRIVATE_VEHICLE_ATTRIBUTE_TOKEN = /^(?:vin|idcard|profit|margin)$/;
const PRIVATE_ATTRIBUTE_KEY_CJK =
  /联系|电话|手机|微信|邮箱|密钥|秘密|令牌|清单|车架号|车架号码|车辆识别码|车牌|号牌|行驶证|登记证|合格证|身份证|证件|发票|车主(?:姓名|名字|地址|信息)|供应(?:方|商)(?:姓名|名字|地址|信息)|采购价|收购价|进货价|采购成本|收购成本|整备成本|整修成本|利润|毛利|净利|底价|库位|仓位|精确位置|内部备注|内部笔记|员工备注|管理备注/;

/** Deny private or authority-bearing attributes before public projection or ranking. */
export function isSafePublicAttributeKey(key: string): boolean {
  const lower = key.toLocaleLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, "");
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return (
    !PRIVATE_ATTRIBUTE_KEY.test(normalized) &&
    !PRIVATE_VEHICLE_ATTRIBUTE_KEY.some((pattern) =>
      pattern.test(normalized),
    ) &&
    !tokens.some((token) => PRIVATE_VEHICLE_ATTRIBUTE_TOKEN.test(token)) &&
    !PRIVATE_ATTRIBUTE_KEY_CJK.test(key)
  );
}

/** Deduplicate and bound public explanations by Unicode scalar count. */
export function boundedMatchReasons(values: string[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const reason = [...value.trim()]
      .slice(0, MAX_PUBLIC_MATCH_REASON_CHARACTERS)
      .join("");
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
    if (reasons.length === MAX_PUBLIC_MATCH_REASONS) break;
  }
  return reasons;
}
