import type { AssetListing } from "../types";

interface WebMcpToolExecuteOptions {
  readonly signal: AbortSignal;
}

export interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly untrustedContentHint?: boolean;
  };
  execute(
    input: unknown,
    options?: WebMcpToolExecuteOptions,
  ): Promise<MarketplaceWebMcpOutcome>;
}

export interface WebMcpModelContext {
  registerTool(
    tool: WebMcpTool,
    options: { readonly signal: AbortSignal },
  ): Promise<void>;
}

declare global {
  interface Document {
    /** Early-preview WebMCP producer API; absent in unsupported browsers. */
    readonly modelContext?: WebMcpModelContext;
  }
}

export const MARKETPLACE_WEBMCP_SCHEMAS = {
  describeNeed: {
    type: "object",
    additionalProperties: false,
    required: ["narrative"],
    properties: {
      narrative: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
        description:
          "A public, domain-neutral description of what the user wants to find.",
      },
    },
  },
  openStore: {
    type: "object",
    additionalProperties: false,
    required: ["platform_path"],
    properties: {
      platform_path: {
        type: "string",
        pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)$",
        maxLength: 512,
        description:
          "The path of a store shown by the filtered listings, search trace, or store directory.",
      },
    },
  },
  openListing: {
    type: "object",
    additionalProperties: false,
    required: ["listing_id"],
    properties: {
      listing_id: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description:
          "The public ID of a listing shown by the active category filter.",
      },
    },
  },
} as const;

export const MARKETPLACE_WEBMCP_METADATA = {
  describeNeed: {
    name: "matchplane.describe_need",
    description:
      "Place a bounded public marketplace need in the visible shopping composer for the user to review and submit.",
  },
  openStore: {
    name: "matchplane.open_store",
    description:
      "Open a public store shown by a filtered listing, visible search trace, or loaded StorefrontDirectory entry.",
  },
  openListing: {
    name: "matchplane.open_listing",
    description:
      "Open the detail view for a public listing shown by the active category filter.",
  },
} as const;

export interface MarketplaceWebMcpContext {
  readonly visibleListings: readonly AssetListing[];
  readonly visibleStorePaths: readonly string[];
  readonly describeNeed: (narrative: string) => void | Promise<void>;
  readonly openStore: (platformPath: string) => void | Promise<void>;
  readonly openListing: (listing: AssetListing) => void | Promise<void>;
}

export interface MarketplaceWebMcpAvailability {
  readonly stores: boolean;
  readonly listings: boolean;
}

type MarketplaceWebMcpOutcome =
  | {
      readonly ok: true;
      readonly action: "need_drafted";
      readonly character_count: number;
      readonly requires_user_submit: true;
    }
  | {
      readonly ok: true;
      readonly action: "store_opened";
      readonly platform_path: string;
    }
  | {
      readonly ok: true;
      readonly action: "listing_opened";
      readonly listing_id: string;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_input" | "not_visible";
        readonly message: string;
      };
    };

const PLATFORM_PATH_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)$/;

export function createMarketplaceWebMcpTools(
  current: () => MarketplaceWebMcpContext,
  availability: MarketplaceWebMcpAvailability = {
    stores: true,
    listings: true,
  },
): WebMcpTool[] {
  const tools: WebMcpTool[] = [
    {
      ...MARKETPLACE_WEBMCP_METADATA.describeNeed,
      inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.describeNeed,
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const narrative = strictString(input, "narrative", 2_000);
        if (!narrative)
          return invalidInput("narrative must contain 1..2000 characters");
        await current().describeNeed(narrative.value);
        return {
          ok: true,
          action: "need_drafted",
          character_count: narrative.scalarLength,
          requires_user_submit: true,
        };
      },
    },
  ];

  if (availability.stores) {
    tools.push({
      ...MARKETPLACE_WEBMCP_METADATA.openStore,
      inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.openStore,
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const platformPath = strictString(input, "platform_path", 512);
        if (!platformPath || !PLATFORM_PATH_PATTERN.test(platformPath.value)) {
          return invalidInput(
            "platform_path must be a normalized child store path",
          );
        }
        const snapshot = current();
        if (!snapshot.visibleStorePaths.includes(platformPath.value)) {
          return notVisible(
            "The requested store is not shown by a filtered listing, search trace, or store directory.",
          );
        }
        await snapshot.openStore(platformPath.value);
        return {
          ok: true,
          action: "store_opened",
          platform_path: platformPath.value,
        };
      },
    });
  }

  if (availability.listings) {
    tools.push({
      ...MARKETPLACE_WEBMCP_METADATA.openListing,
      inputSchema: MARKETPLACE_WEBMCP_SCHEMAS.openListing,
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        const listingId = strictString(input, "listing_id", 256);
        if (!listingId)
          return invalidInput("listing_id must contain 1..256 characters");
        const snapshot = current();
        const listing = snapshot.visibleListings.find(
          (item) => item.id === listingId.value,
        );
        if (!listing) {
          return notVisible(
            "The requested listing is hidden by the current category filter or absent from the visible results.",
          );
        }
        await snapshot.openListing(listing);
        return {
          ok: true,
          action: "listing_opened",
          listing_id: listingId.value,
        };
      },
    });
  }

  return tools;
}

function strictString(
  input: unknown,
  key: string,
  maxLength: number,
): { readonly value: string; readonly scalarLength: number } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !(key in record)) return null;
  const value = record[key];
  if (typeof value !== "string" || scalarLength(value, maxLength) === null)
    return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const trimmedLength = scalarLength(trimmed, maxLength);
  return trimmedLength === null
    ? null
    : { value: trimmed, scalarLength: trimmedLength };
}

function scalarLength(value: string, maxLength: number): number | null {
  let count = 0;
  for (const _scalar of value) {
    count += 1;
    if (count > maxLength) return null;
  }
  return count;
}

function invalidInput(message: string): MarketplaceWebMcpOutcome {
  return { ok: false, error: { code: "invalid_input", message } };
}

function notVisible(message: string): MarketplaceWebMcpOutcome {
  return { ok: false, error: { code: "not_visible", message } };
}
