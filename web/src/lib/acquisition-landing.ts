import "server-only";

import {
  resolveActiveAcquisitionLink,
  type ResolvedAcquisitionLink,
} from "./acquisition-links";
import {
  readPublicStoreOfferDetail,
  type PublicStoreOfferDetail,
  type PublicStoreOfferDetailLookup,
} from "../storefront-search";

export interface AcquisitionLanding extends PublicStoreOfferDetail {
  primaryHref: string;
  storeHref: string;
}

interface AcquisitionLandingDependencies {
  resolveLink?: (token: string) => Promise<ResolvedAcquisitionLink | null>;
  readOffer?: (
    lookup: PublicStoreOfferDetailLookup,
  ) => Promise<PublicStoreOfferDetail | null>;
}

/**
 * Resolve a private acquisition token into one bounded public landing model.
 * The redirect route owns touchpoint writes; this reader performs no attribution mutation.
 */
export async function loadAcquisitionLanding(
  token: string,
  dependencies: AcquisitionLandingDependencies = {},
): Promise<AcquisitionLanding | null> {
  const resolveLink =
    dependencies.resolveLink ?? resolveActiveAcquisitionLink;
  const readOffer = dependencies.readOffer ?? readPublicStoreOfferDetail;
  const link = await resolveLink(token);
  if (!link) return null;

  const offer = await readOffer({
    tenantId: link.tenantId,
    domainId: link.domainId,
    storeId: link.storeId,
    offerId: link.offerId,
  });
  if (!offer || offer.offerId !== link.offerId) return null;

  return {
    ...offer,
    primaryHref: `${offer.store.path}?offer=${encodeURIComponent(offer.offerId)}`,
    storeHref: offer.store.path,
  };
}
