import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BfaError } from "./errors.js";
import { microsToUsd, usdToMicros, type Micros } from "./money.js";
import type { Receipt } from "./types.js";

export function newReceiptId(): string {
  return `rcpt_${randomUUID()}`;
}

const CHARGED: ReadonlySet<Receipt["status"]> = new Set(["paid_ok", "paid_empty", "paid_error"]);

/** Statuses where money moved: these count toward caps and limits, and make an idempotency key final. */
export function isCharged(r: Pick<Receipt, "status">): boolean {
  return CHARGED.has(r.status);
}

/** Start of the UTC day containing `now`, in ms since the epoch. */
export function utcDayStart(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** The next 00:00 UTC after `now`, when daily caps and limits reset. */
export function nextUtcMidnight(now = new Date()): Date {
  return new Date(utcDayStart(now) + 86_400_000);
}

/** Narrows a receipt read to one gateway key and/or a start time. */
export interface ReceiptFilter {
  key_id?: string;
  /** Only receipts with started_at at or after this time. */
  since?: Date;
}

/**
 * Where receipts live. `ReceiptLog` (a JSONL file) is the default; the hosted gateway can plug in a database.
 * Implementations must be append-only: a receipt is never edited after it is written.
 */
export interface ReceiptStore {
  append(r: Receipt): Promise<void>;
  /** Matching receipts, oldest first. Database stores may cap an unfiltered read to a recent window. */
  all(filter?: ReceiptFilter): Promise<Receipt[]>;
  /** The charged receipt written under this idempotency key, if any (scoped to `filter.key_id` when given). */
  findByIdempotencyKey(key: string, filter?: Pick<ReceiptFilter, "key_id">): Promise<Receipt | undefined>;
  /** Total charged since the start of the current UTC day (for one key when `filter.key_id` is given). */
  spentTodayMicros(now?: Date, filter?: Pick<ReceiptFilter, "key_id">): Promise<Micros>;
}

function matches(r: Receipt, f: ReceiptFilter | undefined): boolean {
  if (!f) return true;
  if (f.key_id !== undefined && r.key_id !== f.key_id) return false;
  if (f.since !== undefined && Date.parse(r.started_at) < f.since.getTime()) return false;
  return true;
}

/** Append-only JSONL receipt log. One line per call; the agent's own audit trail. */
export class ReceiptLog implements ReceiptStore {
  constructor(private readonly path: string) {}

  async append(r: Receipt): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(r) + "\n", "utf8");
  }

  async all(filter?: ReceiptFilter): Promise<Receipt[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Receipt)
      .filter((r) => matches(r, filter));
  }

  async findByIdempotencyKey(key: string, filter?: Pick<ReceiptFilter, "key_id">): Promise<Receipt | undefined> {
    return (await this.all(filter)).find((r) => r.idempotency_key === key && CHARGED.has(r.status));
  }

  /** Total charged since the start of the current UTC day. */
  async spentTodayMicros(now = new Date(), filter?: Pick<ReceiptFilter, "key_id">): Promise<Micros> {
    const dayStart = utcDayStart(now);
    let total = 0n;
    for (const r of await this.all(filter)) {
      if (CHARGED.has(r.status) && Date.parse(r.started_at) >= dayStart) total += usdToMicros(r.price_usd);
    }
    return total;
  }
}

/** Throws a typed error if paying `priceUsd` would cross the agent's daily cap. */
export async function assertWithinDailyBudget(log: ReceiptStore, priceUsd: string, dailyCapUsd: string | undefined): Promise<void> {
  if (dailyCapUsd === undefined) return;
  const spent = await log.spentTodayMicros();
  const cap = usdToMicros(dailyCapUsd);
  const price = usdToMicros(priceUsd);
  if (spent + price > cap) {
    throw new BfaError({
      code: "over_daily_budget",
      message: `paying $${priceUsd} would exceed the daily cap of $${dailyCapUsd} (spent $${microsToUsd(spent)} today)`,
      next_action: "stop",
      details: { spent_today_usd: microsToUsd(spent), daily_cap_usd: dailyCapUsd },
    });
  }
}
