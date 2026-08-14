export type WorkspaceRole = "buyer" | "seller" | "platform";

export type Accent = "cactus" | "clay" | "heather" | "oat";

export interface VehicleListing {
  id: string;
  title: string;
  subtitle: string;
  price: string;
  monthly: string;
  mileage: string;
  location: string;
  energy: string;
  year: string;
  matchScore: number;
  accent: Accent;
  reasons: string[];
  trust: string[];
  seller: string;
  response: string;
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
