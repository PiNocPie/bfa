import { BfaError } from "./errors.js";
import { microsToUsd, usdToMicros } from "./money.js";
import type { Category, Health, Quote, RegistryEntry, Routing } from "./types.js";

/** Prior used until a listing has enough samples, so new listings are neither favoured nor buried. */
export const HEALTH_PRIOR: Health = { success_rate: 0.9, p50_ms: 3000, empty_paid_rate: 0, samples: 0 };
const MIN_SAMPLES = 20;

export interface HealthSource {
  get(listingId: string): Health | undefined;
}

export class InMemoryHealth implements HealthSource {
  private readonly stats = new Map<string, Health>();
  get(id: string): Health | undefined {
    return this.stats.get(id);
  }
  set(id: string, h: Health): void {
    this.stats.set(id, h);
  }
}

export interface DiscoverOptions {
  category?: Category;
  /** Include listings that are pending/suspended (marked routable=false). Default false. */
  includeNotRoutable?: boolean;
  limit?: number;
}

export interface DiscoverHit {
  id: string;
  name: string;
  provider: string;
  description: string;
  categories: Category[];
  price_usd: string;
  networks: string[];
  routable: boolean;
  not_routable_reason?: string;
  relevance: number;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

/** Keyword search over the registry. Free: discovering never costs the agent anything. */
export function discover(entries: RegistryEntry[], query: string, opts: DiscoverOptions = {}): DiscoverHit[] {
  const q = tokens(query);
  const hits: DiscoverHit[] = [];
  for (const e of entries) {
    if (!e.routable && !opts.includeNotRoutable) continue;
    const l = e.listing;
    if (opts.category && !l.categories.includes(opts.category)) continue;
    const hay = {
      strong: new Set([...tokens(l.name), ...(l.tags ?? []).flatMap(tokens), ...tokens(l.id)]),
      weak: new Set([...tokens(l.description), ...l.categories.flatMap(tokens), ...tokens(l.provider.name)]),
    };
    let relevance = 0;
    for (const t of q) {
      if (hay.strong.has(t)) relevance += 2;
      else if (hay.weak.has(t)) relevance += 1;
    }
    if (q.length > 0 && relevance === 0) continue;
    hits.push({
      id: l.id,
      name: l.name,
      provider: l.provider.name,
      description: l.description,
      categories: l.categories,
      price_usd: l.pricing.amount_usd,
      networks: l.payment.networks,
      routable: e.routable,
      ...(e.not_routable_reason && { not_routable_reason: e.not_routable_reason }),
      relevance,
    });
  }
  hits.sort((a, b) => b.relevance - a.relevance || usdCompare(a.price_usd, b.price_usd) || a.id.localeCompare(b.id));
  return hits.slice(0, opts.limit ?? 20);
}

function usdCompare(a: string, b: string): number {
  const d = usdToMicros(a) - usdToMicros(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export interface QuoteOptions {
  /** Refuse anything above this per-call price. */
  maxPriceUsd?: string;
  /** Only listings that accept payment on one of these CAIP-2 networks (the networks the agent's wallet holds USDC on). */
  payerNetworks?: string[];
  /** The caller's route preferences (an API key's routing). Applied after scoring; see `routeRank`. */
  routing?: Routing;
}

/**
 * Where a listing falls in a routing preference list: the index of the first entry that names it (by listing id, or
 * `provider:<name>` for every listing from that provider, case-insensitive), or Infinity when no entry does.
 */
export function routeRank(listing: { id: string; provider: string | { name: string } }, routing: Routing | undefined): number {
  if (!routing?.prefer.length) return Infinity;
  const provider = (typeof listing.provider === "string" ? listing.provider : listing.provider.name).trim().toLowerCase();
  const i = routing.prefer.findIndex((p) =>
    p.startsWith("provider:") ? p.slice("provider:".length).trim().toLowerCase() === provider : p === listing.id,
  );
  return i < 0 ? Infinity : i;
}

function effectiveHealth(h: Health | undefined): Health {
  if (!h || h.samples < MIN_SAMPLES) {
    if (!h) return HEALTH_PRIOR;
    // Blend observed stats with the prior while samples are few.
    const w = h.samples / MIN_SAMPLES;
    return {
      success_rate: w * h.success_rate + (1 - w) * HEALTH_PRIOR.success_rate,
      p50_ms: w * h.p50_ms + (1 - w) * HEALTH_PRIOR.p50_ms,
      empty_paid_rate: w * h.empty_paid_rate,
      samples: h.samples,
    };
  }
  return h;
}

/**
 * Rank interchangeable listings (e.g. every "web scrape" endpoint) and return the best one plus ordered fallbacks.
 * Score weights: reliability 45%, price 25%, latency 20%, honest billing 10%.
 */
export function quote(candidates: RegistryEntry[], health: HealthSource, opts: QuoteOptions = {}): Quote {
  const routable = candidates.filter((e) => e.routable);
  if (routable.length === 0) {
    const reason = candidates[0]?.not_routable_reason;
    throw new BfaError({
      code: candidates.length ? "listing_not_routable" : "no_matching_listing",
      message: candidates.length ? `no routable listing (${reason ?? "not reviewed"})` : "no listing matches the request",
      next_action: "stop",
    });
  }
  const max = opts.maxPriceUsd !== undefined ? usdToMicros(opts.maxPriceUsd) : undefined;
  const payable = routable.filter(
    (e) => !opts.payerNetworks || e.listing.payment.networks.some((n) => opts.payerNetworks!.includes(n)),
  );
  if (payable.length === 0) {
    throw new BfaError({
      code: "no_matching_listing",
      message: `no listing accepts payment on ${opts.payerNetworks?.join(", ")}`,
      next_action: "top_up",
      details: { accepted_networks: [...new Set(routable.flatMap((e) => e.listing.payment.networks))] },
    });
  }
  const affordable = max === undefined ? payable : payable.filter((e) => usdToMicros(e.listing.pricing.amount_usd) <= max);
  if (affordable.length === 0) {
    const cheapest = payable.reduce((a, b) =>
      usdToMicros(a.listing.pricing.amount_usd) <= usdToMicros(b.listing.pricing.amount_usd) ? a : b,
    );
    throw new BfaError({
      code: "over_max_price",
      message: `cheapest matching listing costs $${cheapest.listing.pricing.amount_usd}, above max $${opts.maxPriceUsd}`,
      next_action: "raise_max_price",
      details: { cheapest_listing_id: cheapest.listing.id, cheapest_price_usd: cheapest.listing.pricing.amount_usd },
    });
  }

  const minPrice = affordable.reduce((m, e) => {
    const p = usdToMicros(e.listing.pricing.amount_usd);
    return p < m ? p : m;
  }, usdToMicros(affordable[0]!.listing.pricing.amount_usd));

  const scored = affordable.map((e) => {
    const h = effectiveHealth(health.get(e.listing.id));
    const price = usdToMicros(e.listing.pricing.amount_usd);
    const priceScore = price === 0n ? 1 : Number(minPrice === 0n ? 1n : minPrice) / Number(price);
    const latencyScore = 1 / (1 + h.p50_ms / 2000);
    const billing = (1 - h.empty_paid_rate) - (e.listing.pricing.charges_empty_results ? 0.5 : 0);
    const score = 0.45 * h.success_rate + 0.25 * priceScore + 0.2 * latencyScore + 0.1 * Math.max(0, billing);
    return { e, h, score };
  });
  scored.sort((a, b) => b.score - a.score || a.e.listing.id.localeCompare(b.e.listing.id));

  // Route preferences win over score; score still orders listings the preference ranks equally.
  let routed = scored;
  if (opts.routing?.prefer.length) {
    const rank = new Map(scored.map((s) => [s.e.listing.id, routeRank(s.e.listing, opts.routing)]));
    routed = [...scored].sort((a, b) => rank.get(a.e.listing.id)! - rank.get(b.e.listing.id)!);
    const preferred = routed.filter((s) => rank.get(s.e.listing.id)! < Infinity);
    if (opts.routing.strict && preferred.length) routed = preferred;
  }
  const isPreferred = routeRank(routed[0]!.e.listing, opts.routing) < Infinity;

  const best = routed[0]!;
  const rationale =
    (isPreferred ? "first choice in this key's routing; " : "") +
    `${best.e.listing.provider.name} at $${microsToUsd(usdToMicros(best.e.listing.pricing.amount_usd))}/call, ` +
    `${Math.round(best.h.success_rate * 100)}% success, p50 ${Math.round(best.h.p50_ms)}ms` +
    (best.h.samples < MIN_SAMPLES ? ` (only ${best.h.samples} samples; prior blended in)` : "") +
    (routed.length > 1 ? `; ${routed.length - 1} fallback(s)` : "");

  return {
    listing_id: best.e.listing.id,
    provider: best.e.listing.provider.name,
    price_usd: best.e.listing.pricing.amount_usd,
    networks: best.e.listing.payment.networks,
    score: Number(best.score.toFixed(4)),
    rationale,
    fallbacks: routed.slice(1).map((s) => s.e.listing.id),
  };
}
