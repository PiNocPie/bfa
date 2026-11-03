/** A seller's listing manifest (registry/listings/<provider>/<slug>.json). Mirrors listing.schema.json. */
export interface Listing {
  manifest_version: 1;
  id: string;
  provider: { name: string; url: string; contact: string };
  name: string;
  description: string;
  categories: Category[];
  tags?: string[];
  endpoint: {
    url: string;
    method: "GET" | "POST";
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    example_input: Record<string, unknown>;
  };
  pricing: { model: "per_call"; amount_usd: string; charges_empty_results?: boolean };
  payment: {
    protocol: "x402";
    networks: string[];
    payout: { via: "direct" } | { via: "near-intents"; chain: string; token: string; recipient: string };
  };
  data: { sources: string; license_statement: string; terms_url?: string };
}

export type Category =
  | "onchain-data"
  | "market-data"
  | "social"
  | "web"
  | "company"
  | "ai-inference"
  | "near-native"
  | "other";

export type ReviewStatus = "pending" | "reviewed" | "verified-provider" | "suspended" | "rejected";

/** Written only by the Nen review team (registry/reviews/<provider>/<slug>.json). */
export interface Review {
  id: string;
  status: ReviewStatus;
  manifest_sha256: string;
  reviewer: string;
  reviewed_at: string;
  notes?: string;
  bot_report_url?: string;
}

export interface RegistryEntry {
  listing: Listing;
  review: Review | null;
  /** sha256 of the manifest file bytes on disk. */
  manifest_sha256: string;
  /** Routable = review status is reviewed/verified-provider AND the review hash matches the current manifest. */
  routable: boolean;
  /** Why the entry is not routable, for agents and reviewers. */
  not_routable_reason?: string;
}

/** Rolling health stats per listing, fed by probes and by receipts. */
export interface Health {
  /** 0..1 share of successful calls/probes over the window. */
  success_rate: number;
  /** Median latency in ms over the window. */
  p50_ms: number;
  /** Share of paid calls that returned an empty result. */
  empty_paid_rate: number;
  samples: number;
}

export interface Quote {
  listing_id: string;
  provider: string;
  price_usd: string;
  networks: string[];
  score: number;
  /** Why this listing ranked where it did, in plain words an agent can log. */
  rationale: string;
  /** Listing ids to try next, in order, if this one fails. */
  fallbacks: string[];
}

export type ReceiptStatus = "paid_ok" | "paid_empty" | "paid_error" | "unpaid_error" | "dry_run";

/** One machine-readable receipt per call. Agents should store these; Nen appends them to a JSONL log. */
export interface Receipt {
  receipt_version: 1;
  receipt_id: string;
  idempotency_key: string;
  listing_id: string;
  provider: string;
  endpoint_url: string;
  status: ReceiptStatus;
  price_usd: string;
  /** CAIP-2 network the payment settled on, when paid. */
  network?: string;
  /** Settlement transaction hash reported by the seller/facilitator, when available. */
  payment_tx?: string;
  payer?: string;
  http_status?: number;
  latency_ms: number;
  started_at: string;
  error?: NenErrorShape;
}

export type NenErrorCode =
  | "no_matching_listing"
  | "over_max_price"
  | "over_daily_budget"
  | "listing_not_routable"
  | "invalid_input"
  | "provider_error"
  | "provider_rate_limited"
  | "payment_failed"
  | "payment_required_unparseable"
  | "signer_unavailable"
  | "top_up_needed";

/** Every error tells the agent what to do next. */
export interface NenErrorShape {
  code: NenErrorCode;
  message: string;
  next_action: "retry" | "retry_after" | "use_fallback" | "raise_max_price" | "top_up" | "fix_input" | "stop";
  retry_after_s?: number;
  fallback_listing_id?: string;
  details?: Record<string, unknown>;
}
