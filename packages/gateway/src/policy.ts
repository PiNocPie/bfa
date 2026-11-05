import {
  BfaError,
  isCharged,
  microsToUsd,
  nextUtcMidnight,
  routeRank,
  usdToMicros,
  utcDayStart,
  type Listing,
  type Micros,
  type Receipt,
  type ReceiptStore,
} from "@bfa/core";
import type { CallContext, ToolName, ToolPolicy } from "@bfa/mcp/lib";
import { keyAllowsListing, type ApiKeyRecord, type KeyStore, type Scope } from "./keys.js";

/** Scope each tool needs. Tools not listed (discover, inspect, quote, submit_listing) need only a valid key. */
export const TOOL_SCOPE: Partial<Record<ToolName, Scope>> = { run: "run", receipts: "receipts", wallet: "receipts" };

export interface Usage {
  spent: Micros;
  byListing: Map<string, { spent: Micros; calls: number }>;
}

/** One key's charged spend and call counts for the UTC day containing `now`. Other keys and other days are ignored. */
export function usageToday(receipts: Receipt[], keyId: string, now: Date): Usage {
  const start = utcDayStart(now);
  const end = start + 86_400_000;
  const usage: Usage = { spent: 0n, byListing: new Map() };
  for (const r of receipts) {
    if (r.key_id !== keyId || !isCharged(r)) continue;
    const t = Date.parse(r.started_at);
    if (t < start || t >= end) continue;
    const price = usdToMicros(r.price_usd);
    usage.spent += price;
    const l = usage.byListing.get(r.listing_id) ?? { spent: 0n, calls: 0 };
    l.spent += price;
    l.calls += 1;
    usage.byListing.set(r.listing_id, l);
  }
  return usage;
}

/** Revoked, then expired. */
export function assertKeyUsable(key: ApiKeyRecord, now: Date): void {
  if (key.revoked_at !== null) {
    throw new BfaError({ code: "key_revoked", message: `API key ${key.prefix}… was revoked at ${key.revoked_at}`, next_action: "stop" });
  }
  if (Date.parse(key.expires_at) <= now.getTime()) {
    throw new BfaError({ code: "key_expired", message: `API key ${key.prefix}… expired at ${key.expires_at}`, next_action: "stop" });
  }
}

export function assertScope(key: ApiKeyRecord, tool: ToolName): void {
  const need = TOOL_SCOPE[tool];
  if (need && !key.scopes.includes(need)) {
    throw new BfaError({
      code: "scope_missing",
      message: `API key ${key.prefix}… lacks the "${need}" scope needed for ${tool}`,
      next_action: "stop",
      details: { required_scope: need, key_scopes: key.scopes },
    });
  }
}

export function assertListingAllowed(key: ApiKeyRecord, listingId: string, canFallback: boolean): void {
  if (keyAllowsListing(key, listingId)) return;
  throw new BfaError({
    code: "listing_not_allowed",
    message: `API key ${key.prefix}… may not call ${listingId} (listing access: ${key.listing_access.mode})`,
    next_action: canFallback ? "use_fallback" : "stop",
    details: { listing_id: listingId, listing_access: key.listing_access },
  });
}

/** Daily USD cap across all APIs, then the per-API limits for this listing. Throws limit_reached. */
export function assertWithinKeyLimits(key: ApiKeyRecord, listing: Listing, usage: Usage, now: Date): void {
  const price = usdToMicros(listing.pricing.amount_usd);
  const resets_at = nextUtcMidnight(now).toISOString();
  const refuse = (limit: string, message: string, extra: Record<string, unknown>) =>
    new BfaError({
      code: "limit_reached",
      message: `${message}; resets at ${resets_at}`,
      next_action: "stop",
      resets_at,
      details: { limit, listing_id: listing.id, price_usd: listing.pricing.amount_usd, ...extra },
    });

  const cap = usdToMicros(key.daily_limit_usd);
  if (usage.spent + price > cap) {
    throw refuse("daily_usd", `paying $${listing.pricing.amount_usd} would exceed this key's daily limit of $${key.daily_limit_usd}`, {
      limit_value: key.daily_limit_usd,
      used_today: microsToUsd(usage.spent),
    });
  }
  const used = usage.byListing.get(listing.id) ?? { spent: 0n, calls: 0 };
  for (const l of key.per_api_limits) {
    if (l.listing_id !== listing.id) continue;
    if (l.kind === "usd" && used.spent + price > usdToMicros(l.value)) {
      throw refuse("per_api_usd", `paying $${listing.pricing.amount_usd} would exceed this key's $${l.value}/day limit for ${listing.id}`, {
        limit_value: l.value,
        used_today: microsToUsd(used.spent),
      });
    }
    if (l.kind === "calls" && used.calls + 1 > l.value) {
      throw refuse("per_api_calls", `this key's limit of ${l.value} calls/day for ${listing.id} is used up`, {
        limit_value: l.value,
        used_today: used.calls,
      });
    }
  }
}

/** What an agent sees about its own key in receipts and wallet. Never includes the hash. */
export function keyView(key: ApiKeyRecord, usage: Usage, now: Date) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    created_at: key.created_at,
    expires_at: key.expires_at,
    revoked_at: key.revoked_at,
    daily_limit_usd: key.daily_limit_usd,
    per_api_limits: key.per_api_limits,
    listing_access: key.listing_access,
    routing: key.routing ?? { prefer: [], strict: false },
    spent_today_usd: microsToUsd(usage.spent),
    usage_today: Object.fromEntries(
      [...usage.byListing].map(([id, u]) => [id, { spent_usd: microsToUsd(u.spent), calls: u.calls }]),
    ),
    resets_at: nextUtcMidnight(now).toISOString(),
  };
}

/** Runs tasks one at a time. Paid calls share one payer wallet and payment channel, so they are serialized. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface KeyPolicyOptions {
  keyId: string;
  keys: KeyStore;
  receipts: ReceiptStore;
  payQueue: SerialQueue;
  now: () => Date;
}

async function todaysUsage(receipts: ReceiptStore, keyId: string, now: Date): Promise<Usage> {
  return usageToday(await receipts.all({ key_id: keyId, since: new Date(utcDayStart(now)) }), keyId, now);
}

/**
 * The MCP tool policy for one gateway session. Every tool call re-reads the key, so revocations and limit edits
 * apply immediately. Order for `run`: revoked → expired → scope → listing access → daily limit → per-API limits,
 * all before any payment is signed.
 */
export function keyPolicy(o: KeyPolicyOptions): ToolPolicy {
  return {
    around: async (tool, next) => {
      const exec = async () => {
        const key = await o.keys.get(o.keyId);
        if (!key) throw new BfaError({ code: "unauthorized", message: "API key no longer exists", next_action: "stop" });
        const now = o.now();
        assertKeyUsable(key, now);
        assertScope(key, tool);
        const allows = (id: string) => keyAllowsListing(key, id);
        const ctx: CallContext = {
          keyId: key.id,
          allowsListing: allows,
          ...(key.routing?.prefer.length && { routing: key.routing }),
          beforePay: async (listing, info) => {
            const at = o.now();
            assertListingAllowed(key, listing.id, info.fromQuery && info.remaining > 0);
            assertWithinKeyLimits(key, listing, await todaysUsage(o.receipts, key.id, at), at);
          },
        };
        const result = (await next(ctx)) as Record<string, unknown>;
        return decorate(tool, result, key, allows, () => todaysUsage(o.receipts, key.id, o.now()), o.now);
      };
      return tool === "run" ? o.payQueue.run(exec) : exec();
    },
  };
}

async function decorate(
  tool: ToolName,
  r: Record<string, unknown>,
  key: ApiKeyRecord,
  allows: (id: string) => boolean,
  usage: () => Promise<Usage>,
  now: () => Date,
): Promise<unknown> {
  switch (tool) {
    case "discover": {
      // Preferred listings first (stable), so an agent reading top-down picks what its owner chose.
      const hits = (r.hits as { id: string; provider: string }[])
        .map((h, i) => ({ h, i, rank: routeRank(h, key.routing) }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map(({ h, rank }) => ({
          ...h,
          allowed_for_this_key: allows(h.id),
          ...(key.routing?.prefer.length && { preferred_for_this_key: rank < Infinity }),
        }));
      return { ...r, hits, ...(key.routing?.prefer.length && { routing: key.routing }) };
    }
    case "inspect": {
      const id = (r.listing as { id: string }).id;
      return { ...r, allowed_for_this_key: allows(id) };
    }
    case "quote": {
      const fallbacks = r.fallbacks as string[];
      return {
        ...r,
        allowed_for_this_key: allows(r.listing_id as string),
        fallbacks_allowed_for_this_key: fallbacks.filter(allows),
      };
    }
    case "receipts": {
      const u = await usage();
      return { ...r, daily_cap_usd: key.daily_limit_usd, key: keyView(key, u, now()) };
    }
    case "wallet": {
      const u = await usage();
      const limits = r.limits as { daily_cap_usd: string; max_channel_deposit_usd: string };
      return {
        ...r,
        paid_from: "the gateway operator's wallet (shared by every API key in this version)",
        limits: {
          daily_limit_usd: key.daily_limit_usd,
          per_api_limits: key.per_api_limits,
          gateway_daily_cap_usd: limits.daily_cap_usd,
          max_channel_deposit_usd: limits.max_channel_deposit_usd,
        },
        key: keyView(key, u, now()),
      };
    }
    default:
      return r;
  }
}
