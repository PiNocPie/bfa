import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NenError } from "./errors.js";
import { microsToUsd, usdToMicros, type Micros } from "./money.js";
import type { Receipt } from "./types.js";

export function newReceiptId(): string {
  return `rcpt_${randomUUID()}`;
}

const CHARGED: ReadonlySet<Receipt["status"]> = new Set(["paid_ok", "paid_empty", "paid_error"]);

/** Append-only JSONL receipt log. One line per call; the agent's own audit trail. */
export class ReceiptLog {
  constructor(private readonly path: string) {}

  async append(r: Receipt): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(r) + "\n", "utf8");
  }

  async all(): Promise<Receipt[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Receipt);
  }

  async findByIdempotencyKey(key: string): Promise<Receipt | undefined> {
    return (await this.all()).find((r) => r.idempotency_key === key && CHARGED.has(r.status));
  }

  /** Total charged since the start of the current UTC day. */
  async spentTodayMicros(now = new Date()): Promise<Micros> {
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let total = 0n;
    for (const r of await this.all()) {
      if (CHARGED.has(r.status) && Date.parse(r.started_at) >= dayStart) total += usdToMicros(r.price_usd);
    }
    return total;
  }
}

/** Throws a typed error if paying `priceUsd` would cross the agent's daily cap. */
export async function assertWithinDailyBudget(log: ReceiptLog, priceUsd: string, dailyCapUsd: string | undefined): Promise<void> {
  if (dailyCapUsd === undefined) return;
  const spent = await log.spentTodayMicros();
  const cap = usdToMicros(dailyCapUsd);
  const price = usdToMicros(priceUsd);
  if (spent + price > cap) {
    throw new NenError({
      code: "over_daily_budget",
      message: `paying $${priceUsd} would exceed the daily cap of $${dailyCapUsd} (spent $${microsToUsd(spent)} today)`,
      next_action: "stop",
      details: { spent_today_usd: microsToUsd(spent), daily_cap_usd: dailyCapUsd },
    });
  }
}
