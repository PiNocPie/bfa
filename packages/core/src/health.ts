import { InMemoryHealth } from "./router.js";
import type { Receipt } from "./types.js";

/**
 * Build per-listing health from an agent's own receipts: success rate, median latency, and how often a paid call
 * came back empty. Dry runs are ignored. This is what makes routing reflect what providers actually delivered.
 */
export function healthFromReceipts(receipts: Receipt[], windowSize = 200): InMemoryHealth {
  const byListing = new Map<string, Receipt[]>();
  for (const r of receipts) {
    if (r.status === "dry_run") continue;
    const list = byListing.get(r.listing_id) ?? [];
    list.push(r);
    byListing.set(r.listing_id, list);
  }
  const health = new InMemoryHealth();
  for (const [id, all] of byListing) {
    const recent = all.slice(-windowSize);
    const ok = recent.filter((r) => r.status === "paid_ok" || r.status === "free_ok").length;
    const paid = recent.filter((r) => r.status.startsWith("paid_"));
    const empty = paid.filter((r) => r.status === "paid_empty").length;
    const latencies = recent.map((r) => r.latency_ms).sort((a, b) => a - b);
    health.set(id, {
      success_rate: ok / recent.length,
      p50_ms: latencies[Math.floor(latencies.length / 2)] ?? 0,
      empty_paid_rate: paid.length ? empty / paid.length : 0,
      samples: recent.length,
    });
  }
  return health;
}
