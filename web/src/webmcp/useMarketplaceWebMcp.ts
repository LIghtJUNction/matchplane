import { useEffect, useRef } from "react";

import type { AssetListing } from "../types";
import {
  createMarketplaceWebMcpTools,
  type MarketplaceWebMcpContext,
} from "./marketplace-tools";
import { registerWebMcpTools } from "./register-tools";

interface UseMarketplaceWebMcpOptions {
  readonly enabled: boolean;
  /** Changes whenever the owning route/page context changes. */
  readonly scopeKey: string;
  readonly visibleListings: readonly AssetListing[];
  readonly visibleStorePaths: readonly string[];
  readonly describeNeed: (narrative: string) => void | Promise<void>;
  readonly openStore: (platformPath: string) => void | Promise<void>;
  readonly openListing: (listing: AssetListing) => void | Promise<void>;
}

/** Progressive enhancement for the current root marketplace page. */
export function useMarketplaceWebMcp(
  options: UseMarketplaceWebMcpOptions,
): void {
  const current = useRef<MarketplaceWebMcpContext>(options);
  current.current = options;

  const hasStores = options.visibleStorePaths.length > 0;
  const hasListings = options.visibleListings.length > 0;

  useEffect(() => {
    if (!options.enabled) return undefined;

    const tools = createMarketplaceWebMcpTools(() => current.current, {
      stores: hasStores,
      listings: hasListings,
    });
    return registerWebMcpTools(tools);
  }, [hasListings, hasStores, options.enabled, options.scopeKey]);
}
