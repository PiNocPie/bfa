import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BfaError,
  ReceiptLog,
  discover as discoverListings,
  healthFromReceipts,
  idFromPath,
  loadRegistry,
  makeValidators,
  microsToUsd,
  quote as rankListings,
  toErrorShape,
  type Category,
  type Listing,
  type Receipt,
  type RegistryEntry,
} from "@bfa/core";
import {
  NETWORKS,
  callListing,
  chainSignaturesSigner,
  loadOrCreateSessionSigner,
  nearAccount,
  nearMpc,
  treasurySigner,
  probeListing,
  type BfaSigner,
  type SessionConfig,
} from "@bfa/x402-client";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface BfaConfig {
  registryDir: string;
  /** Extra local registry (e.g. a localhost demo seller). Uses the main registry's schemas. */
  devRegistryDir?: string;
  stateDir: string;
  network: "testnet" | "mainnet";
  nearAccountId?: string;
  nearPrivateKey?: string;
  nearRpcUrls?: string[];
  agentPath: string;
  /** BFA treasury contract. When set, payments are signed by the user's vault under its on-chain policy. */
  treasuryId?: string;
  dailyCapUsd: string;
  maxDepositUsd: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  signerOverride?: BfaSigner;
}

const PAYER_NETWORK = { testnet: NETWORKS.baseSepolia, mainnet: NETWORKS.baseMainnet } as const;
const USDC = {
  [NETWORKS.baseSepolia]: { chain: baseSepolia, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex },
  [NETWORKS.baseMainnet]: { chain: base, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex },
} as const;

export function tools(cfg: BfaConfig) {
  const log = new ReceiptLog(join(cfg.stateDir, "receipts.jsonl"));
  const payerNetwork = PAYER_NETWORK[cfg.network];
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  async function entries(): Promise<RegistryEntry[]> {
    const main = await loadRegistry(cfg.registryDir);
    if (!cfg.devRegistryDir) return main.entries;
    const dev = await loadRegistry(cfg.devRegistryDir, join(cfg.registryDir, "schema"));
    const ids = new Set(main.entries.map((e) => e.listing.id));
    return [...main.entries, ...dev.entries.filter((e) => !ids.has(e.listing.id))];
  }

  async function entry(id: string): Promise<RegistryEntry> {
    const e = (await entries()).find((x) => x.listing.id === id);
    if (!e) throw new BfaError({ code: "no_matching_listing", message: `no listing "${id}"`, next_action: "stop" });
    return e;
  }

  let signerP: Promise<BfaSigner> | undefined;
  function signer(): Promise<BfaSigner> {
    if (cfg.signerOverride) return Promise.resolve(cfg.signerOverride);
    if (!cfg.nearAccountId || !cfg.nearPrivateKey) {
      return Promise.reject(
        new BfaError({
          code: "signer_unavailable",
          message: "no NEAR account configured: set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in the MCP server's environment",
          next_action: "stop",
        }),
      );
    }
    const caller = nearAccount({
      accountId: cfg.nearAccountId,
      privateKey: cfg.nearPrivateKey,
      networkId: cfg.network,
      ...(cfg.nearRpcUrls && { rpcUrls: cfg.nearRpcUrls }),
    });
    signerP ??= cfg.treasuryId
      ? treasurySigner({ caller, treasuryId: cfg.treasuryId, networkId: cfg.network })
      : chainSignaturesSigner({
          mpc: nearMpc({ networkId: cfg.network, caller }),
          predecessor: cfg.nearAccountId,
          path: cfg.agentPath,
        });
    return signerP;
  }

  let sessionP: Promise<SessionConfig> | undefined;
  function session(): Promise<SessionConfig> {
    sessionP ??= loadOrCreateSessionSigner(join(cfg.stateDir, "session.key")).then((s) => ({
      signer: s,
      channelDir: join(cfg.stateDir, "channels"),
      maxDepositUsd: cfg.maxDepositUsd,
    }));
    return sessionP;
  }

  async function health() {
    return healthFromReceipts(await log.all());
  }

  function priceLine(l: Listing): string {
    return `$${l.pricing.amount_usd} / call · empty result: ${l.pricing.charges_empty_results ? "charged" : "free"} · error: free`;
  }

  return {
    errorShape: toErrorShape,

    async discover(a: { query: string; category?: Category; include_not_routable?: boolean; limit?: number }) {
      const hits = discoverListings(await entries(), a.query, {
        ...(a.category && { category: a.category }),
        ...(a.include_not_routable !== undefined && { includeNotRoutable: a.include_not_routable }),
        ...(a.limit && { limit: a.limit }),
      });
      return {
        query: a.query,
        payer_network: payerNetwork,
        hits: hits.map((h) => ({ ...h, payable_from_this_wallet: h.networks.includes(payerNetwork) })),
      };
    },

    async inspect(a: { listing_id: string }) {
      const e = await entry(a.listing_id);
      const h = (await health()).get(a.listing_id);
      const l = e.listing;
      return {
        listing: l,
        price: priceLine(l),
        schemes: l.payment.schemes ?? ["exact"],
        payable_from_this_wallet: l.payment.networks.includes(payerNetwork),
        review: {
          status: e.review?.status ?? "pending",
          reviewer: e.review?.reviewer ?? null,
          reviewed_at: e.review?.reviewed_at ?? null,
          approved_manifest_sha256: e.review?.manifest_sha256 ?? null,
          current_manifest_sha256: e.manifest_sha256,
          unchanged_since_review: e.review ? e.review.manifest_sha256 === e.manifest_sha256 : false,
        },
        routable: e.routable,
        ...(e.not_routable_reason && { not_routable_reason: e.not_routable_reason }),
        observed_health: h ?? null,
        how_to_call: { tool: "run", args: { listing_id: l.id, input: l.endpoint.example_input } },
      };
    },

    async quote(a: { query?: string; listing_ids?: string[]; max_price_usd?: string }) {
      const all = await entries();
      let candidates: RegistryEntry[];
      if (a.listing_ids?.length) {
        candidates = all.filter((e) => a.listing_ids!.includes(e.listing.id));
      } else if (a.query) {
        const ids = new Set(discoverListings(all, a.query).map((h) => h.id));
        candidates = all.filter((e) => ids.has(e.listing.id));
      } else {
        throw new BfaError({ code: "invalid_input", message: "pass query or listing_ids", next_action: "fix_input" });
      }
      return rankListings(candidates, await health(), {
        payerNetworks: [payerNetwork],
        ...(a.max_price_usd && { maxPriceUsd: a.max_price_usd }),
      });
    },

    async run(a: {
      listing_id?: string;
      query?: string;
      input: Record<string, unknown>;
      max_price_usd?: string;
      idempotency_key?: string;
    }) {
      let order: string[];
      if (a.listing_id) order = [a.listing_id];
      else if (a.query) {
        const q = await this.quote({ query: a.query, ...(a.max_price_usd && { max_price_usd: a.max_price_usd }) });
        order = [q.listing_id, ...q.fallbacks];
      } else throw new BfaError({ code: "invalid_input", message: "pass listing_id or query", next_action: "fix_input" });

      const s = await signer();
      const sess = await session();
      const attempts: Receipt[] = [];
      for (const [i, id] of order.entries()) {
        const e = await entry(id);
        if (!e.routable) {
          throw new BfaError({
            code: "listing_not_routable",
            message: `${id} is not routable: ${e.not_routable_reason}`,
            next_action: "stop",
          });
        }
        const validate = ajv.compile(e.listing.endpoint.input_schema);
        if (!validate(a.input)) {
          throw new BfaError({
            code: "invalid_input",
            message: `input does not match ${id} input_schema: ${ajv.errorsText(validate.errors)}`,
            next_action: "fix_input",
            details: { input_schema: e.listing.endpoint.input_schema, example_input: e.listing.endpoint.example_input },
          });
        }
        const { receipt, data, replayed } = await callListing({
          listing: e.listing,
          input: a.input,
          signer: s,
          log,
          session: sess,
          dailyCapUsd: cfg.dailyCapUsd,
          ...(a.max_price_usd && { maxPriceUsd: a.max_price_usd }),
          ...(a.idempotency_key && { idempotencyKey: order.length > 1 ? `${a.idempotency_key}:${id}` : a.idempotency_key }),
          ...(cfg.fetchImpl && { fetchImpl: cfg.fetchImpl }),
        });
        attempts.push(receipt);
        const done = ["paid_ok", "paid_empty", "free_ok"].includes(receipt.status) || replayed;
        const canFallback = receipt.error?.next_action === "use_fallback" && i < order.length - 1;
        if (done || !canFallback) {
          return { ...(data !== undefined && { data }), receipt, ...(replayed && { replayed }), attempts: attempts.length };
        }
      }
      return { receipt: attempts.at(-1), attempts: attempts.length };
    },

    async receipts(a: { limit?: number }) {
      const all = await log.all();
      return {
        spent_today_usd: microsToUsd(await log.spentTodayMicros()),
        daily_cap_usd: cfg.dailyCapUsd,
        receipts: all.slice(-(a.limit ?? 20)).reverse(),
      };
    },

    async wallet() {
      const s = await signer();
      const sess = await session();
      const usdc = USDC[payerNetwork];
      let usdc_balance: string | null = null;
      try {
        const client = createPublicClient({ chain: usdc.chain, transport: http() });
        const raw = await client.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [s.address] });
        usdc_balance = microsToUsd(raw);
      } catch {
        usdc_balance = null;
      }
      return {
        near_account: cfg.nearAccountId ?? null,
        near_network: cfg.network,
        derivation_path: cfg.treasuryId ? `vault/${cfg.nearAccountId}` : cfg.agentPath,
        payer_address: s.address,
        payer_address_controlled_by:
          s.kind === "near-treasury"
            ? `BFA treasury ${cfg.treasuryId} vault of ${cfg.nearAccountId} (NEAR Chain Signatures, on-chain daily limit)`
            : s.kind === "near-chain-signatures"
              ? `NEAR Chain Signatures (${cfg.nearAccountId})`
              : s.kind,
        payer_network: payerNetwork,
        usdc_balance,
        session_key_address: sess.signer.address,
        limits: { daily_cap_usd: cfg.dailyCapUsd, max_channel_deposit_usd: cfg.maxDepositUsd },
        spent_today_usd: microsToUsd(await log.spentTodayMicros()),
      };
    },

    async submitListing(a: { manifest: Record<string, unknown> }) {
      const v = await makeValidators(join(cfg.registryDir, "schema"));
      const schemaOk = v.listing(a.manifest) as boolean;
      const schemaErrors = schemaOk ? [] : (v.listing.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
      const id = typeof a.manifest.id === "string" ? a.manifest.id : "<id>";
      const path = `registry/listings/${id}.json`;
      const report = schemaOk ? await probeListing(a.manifest as unknown as Listing, cfg.fetchImpl) : null;
      const passed = schemaOk && !!report?.passed;
      return {
        listing_id: id,
        schema_valid: schemaOk,
        schema_errors: schemaErrors,
        bot_report: report,
        passed,
        next_steps: passed
          ? [`Open a PR adding the manifest at ${path}.`, "The BFA team peer-reviews it; once approved it becomes routable."]
          : ["Fix the failing checks above and run submit_listing again. Nothing was published."],
        path_matches_id: idFromPath(join(cfg.registryDir, "listings"), join(cfg.registryDir, "listings", `${id}.json`)) === id,
      };
    },
  };
}
