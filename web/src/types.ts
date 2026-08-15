export type WorkspaceRole = "buyer" | "seller" | "platform" | "subplatform_admin";

export type Accent = "cactus" | "clay" | "heather" | "oat";

/** Root-facing listing shape. Subplatforms map their domain fields into this view model. */
export interface AssetListing {
  id: string;
  title: string;
  subtitle: string;
  price: string;
  priceLabel?: string;
  location?: string;
  matchScore?: number;
  accent: Accent;
  facts: Array<{ label: string; value: string }>;
  reasons?: string[];
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
