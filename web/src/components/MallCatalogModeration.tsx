"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Image as ImageIcon, RefreshCw } from "lucide-react";

import {
  activateMarketplaceOffer,
  getMarketplaceOfferAdminRecords,
  type MarketplaceOfferAdminRecord,
} from "../api";

export function MallCatalogModeration({ onNotice }: { onNotice: (message: string) => void }) {
  const [offers, setOffers] = useState<MarketplaceOfferAdminRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setOffers(await getMarketplaceOfferAdminRecords({ status: "draft", limit: 50 }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "待审核商品读取失败");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = async (offer: MarketplaceOfferAdminRecord) => {
    if (approving) return;
    setApproving(offer.offer_id);
    try {
      const activated = await activateMarketplaceOffer({ offerId: offer.offer_id, tenantId: offer.tenant_id });
      setOffers((current) => current.filter((candidate) => candidate.offer_id !== offer.offer_id));
      onNotice(activated.catalog_sync?.synced === false
        ? `商品已发布；外部店铺目录稍后重试同步：${activated.catalog_sync.error ?? "暂时不可用"}`
        : "商品已通过审核并进入公开目录");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "商品审核失败");
    } finally {
      setApproving(null);
    }
  };

  return (
    <section className="mall-catalog-moderation" aria-labelledby="mall-catalog-moderation-title">
      <div className="mall-catalog-moderation-heading">
        <div>
          <span>商品目录</span>
          <h3 id="mall-catalog-moderation-title">待审核商品</h3>
          <p>确认名称、图片、描述和价格后再公开给顾客与 AI 导购。</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新待审核商品">
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

      {offers.length ? (
        <ul className="mall-catalog-moderation-list">
          {offers.map((offer) => (
            <li key={offer.offer_id}>
              <div className="mall-catalog-product-image">
                {offer.image_url ? <img src={offer.image_url} alt="" /> : <ImageIcon size={20} aria-hidden="true" />}
              </div>
              <div className="mall-catalog-product-copy">
                <span>{offer.store_name || "未命名店铺"}</span>
                <strong>{offer.display_name}</strong>
                <p>{offer.description || "没有填写商品描述"}</p>
              </div>
              <div className="mall-catalog-product-action">
                <strong>{formatPrice(offer)}</strong>
                <button
                  type="button"
                  disabled={Boolean(approving) || !isReadyForPublication(offer)}
                  title={isReadyForPublication(offer) ? undefined : "补齐店铺、图片、描述和有效价格后才能发布"}
                  onClick={() => void approve(offer)}
                >
                  <Check size={16} aria-hidden="true" />
                  {approving === offer.offer_id ? "发布中…" : "通过并发布"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mall-catalog-moderation-empty">{loading ? "正在读取待审核商品…" : "目前没有待审核商品。"}</p>
      )}
    </section>
  );
}

function isReadyForPublication(offer: MarketplaceOfferAdminRecord): boolean {
  return Boolean(
    offer.store_id
    && offer.description
    && offer.image_url
    && offer.amount_minor
    && /^[0-9]{1,38}$/.test(offer.amount_minor)
    && BigInt(offer.amount_minor) > 0n
    && offer.currency
    && offer.currency_scale !== null
    && offer.currency_scale !== undefined,
  );
}

function formatPrice(offer: MarketplaceOfferAdminRecord): string {
  if (!offer.amount_minor || !offer.currency || offer.currency_scale === null || offer.currency_scale === undefined) return "价格待确认";
  const scale = Math.max(0, Math.min(18, offer.currency_scale));
  const padded = offer.amount_minor.padStart(scale + 1, "0");
  const value = scale ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}` : padded;
  return `${offer.currency} ${value}`;
}
