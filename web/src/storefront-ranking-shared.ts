export const MAX_PUBLIC_MATCH_REASONS = 8;
export const MAX_PUBLIC_MATCH_REASON_CHARACTERS = 500;

const PRIVATE_AUTHORITY_ATTRIBUTE_KEY =
  /accesskey|apikey|authorization|bearer|contact|cookie|credential|email|manifest|oauth|password|phone|private|providerhint|secret|seller(?:id|party)|session|supplier(?:id|party)|supplyparty|terms|token|wechat/;
const PRIVATE_BUSINESS_ATTRIBUTE_KEY = [
  /(?:purchase|procurement|acquisition|buying|buy|production|operating|internal|unit|wholesale|landed)(?:price|cost|amount)/,
  /cost(?:price|amount|basis|breakdown|estimate)$|^(?:cost|expense)$/,
  /(?:gross|net|expected)?profit(?:margin)?|grossmargin|netmargin/,
  /reserveprice|floorprice|internalprice/,
  /exactlocation|preciselocation|inventorylocation|storagelocation|warehouselocation/,
  /warehouse(?:bin|slot)|storage(?:bin|slot|spot)|backroomlocation/,
  /(?:internal|staff|admin)(?:note|notes|memo|remark|comment)/,
];
// Keep these patterns role- or data-qualified. Bare `id`, `name`, and
// `document` are valid parts of public product metadata.
const PRIVATE_PERSONAL_ATTRIBUTE_KEY = [
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:idcard|identitycard)(?:number|no|code|id|url|uri|file|image|scan|photo|copy|ref|hash|masked|last\d*)?$/,
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:national|government|resident|personal)(?:identity|identification)?(?:id|number)(?:number|no|code|hash|masked|last\d*)?$/,
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:identity|identification)(?:id|number|code)(?:hash|masked|last\d*)?$/,
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:identity|identification)document(?:number|no|code|id|url|uri|file|image|scan|photo|copy|ref|hash|masked|last\d*|expiry|expiration|issuedate|issueplace)?$/,
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:passport|drivers?licen[cs]e|drivinglicen[cs]e)(?:number|no|code|id|url|uri|file|image|scan|photo|copy|document|ref|hash|masked|last\d*|expiry|expiration|expirydate|expirationdate|issuedate|issueplace)?$/,
  /^(?:proof(?:of)?(?:identity|address))(?:document)?(?:number|no|code|id|url|uri|file|image|scan|photo|copy|ref)?$/,
  /^(?:owner|customer|buyer|person|personal|individual)(?:identity|personal)?document(?:number|no|code|id|url|uri|file|image|scan|photo|copy|ref|hash|masked)?$/,
  /^(?:ownershipdocument|birthcertificate|bankstatement)(?:number|no|code|id|url|uri|file|image|scan|photo|copy|ref)?$/,
  /^(?:socialsecuritynumber|ssn|taxpayeridentificationnumber|taxpayerid)$/,
  /^(?:owner|customer|buyer|person|individual|user)(?:id|identifier|number)$/,
  /^(?:owner|customer|buyer|recipient|consignee|person|personal|individual|accountholder)(?:full|real|legal|person|personal){0,2}name$/,
  /^(?:full|real|legal)(?:full|real|legal|person|personal){0,2}name$/,
  /^(?:firstname|middlename|lastname|givenname|familyname|surname|maidenname)$/,
  /^(?:owner|customer|buyer|person|personal|individual)(?:information|info|profile|details|record)$/,
  /^(?:owner|customer|buyer|person|personal|individual|user)?(?:dateofbirth|datebirth|birthdate|birthday|dob)$/,
  /^(?:owner|customer|buyer|person|personal|individual|recipient)(?:home|residential|residence|permanent|mailing|billing|shipping|delivery|street|postal|physical)?address(?:line\d*)?$/,
  /^(?:home|residential|residence|permanent|mailing|billing|shipping|delivery)address(?:line\d*)?$/,
  /^(?:accountholder|beneficiaryname|bankbeneficiaryname|bankdetails|bankingdetails)$/,
  /^(?:owner|customer|buyer|person|personal|individual)?(?:bankaccount|bankcard|creditcard|debitcard|paymentaccount|payoutaccount)(?:number|no|id|holder|holdername|name|owner|ownername|details|information)?$/,
  /^(?:owner|customer|buyer|person|personal|individual)?iban$/,
];
const PRIVATE_PERSONAL_ATTRIBUTE_KEY_CJK = [
  /(?:身份证|身份卡|身份证明|身份文档|证件)(?:号|号码|编号|尾号|照片|图片|扫描件|复印件|文件|链接|地址|哈希|掩码)?$/,
  /(?:护照|驾驶证|驾照)(?:号|号码|编号|尾号|照片|图片|扫描件|复印件|文件|链接|地址|有效期|到期日|签发日期|签发地)?$/,
  /(?:姓名|全名)$/,
  /(?:出生日期|出生年月|生日)$/,
  /(?:住址|家庭住址|家庭地址|居住地址|住宅地址|收货地址|邮寄地址|账单地址)$/,
  /(?:银行账号|银行账户|银行卡号|信用卡号|借记卡号|收款账号|付款账号)$/,
  /(?:个人文档|私人文档|身份文件|身份文档|所有权文件)(?:编号|照片|图片|扫描件|复印件|链接|地址)?$/,
];
const PRIVATE_ATTRIBUTE_TOKEN = /^(?:cost|expense|profit|margin)$/;
const PRIVATE_ATTRIBUTE_KEY_CJK =
  /联系|电话|手机|微信|邮箱|密钥|秘密|令牌|凭据|私密|隐私|采购价|收购价|进货价|成本|费用|利润|毛利|净利|底价|库位|仓位|精确位置|内部备注|内部笔记|员工备注|管理备注/;

/** Deny private or authority-bearing attributes before public projection or ranking. */
export function isSafePublicAttributeKey(key: string): boolean {
  const lower = key.toLocaleLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, "");
  const normalizedCjk = key.replace(/[\s_.-]+/g, "");
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return (
    !PRIVATE_AUTHORITY_ATTRIBUTE_KEY.test(normalized) &&
    !PRIVATE_BUSINESS_ATTRIBUTE_KEY.some((pattern) =>
      pattern.test(normalized),
    ) &&
    !PRIVATE_PERSONAL_ATTRIBUTE_KEY.some((pattern) =>
      pattern.test(normalized),
    ) &&
    !PRIVATE_PERSONAL_ATTRIBUTE_KEY_CJK.some((pattern) =>
      pattern.test(normalizedCjk),
    ) &&
    !tokens.some((token) => PRIVATE_ATTRIBUTE_TOKEN.test(token)) &&
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
