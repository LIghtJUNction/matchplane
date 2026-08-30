export const MAX_PUBLIC_MATCH_REASONS = 8;
export const MAX_PUBLIC_MATCH_REASON_CHARACTERS = 500;

const PRIVATE_ATTRIBUTE_KEY =
  /accesskey|apikey|authorization|bearer|contact|cookie|credential|email|manifest|oauth|password|phone|private|providerhint|secret|session|supplyparty|terms|token|wechat/;
const PRIVATE_ATTRIBUTE_KEY_CJK =
  /联系|电话|手机|微信|邮箱|密钥|秘密|令牌|清单/;

/** Deny private or authority-bearing attributes before public projection or ranking. */
export function isSafePublicAttributeKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  return (
    !PRIVATE_ATTRIBUTE_KEY.test(normalized) &&
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
