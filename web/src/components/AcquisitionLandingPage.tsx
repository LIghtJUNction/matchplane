import type {
  AcquisitionLanding,
} from "../lib/acquisition-landing";
import type {
  PublicStoreOfferDetailField,
  PublicStoreOfferDetailPrice,
} from "../storefront-search";

import styles from "./AcquisitionLandingPage.module.css";

interface AcquisitionLandingPageProps {
  landing: AcquisitionLanding;
}

export function AcquisitionLandingPage({
  landing,
}: AcquisitionLandingPageProps) {
  const fieldGroups = groupFields(landing.fields);
  const location = landing.fields.find((field) => field.key === "location");

  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#offer-detail">
        跳到商品详情
      </a>

      <header className={styles.header}>
        <a className={styles.storeBrand} href={landing.storeHref}>
          {landing.store.name}
        </a>
        <span>由 MatchPlane 安全接续</span>
      </header>

      <div className={styles.content}>
        <section className={styles.continuity} aria-label="访问来源">
          <strong>已接上刚才的推荐</strong>
          <p>你可以先核对商品详情，再到店铺继续查看。</p>
        </section>

        <article className={styles.product} id="offer-detail">
          <div
            className={styles.media}
            data-empty={landing.media.length === 0 ? "true" : undefined}
          >
            {landing.media.length ? (
              <div
                className={styles.mediaGrid}
                data-count={String(landing.media.length)}
              >
                {landing.media.map((item, index) => (
                  <img
                    alt={`${landing.displayName} · 商品图片 ${index + 1}`}
                    className={styles.productImage}
                    decoding="async"
                    key={`${item.url}-${index}`}
                    loading={index === 0 ? "eager" : "lazy"}
                    referrerPolicy="no-referrer"
                    src={item.url}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.mediaEmpty} role="img" aria-label="暂无商品图片">
                <strong>图片待补充</strong>
                <p>暂无商品图片</p>
              </div>
            )}
          </div>

          <div className={styles.summary}>
            <div className={styles.lifecycle}>
              <span className={styles.status}>
                <i aria-hidden="true" />
                在售
              </span>
              {landing.updatedAt ? (
                <time dateTime={landing.updatedAt}>
                  更新于 {formatUpdatedAt(landing.updatedAt)}
                </time>
              ) : (
                <span>最近更新</span>
              )}
            </div>

            <h1>{landing.displayName}</h1>
            <p className={styles.price}>{formatPrice(landing.price)}</p>

            {location ? (
              <p className={styles.location}>
                <span>{location.label}</span>
                {formatFieldValue(location)}
              </p>
            ) : null}

            {landing.description ? (
              <p className={styles.description}>{landing.description}</p>
            ) : (
              <p className={styles.description}>商品说明请以店铺页面为准。</p>
            )}

            <nav className={styles.actions} aria-label="商品操作">
              <a className={styles.primaryLink} href={landing.primaryHref}>
                到店铺继续查看
              </a>
              <a className={styles.secondaryLink} href={landing.storeHref}>
                返回店铺
              </a>
            </nav>
          </div>
        </article>

        {fieldGroups.length ? (
          <section className={styles.details} aria-labelledby="offer-fields-heading">
            <div className={styles.sectionHeading}>
              <h2 id="offer-fields-heading">商品详情</h2>
              <p>以下信息由店铺当前商品模板提供。</p>
            </div>
            <div className={styles.fieldGroups}>
              {fieldGroups.map((group) => (
                <section className={styles.fieldGroup} key={group.name}>
                  <h3>{group.name}</h3>
                  <dl>
                    {group.fields.map((field) => (
                      <div key={field.key}>
                        <dt>{field.label}</dt>
                        <dd>{formatFieldValue(field)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </section>
        ) : null}

        <section className={styles.merchant} aria-labelledby="merchant-heading">
          <div>
            <h2 id="merchant-heading">{landing.store.name}</h2>
            <p>
              {landing.store.description || "商品信息由商家直接维护。"}
            </p>
          </div>
          <a href={landing.storeHref}>查看店铺</a>
        </section>
      </div>
    </main>
  );
}

interface FieldGroup {
  name: string;
  fields: PublicStoreOfferDetailField[];
}

function groupFields(fields: PublicStoreOfferDetailField[]): FieldGroup[] {
  const groups = new Map<string, PublicStoreOfferDetailField[]>();
  for (const field of fields) {
    const name = field.group ?? "商品信息";
    const values = groups.get(name) ?? [];
    values.push(field);
    groups.set(name, values);
  }
  return [...groups].map(([name, values]) => ({ name, fields: values }));
}

function formatFieldValue(field: PublicStoreOfferDetailField): string {
  const value =
    typeof field.value === "number"
      ? new Intl.NumberFormat("zh-CN").format(field.value)
      : field.value;
  return field.unit ? `${value} ${field.unit}` : value;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatPrice(price: PublicStoreOfferDetailPrice | null): string {
  if (!price) return "价格待店铺确认";
  const amountMinor = Number(price.amountMinor);
  const amount = amountMinor / 10 ** price.currencyScale;
  if (Number.isSafeInteger(amountMinor) && Number.isFinite(amount)) {
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: price.currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: price.currencyScale,
        maximumFractionDigits: price.currencyScale,
      }).format(amount);
    } catch {
      // Fall through to the bounded currency-code representation below.
    }
  }
  const padded = price.amountMinor.padStart(price.currencyScale + 1, "0");
  const split = padded.length - price.currencyScale;
  const decimal = price.currencyScale
    ? `${padded.slice(0, split)}.${padded.slice(split)}`
    : padded;
  return `${price.currency} ${decimal}`;
}
