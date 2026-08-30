export type WorkspaceRole =
  | "buyer"
  | "seller"
  | "platform"
  | "subplatform_admin";

export type Accent = "cactus" | "clay" | "heather" | "oat";

/** Root-facing listing shape. Subplatforms map their domain fields into this view model. */
export interface AssetListing {
  id: string;
  /** Scope returned by the selected platform node; contact actions must use it. */
  tenantId?: string;
  domainId?: string;
  platformPath?: string;
  subplatform?: string;
  /** Generic marketplace offer identity when this result is not a legacy listing. */
  offerId?: string;
  /** Demand intent identity used to record a generic introduction. */
  intentId?: string;
  title: string;
  subtitle: string;
  description?: string;
  imageUrl?: string;
  imageUrls?: string[];
  storeId?: string;
  storeName?: string;
  likeTotal?: string;
  viewerLikeCount?: number;
  price: string;
  /** Exact canonical price used for deterministic comparison and basket calculations. */
  priceAmountMinor?: string;
  priceCurrency?: string;
  priceCurrencyScale?: number;
  priceLabel?: string;
  location?: string;
  matchScore?: number;
  accent: Accent;
  facts: Array<{ label: string; value: string; key?: string }>;
  /** Verified deterministic matcher evidence. */
  reasons?: string[];
  risks?: string[];
  /** Advisory explanations supplied by store retrieval, separate from matcher evidence. */
  providerHints?: string[];
  trust?: string[];
  seller?: string;
  response?: string;
}

export interface GatewaySummary {
  name: string;
  kind: string;
  methods: string;
  status: "healthy" | "attention" | "reserved";
}

export interface ActivityItem {
  title: string;
  detail: string;
  time: string;
  tone: "success" | "warning" | "neutral";
}
