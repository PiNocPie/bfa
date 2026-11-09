import { Ajv2020 } from "ajv/dist/2020.js";
import { ExactEvmScheme } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  BfaError,
  assertWithinDailyBudget,
  newReceiptId,
  toErrorShape,
  usdToMicros,
  type Listing,
  type Receipt,
  type ReceiptStore,
  type X402Scheme,
} from "@bfa/core";
import type { SessionConfig } from "./session.js";
import type { BfaSigner } from "./signers.js";

/** CAIP-2 ids. Testnet first: Base Sepolia is where BFA's demo seller and test agents run. */
export const NETWORKS = { baseMainnet: "eip155:8453", baseSepolia: "eip155:84532" } as const;

export interface CallOptions {
  listing: Listing;
  input: Record<string, unknown>;
  signer: BfaSigner;
  log: ReceiptStore;
  /** Same key → same receipt, never a second payment. Defaults to a random key (no dedupe). */
  idempotencyKey?: string;
  /** Agent's per-call ceiling. The call is refused before any request if the listing costs more. */
  maxPriceUsd?: string;
  /** Agent's daily ceiling across all providers, enforced from the receipt log. */
  dailyCapUsd?: string;
  /** Enables the batch-settlement fast path (one MPC-signed deposit, then per-call session-key vouchers). */
  session?: SessionConfig;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface CallResult {
  receipt: Receipt;
  data?: unknown;
  /** True when an earlier receipt with the same idempotency key was returned instead of calling again. */
  replayed?: boolean;
}

const ajv = new Ajv2020({ strict: false });
const outputValidators = new Map<string, ReturnType<typeof ajv.compile>>();

function outputValid(listing: Listing, body: unknown): boolean {
  let v = outputValidators.get(listing.id);
  if (!v) {
    v = ajv.compile(listing.endpoint.output_schema);
    outputValidators.set(listing.id, v);
  }
  return v(body) as boolean;
}

function isEmpty(body: unknown): boolean {
  if (body === null || body === undefined || body === "") return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Object.keys(o).length === 0) return true;
    // Common envelope: { data: [] }
    if ("data" in o && Array.isArray(o.data) && o.data.length === 0) return true;
  }
  return false;
}

const DEFAULT_MAX_DEPOSIT_USD = "0.50";

/** Preference order when a seller offers several schemes: the fast path first. */
const SCHEME_RANK: Record<string, number> = { "batch-settlement": 0, exact: 1 };

/**
 * Build a fetch that pays x402 V2 challenges, but only on the listing's declared networks and never above the
 * listed price per call: a seller cannot raise the price between review and call.
 *
 * Without `session`: every call is an `exact` EIP-3009 transfer signed by `signer` (Chain Signatures: ~25s).
 * With `session`: if the seller offers `batch-settlement`, `signer` signs only the channel deposit (capped at
 * `maxDepositUsd`) and the session key signs each call's voucher locally (milliseconds). Falls back to `exact`.
 */
export function payingFetch(
  listing: Listing,
  signer: BfaSigner,
  fetchImpl: typeof fetch = fetch,
  session?: SessionConfig,
): typeof fetch {
  return buildPayingFetch(listing, signer, fetchImpl, session).fetch;
}

function buildPayingFetch(
  listing: Listing,
  signer: BfaSigner,
  fetchImpl: typeof fetch,
  session: SessionConfig | undefined,
): { fetch: typeof fetch; usedScheme: () => X402Scheme | undefined; signMs: () => number | undefined } {
  let used: X402Scheme | undefined;
  let signStart: number | undefined;
  let signMs: number | undefined;
  const maxAtomic = usdToMicros(listing.pricing.amount_usd); // USDC has 6 decimals: atomic units == micro-USD
  const exact = new ExactEvmScheme(signer);
  const client = new x402Client();
  const accepted = listing.payment.schemes ?? ["exact"];
  let batch: BatchSettlementEvmScheme | undefined;
  if (session && accepted.includes("batch-settlement")) {
    const capAtomic = usdToMicros(session.maxDepositUsd ?? DEFAULT_MAX_DEPOSIT_USD);
    batch = new BatchSettlementEvmScheme(signer, {
      voucherSigner: session.signer,
      payerAuthorizer: session.signer.address,
      storage: new FileClientChannelStorage({ directory: session.channelDir }),
      depositStrategy: ({ depositAmount, minimumDepositAmount }) => {
        const min = BigInt(minimumDepositAmount);
        if (min > capAtomic) return false; // seller demands a bigger deposit than the agent allows
        const want = BigInt(depositAmount);
        return (want > capAtomic ? capAtomic : want < min ? min : want).toString();
      },
    });
  }
  for (const network of listing.payment.networks) {
    client.register(network as `${string}:${string}`, exact);
    if (batch) client.register(network as `${string}:${string}`, batch);
  }
  client.registerPolicy((_version, reqs) =>
    reqs
      .filter(
        (r) =>
          listing.payment.networks.includes(r.network) &&
          accepted.includes(r.scheme as never) &&
          (r.scheme !== "batch-settlement" || batch !== undefined) &&
          BigInt(r.amount) <= maxAtomic,
      )
      .sort((a, b) => (SCHEME_RANK[a.scheme] ?? 9) - (SCHEME_RANK[b.scheme] ?? 9)),
  );
  client.onBeforePaymentCreation(async () => {
    signStart = Date.now();
  });
  client.onAfterPaymentCreation(async (ctx) => {
    used = ctx.selectedRequirements.scheme as X402Scheme;
    if (signStart !== undefined) signMs = Date.now() - signStart;
  });
  return {
    fetch: wrapFetchWithPayment(fetchImpl, client) as typeof fetch,
    usedScheme: () => used,
    signMs: () => signMs,
  };
}

function buildRequest(listing: Listing, input: Record<string, unknown>): { url: string; init: RequestInit } {
  if (listing.endpoint.method === "GET") {
    const u = new URL(listing.endpoint.url);
    for (const [k, v] of Object.entries(input)) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return { url: u.toString(), init: { method: "GET", headers: { accept: "application/json" } } };
  }
  return {
    url: listing.endpoint.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
    },
  };
}

function readSettlement(res: Response): { tx?: string; network?: string; payer?: string } | undefined {
  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    const s = decodePaymentResponseHeader(header);
    if (!s.success) return undefined;
    return { tx: s.transaction, network: s.network, ...(s.payer && { payer: s.payer }) };
  } catch {
    return undefined;
  }
}

/** Why the seller (its facilitator) refused a payment, from a 402 reply: PAYMENT-REQUIRED header or JSON body. */
async function refusalReason(res: Response): Promise<string | undefined> {
  const pick = (o: unknown): string | undefined => {
    const r = o as { error?: unknown; invalidReason?: unknown; errorReason?: unknown } | null;
    const v = r?.error ?? r?.invalidReason ?? r?.errorReason;
    return typeof v === "string" && v ? v.slice(0, 160) : undefined;
  };
  // The facilitator's verdict comes back in PAYMENT-RESPONSE (errorReason) or PAYMENT-REQUIRED (error).
  for (const name of ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "PAYMENT-REQUIRED"]) {
    const header = res.headers.get(name);
    if (!header) continue;
    try {
      const why = pick(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
      if (why) return why;
    } catch {
      /* not base64 JSON */
    }
  }
  try {
    return pick(await res.clone().json());
  } catch {
    return undefined;
  }
}

type Outcome = Pick<Receipt, "status" | "price_usd"> &
  Partial<Pick<Receipt, "scheme" | "sign_ms" | "network" | "payment_tx" | "http_status" | "output_valid" | "error">>;

/** Call one listing, pay per call over x402, and always write exactly one receipt. */
export async function callListing(opts: CallOptions): Promise<CallResult> {
  const { listing, log } = opts;
  const idempotency_key = opts.idempotencyKey ?? newReceiptId();

  if (opts.idempotencyKey) {
    const prior = await log.findByIdempotencyKey(opts.idempotencyKey);
    if (prior) return { receipt: prior, replayed: true };
  }

  if (opts.maxPriceUsd !== undefined && usdToMicros(listing.pricing.amount_usd) > usdToMicros(opts.maxPriceUsd)) {
    throw new BfaError({
      code: "over_max_price",
      message: `${listing.id} costs $${listing.pricing.amount_usd}, above max $${opts.maxPriceUsd}`,
      next_action: "raise_max_price",
    });
  }
  await assertWithinDailyBudget(log, listing.pricing.amount_usd, opts.dailyCapUsd);

  const started = new Date();
  const base: Omit<Receipt, "status" | "price_usd" | "latency_ms"> = {
    receipt_version: 1,
    receipt_id: newReceiptId(),
    idempotency_key,
    listing_id: listing.id,
    provider: listing.provider.name,
    endpoint_url: listing.endpoint.url,
    payer: opts.signer.address,
    started_at: started.toISOString(),
  };
  const finish = async (r: Outcome, data?: unknown): Promise<CallResult> => {
    const receipt: Receipt = { ...base, ...r, latency_ms: Date.now() - started.getTime() } as Receipt;
    await log.append(receipt);
    return { receipt, ...(data !== undefined && { data }) };
  };

  const { url, init } = buildRequest(listing, opts.input);
  const paying = buildPayingFetch(listing, opts.signer, opts.fetchImpl ?? fetch, opts.session);
  let res: Response;
  try {
    res = await paying.fetch(url, init);
  } catch (e) {
    // The treasury contract refused on policy (daily limit, recipient, token, paused): stop, don't fall back.
    const refusal = /treasury refused: ([a-z_]+)/.exec(String((e as Error)?.message ?? e));
    if (refusal) {
      return finish({
        status: "unpaid_error",
        price_usd: "0",
        error: { code: "treasury_refused", message: `the on-chain vault policy refused this payment: ${refusal[1]}`, next_action: "stop", details: { reason: refusal[1] } },
      });
    }
    return finish({
      status: "unpaid_error",
      price_usd: "0",
      error: { ...toErrorShape(e), code: "payment_failed", next_action: "use_fallback" },
    });
  }

  const settled = readSettlement(res);
  const price_usd = settled ? listing.pricing.amount_usd : "0";
  const scheme = paying.usedScheme();
  const signMs = paying.signMs();
  const paidFields = settled
    ? {
        ...(scheme && { scheme }),
        ...(signMs !== undefined && { sign_ms: signMs }),
        ...(settled.tx && { payment_tx: settled.tx }),
        ...(settled.network && { network: settled.network }),
      }
    : {};

  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "1");
    return finish({
      status: settled ? "paid_error" : "unpaid_error",
      price_usd,
      ...paidFields,
      http_status: 429,
      error: { code: "provider_rate_limited", message: "provider rate limit", next_action: "retry_after", retry_after_s: Number.isFinite(retry) ? retry : 1 },
    });
  }
  if (res.status === 402) {
    const why = await refusalReason(res);
    return finish({
      status: "unpaid_error",
      price_usd: "0",
      http_status: 402,
      error: {
        code: "payment_failed",
        message: `payment was not accepted${why ? `: ${why}` : " (price above listing, unsupported network, or insufficient USDC)"}`,
        next_action: "top_up",
      },
    });
  }
  if (!res.ok) {
    return finish({
      status: settled ? "paid_error" : "unpaid_error",
      price_usd,
      ...paidFields,
      http_status: res.status,
      error: { code: "provider_error", message: `HTTP ${res.status}`, next_action: "use_fallback" },
    });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return finish({
      status: settled ? "paid_error" : "unpaid_error",
      price_usd,
      ...paidFields,
      http_status: res.status,
      error: { code: "provider_error", message: "response was not JSON", next_action: "use_fallback" },
    });
  }
  const valid = outputValid(listing, body);
  const status: Receipt["status"] = !settled ? "free_ok" : isEmpty(body) ? "paid_empty" : "paid_ok";
  return finish({ status, price_usd, ...paidFields, http_status: res.status, output_valid: valid }, body);
}
