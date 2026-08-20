const HOSTED_MEDIA_REFERENCE = /^media:\/\/hosted\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface StorefrontPublicationCandidate {
  storeId: string | null;
  storeStatus: string | null;
  storeVisibility: string | null;
  integrationKind: string | null;
  domainMatches: boolean;
  displayName: string;
  attributes: unknown;
  terms: unknown;
  availableHostedMediaIds: string[];
}

export type StorefrontPublicationValidation =
  | { ok: true; hostedMediaIds: string[] }
  | { ok: false; error: string };

/** Validate the canonical fields that every public mall product must have. */
export function validateStorefrontPublication(
  candidate: StorefrontPublicationCandidate,
): StorefrontPublicationValidation {
  if (!candidate.storeId || candidate.storeStatus !== "active" || candidate.storeVisibility !== "public") {
    return { ok: false, error: "商品必须属于一家正在营业的公开店铺" };
  }
  if (!candidate.domainMatches) return { ok: false, error: "商品范围与店铺不一致" };
  if (!candidate.displayName.trim()) return { ok: false, error: "请填写商品名称" };

  const attributes = record(candidate.attributes);
  if (!text(attributes.description)) return { ok: false, error: "请填写商品描述" };
  const availableMedia = new Set(candidate.availableHostedMediaIds.map((id) => id.toLowerCase()));
  const images = Array.isArray(attributes.attachments) ? attributes.attachments : [];
  const hostedMediaIds: string[] = [];
  let hasApprovedImage = false;
  for (const value of images) {
    const attachment = record(value);
    if (attachment.kind !== "image") continue;
    const hosted = typeof attachment.attachment_ref === "string"
      ? HOSTED_MEDIA_REFERENCE.exec(attachment.attachment_ref)
      : null;
    if (hosted && availableMedia.has(hosted[1].toLowerCase())) {
      const hostedMediaId = hosted[1].toLowerCase();
      const claimedPublicUrl = record(attachment.metadata).public_url;
      if (claimedPublicUrl !== undefined && claimedPublicUrl !== `/api/store-media/${hostedMediaId}`) {
        return { ok: false, error: "托管商品图片地址无效，请重新上传" };
      }
      hostedMediaIds.push(hostedMediaId);
      hasApprovedImage = true;
      continue;
    }
    if (candidate.integrationKind !== "hosted" && safeHttpsUrl(record(attachment.metadata).public_url)) {
      hasApprovedImage = true;
    }
  }
  if (!hasApprovedImage) return { ok: false, error: "请上传一张由当前店铺控制的有效商品图片" };

  const terms = record(candidate.terms);
  const amount = unsignedInteger(terms.amount_minor);
  const currency = typeof terms.currency === "string" && /^[A-Z]{3}$/.test(terms.currency)
    ? terms.currency
    : null;
  const scale = Number.isInteger(terms.currency_scale)
    && Number(terms.currency_scale) >= 0
    && Number(terms.currency_scale) <= 18
    ? Number(terms.currency_scale)
    : null;
  if (terms.pricing_mode !== "fixed" || amount === null || amount <= 0n || !currency || scale === null) {
    return { ok: false, error: "请填写有效的固定价格和币种" };
  }
  return { ok: true, hostedMediaIds: [...new Set(hostedMediaIds)] };
}

function safeHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function unsignedInteger(value: unknown): bigint | null {
  if (typeof value === "string" && /^[0-9]{1,38}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
