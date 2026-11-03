import { decodePaymentRequiredHeader } from "@x402/core/http";
import { usdToMicros, type Listing } from "@nen-near/core";

export interface BotCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** What the seller should change, when the check fails. */
  fix?: string;
}

export interface BotReport {
  listing_id: string;
  passed: boolean;
  checks: BotCheck[];
  checked_at: string;
}

interface Accept {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
}

/**
 * Unpaid probe of a listing's endpoint, the same request an agent would send first.
 * Never pays: it only reads the 402 challenge. A paid test call is a separate, reviewer-approved step.
 */
export async function probeListing(listing: Listing, fetchImpl: typeof fetch = fetch): Promise<BotReport> {
  const checks: BotCheck[] = [];
  const add = (c: BotCheck) => checks.push(c);
  const e = listing.endpoint;

  let res: Response | undefined;
  try {
    const init: RequestInit =
      e.method === "GET"
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e.example_input) };
    const url = new URL(e.url);
    if (e.method === "GET") for (const [k, v] of Object.entries(e.example_input)) url.searchParams.set(k, String(v));
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    add({ id: "reachable", ok: true, detail: `HTTP ${res.status} from ${e.method} ${e.url}` });
  } catch (err) {
    add({
      id: "reachable",
      ok: false,
      detail: `request failed: ${(err as Error).message}`,
      fix: "Make the endpoint publicly reachable over https and respond within 15s.",
    });
  }

  let accepts: Accept[] = [];
  if (res) {
    const is402 = res.status === 402;
    add({
      id: "returns_402",
      ok: is402,
      detail: is402 ? "unpaid request gets 402 Payment Required" : `unpaid request got HTTP ${res.status}`,
      ...(!is402 && { fix: "Unpaid requests must return 402 with an x402 V2 PAYMENT-REQUIRED challenge, never free data." }),
    });
    if (is402) {
      const header = res.headers.get("PAYMENT-REQUIRED");
      try {
        if (!header) throw new Error("missing PAYMENT-REQUIRED header");
        const required = decodePaymentRequiredHeader(header) as unknown as { x402Version: number; accepts: Accept[] };
        accepts = required.accepts ?? [];
        add({
          id: "x402_v2",
          ok: required.x402Version === 2,
          detail: `x402Version ${required.x402Version}, ${accepts.length} payment option(s)`,
          ...(required.x402Version !== 2 && { fix: "Upgrade to x402 V2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers)." }),
        });
      } catch (err) {
        add({
          id: "x402_v2",
          ok: false,
          detail: `could not decode the 402 challenge: ${(err as Error).message}`,
          fix: "Send a base64 PAYMENT-REQUIRED header as produced by @x402 server middleware.",
        });
      }
    }
  }

  if (accepts.length) {
    const listed = usdToMicros(listing.pricing.amount_usd);
    const offeredNetworks = new Set(accepts.map((a) => a.network));
    const missingNetworks = listing.payment.networks.filter((n) => !offeredNetworks.has(n));
    add({
      id: "networks_match",
      ok: missingNetworks.length === 0,
      detail: missingNetworks.length ? `manifest lists ${missingNetworks.join(", ")} but the 402 does not offer it` : "every manifest network is offered",
      ...(missingNetworks.length && { fix: "Make payment.networks match the networks in your 402 challenge." }),
    });
    const schemes = listing.payment.schemes ?? ["exact"];
    const offeredSchemes = new Set(accepts.map((a) => a.scheme));
    const missingSchemes = schemes.filter((s) => !offeredSchemes.has(s));
    add({
      id: "schemes_match",
      ok: missingSchemes.length === 0,
      detail: missingSchemes.length ? `manifest lists ${missingSchemes.join(", ")} but the 402 does not offer it` : `offers ${[...offeredSchemes].join(", ")}`,
      ...(missingSchemes.length && { fix: "Make payment.schemes match the schemes in your 402 challenge." }),
    });
    const relevant = accepts.filter((a) => listing.payment.networks.includes(a.network));
    const mismatched = relevant.filter((a) => BigInt(a.amount) !== listed);
    add({
      id: "price_matches",
      ok: relevant.length > 0 && mismatched.length === 0,
      detail: mismatched.length
        ? `402 asks ${mismatched.map((a) => `${a.amount} atomic on ${a.network}/${a.scheme}`).join(", ")}; manifest says $${listing.pricing.amount_usd} (${listed} atomic)`
        : `402 price equals manifest price $${listing.pricing.amount_usd}`,
      ...(mismatched.length && { fix: "The 402 amount must equal pricing.amount_usd exactly. Agents refuse to pay more than the listed price." }),
    });
    const payTos = new Set(relevant.map((a) => a.payTo.toLowerCase()));
    add({ id: "pay_to", ok: payTos.size > 0, detail: `payTo ${[...payTos].join(", ") || "missing"}` });
  }

  if (listing.payment.payout.via === "near-intents") {
    add({
      id: "near_intents_payout",
      ok: true,
      detail: `payout declared via NEAR Intents to ${listing.payment.payout.recipient} on ${listing.payment.payout.chain}/${listing.payment.payout.token}; reviewer confirms with a paid test call`,
    });
  }

  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(e.url)) {
    add({ id: "public_https", ok: false, detail: "localhost endpoint", fix: "Public listings must use a public https URL." });
  }

  return { listing_id: listing.id, passed: checks.every((c) => c.ok), checks, checked_at: new Date().toISOString() };
}
