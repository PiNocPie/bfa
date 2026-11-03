import { mkdtemp, mkdir, writeFile, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryHealth,
  BfaError,
  ReceiptLog,
  assertWithinDailyBudget,
  discover,
  loadRegistry,
  microsToUsd,
  quote,
  sha256,
  usdToMicros,
  type Listing,
  type Receipt,
} from "./index.js";

const REPO_REGISTRY = resolve(import.meta.dirname, "../../../registry");

function listing(id: string, price: string, overrides: Partial<Listing> = {}): Listing {
  return {
    manifest_version: 1,
    id,
    provider: { name: id.split("/")[0]!, url: "https://example.com", contact: "ops@example.com" },
    name: `Web scrape by ${id.split("/")[0]}`,
    description: "Scrape one web page and return clean markdown for an agent.",
    categories: ["web"],
    tags: ["scrape", "markdown"],
    endpoint: {
      url: "https://example.com/scrape",
      method: "POST",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      example_input: { url: "https://example.com" },
    },
    pricing: { model: "per_call", amount_usd: price },
    payment: { protocol: "x402", networks: ["eip155:8453"], payout: { via: "direct" } },
    data: { sources: "own crawler", license_statement: "We operate the crawler and respect robots.txt." },
    ...overrides,
  };
}

async function tempRegistry(items: { l: Listing; review?: "reviewed" | "suspended" | "stale" }[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bfa-reg-"));
  await cp(join(REPO_REGISTRY, "schema"), join(dir, "schema"), { recursive: true });
  for (const { l, review } of items) {
    const [prov, slug] = l.id.split("/") as [string, string];
    await mkdir(join(dir, "listings", prov), { recursive: true });
    const bytes = JSON.stringify(l, null, 2);
    await writeFile(join(dir, "listings", prov, `${slug}.json`), bytes);
    if (review) {
      await mkdir(join(dir, "reviews", prov), { recursive: true });
      await writeFile(
        join(dir, "reviews", prov, `${slug}.json`),
        JSON.stringify({
          id: l.id,
          status: review === "stale" ? "reviewed" : review,
          manifest_sha256: review === "stale" ? "0".repeat(64) : sha256(bytes),
          reviewer: "bfa-team",
          reviewed_at: "2026-11-03T00:00:00Z",
        }),
      );
    }
  }
  return dir;
}

describe("money", () => {
  it("round-trips sub-cent prices without float drift", () => {
    expect(usdToMicros("0.0007")).toBe(700n);
    expect(usdToMicros("0.05")).toBe(50_000n);
    expect(microsToUsd(700n + 50_000n)).toBe("0.0507");
    expect(() => usdToMicros("0.1234567")).toThrow();
    expect(() => usdToMicros("-1")).toThrow();
  });
});

describe("repo registry", () => {
  it("every committed listing is valid and the seed Nansen listing awaits review", async () => {
    const { entries, problems } = await loadRegistry(REPO_REGISTRY);
    expect(problems).toEqual([]);
    const nansen = entries.find((e) => e.listing.id === "nansen/smart-money-holdings");
    expect(nansen).toBeDefined();
    expect(nansen!.routable).toBe(false);
    expect(nansen!.not_routable_reason).toMatch(/pending review/);
  });
});

describe("review gate", () => {
  it("only reviewed listings whose manifest hash still matches are routable", async () => {
    const dir = await tempRegistry([
      { l: listing("alpha/scrape", "0.001"), review: "reviewed" },
      { l: listing("beta/scrape", "0.001"), review: "suspended" },
      { l: listing("gamma/scrape", "0.001"), review: "stale" },
      { l: listing("delta/scrape", "0.001") },
    ]);
    const { entries, problems } = await loadRegistry(dir);
    expect(problems).toEqual([]);
    const by = Object.fromEntries(entries.map((e) => [e.listing.id, e]));
    expect(by["alpha/scrape"]!.routable).toBe(true);
    expect(by["beta/scrape"]!.not_routable_reason).toBe("review status is suspended");
    expect(by["gamma/scrape"]!.not_routable_reason).toMatch(/changed after review/);
    expect(by["delta/scrape"]!.not_routable_reason).toMatch(/pending review/);
  });

  it("rejects a listing whose id does not match its path, and a pricing model other than PAYG", async () => {
    const dir = await tempRegistry([]);
    await mkdir(join(dir, "listings", "evil"), { recursive: true });
    // An "evil" seller tries to publish under Nansen's id.
    await writeFile(join(dir, "listings", "evil", "holdings.json"), JSON.stringify(listing("nansen/holdings", "0.01")));
    const sub = listing("subs/plan", "10");
    (sub.pricing as { model: string }).model = "subscription";
    await mkdir(join(dir, "listings", "subs"), { recursive: true });
    await writeFile(join(dir, "listings", "subs", "plan.json"), JSON.stringify(sub));
    const { entries, problems } = await loadRegistry(dir);
    expect(entries).toEqual([]);
    expect(problems.map((p) => p.message).join("\n")).toMatch(/must match its path/);
    expect(problems.map((p) => p.message).join("\n")).toMatch(/invalid listing/);
  });
});

describe("router", () => {
  it("discover is keyword-ranked and hides non-routable listings by default", async () => {
    const dir = await tempRegistry([
      { l: listing("alpha/scrape", "0.001"), review: "reviewed" },
      { l: listing("delta/scrape", "0.001") },
    ]);
    const { entries } = await loadRegistry(dir);
    expect(discover(entries, "scrape markdown").map((h) => h.id)).toEqual(["alpha/scrape"]);
    expect(discover(entries, "scrape", { includeNotRoutable: true })).toHaveLength(2);
    expect(discover(entries, "weather")).toEqual([]);
  });

  it("prefers a reliable provider over a cheaper flaky one, and keeps the flaky one as fallback", async () => {
    const dir = await tempRegistry([
      { l: listing("cheap/scrape", "0.0007"), review: "reviewed" },
      { l: listing("solid/scrape", "0.001"), review: "reviewed" },
    ]);
    const { entries } = await loadRegistry(dir);
    const health = new InMemoryHealth();
    health.set("cheap/scrape", { success_rate: 0.4, p50_ms: 12000, empty_paid_rate: 0.2, samples: 200 });
    health.set("solid/scrape", { success_rate: 0.99, p50_ms: 1300, empty_paid_rate: 0, samples: 200 });
    const q = quote(entries, health);
    expect(q.listing_id).toBe("solid/scrape");
    expect(q.fallbacks).toEqual(["cheap/scrape"]);
    expect(q.rationale).toMatch(/99% success/);
  });

  it("returns typed, actionable errors", async () => {
    const dir = await tempRegistry([{ l: listing("pricey/scrape", "0.05"), review: "reviewed" }]);
    const { entries } = await loadRegistry(dir);
    const health = new InMemoryHealth();
    expect(() => quote(entries, health, { maxPriceUsd: "0.01" })).toThrowError(
      expect.objectContaining({ code: "over_max_price", next_action: "raise_max_price" }),
    );
    expect(() => quote(entries, health, { payerNetworks: ["eip155:137"] })).toThrowError(
      expect.objectContaining({ code: "no_matching_listing", next_action: "top_up" }),
    );
    expect(() => quote([], health)).toThrowError(BfaError);
  });
});

describe("receipts and daily budget", () => {
  it("counts only charged calls from today against the cap", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bfa-rcpt-")), "receipts.jsonl");
    const log = new ReceiptLog(path);
    const base: Omit<Receipt, "receipt_id" | "status" | "price_usd" | "idempotency_key"> = {
      receipt_version: 1,
      listing_id: "alpha/scrape",
      provider: "alpha",
      endpoint_url: "https://example.com/scrape",
      latency_ms: 10,
      started_at: new Date().toISOString(),
    };
    await log.append({ ...base, receipt_id: "r1", idempotency_key: "k1", status: "paid_ok", price_usd: "0.04" });
    await log.append({ ...base, receipt_id: "r2", idempotency_key: "k2", status: "unpaid_error", price_usd: "0.04" });
    await log.append({
      ...base,
      receipt_id: "r3",
      idempotency_key: "k3",
      status: "paid_ok",
      price_usd: "5",
      started_at: "2020-01-01T00:00:00Z",
    });
    expect(microsToUsd(await log.spentTodayMicros())).toBe("0.04");
    await expect(assertWithinDailyBudget(log, "0.01", "0.05")).resolves.toBeUndefined();
    await expect(assertWithinDailyBudget(log, "0.02", "0.05")).rejects.toMatchObject({ code: "over_daily_budget" });
    expect((await log.findByIdempotencyKey("k1"))?.receipt_id).toBe("r1");
    expect(await log.findByIdempotencyKey("k2")).toBeUndefined();
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
  });
});
