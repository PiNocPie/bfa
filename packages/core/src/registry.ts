import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { Listing, RegistryEntry, Review } from "./types.js";

// ajv-formats ships CommonJS; under NodeNext its default export may be wrapped.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

export interface RegistryProblem {
  file: string;
  message: string;
}

export interface LoadedRegistry {
  entries: RegistryEntry[];
  problems: RegistryProblem[];
}

const ROUTABLE = new Set(["reviewed", "verified-provider"]);

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => join(dir, n)).sort();
}

export async function makeValidators(schemaDir: string): Promise<{
  listing: ValidateFunction;
  review: ValidateFunction;
}> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const listingSchema = JSON.parse(await readFile(join(schemaDir, "listing.schema.json"), "utf8"));
  const reviewSchema = JSON.parse(await readFile(join(schemaDir, "review.schema.json"), "utf8"));
  return { listing: ajv.compile(listingSchema), review: ajv.compile(reviewSchema) };
}

function formatAjvErrors(v: ValidateFunction): string {
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
}

/** Expected listing id for a path like listings/<provider>/<slug>.json. */
export function idFromPath(listingsDir: string, file: string): string {
  return relative(listingsDir, file).split(sep).join("/").replace(/\.json$/, "");
}

/**
 * Load every listing and review from a registry directory.
 * Invalid files are reported in `problems` and skipped, never thrown, so one bad PR cannot take the market down.
 */
export async function loadRegistry(registryDir: string, schemaDir = join(registryDir, "schema")): Promise<LoadedRegistry> {
  const validators = await makeValidators(schemaDir);
  const listingsDir = join(registryDir, "listings");
  const reviewsDir = join(registryDir, "reviews");
  const problems: RegistryProblem[] = [];

  const reviews = new Map<string, Review>();
  for (const file of await listJsonFiles(reviewsDir)) {
    try {
      const review = JSON.parse(await readFile(file, "utf8"));
      if (!validators.review(review)) {
        problems.push({ file, message: `invalid review: ${formatAjvErrors(validators.review)}` });
        continue;
      }
      reviews.set((review as Review).id, review as Review);
    } catch (e) {
      problems.push({ file, message: `unreadable review: ${(e as Error).message}` });
    }
  }

  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (const file of await listJsonFiles(listingsDir)) {
    let bytes: Buffer;
    let listing: Listing;
    try {
      bytes = await readFile(file);
      listing = JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      problems.push({ file, message: `unreadable listing: ${(e as Error).message}` });
      continue;
    }
    if (!validators.listing(listing)) {
      problems.push({ file, message: `invalid listing: ${formatAjvErrors(validators.listing)}` });
      continue;
    }
    const expectedId = idFromPath(listingsDir, file);
    if (listing.id !== expectedId) {
      problems.push({ file, message: `id "${listing.id}" must match its path "${expectedId}"` });
      continue;
    }
    if (seen.has(listing.id)) {
      problems.push({ file, message: `duplicate id "${listing.id}"` });
      continue;
    }
    seen.add(listing.id);

    const manifest_sha256 = sha256(bytes);
    const review = reviews.get(listing.id) ?? null;
    let routable = false;
    let not_routable_reason: string | undefined;
    if (!review) {
      not_routable_reason = "pending review by the Nen team";
    } else if (!ROUTABLE.has(review.status)) {
      not_routable_reason = `review status is ${review.status}`;
    } else if (review.manifest_sha256 !== manifest_sha256) {
      not_routable_reason = "manifest changed after review; needs re-review";
    } else {
      routable = true;
    }
    entries.push({ listing, review, manifest_sha256, routable, ...(not_routable_reason && { not_routable_reason }) });
  }

  for (const id of reviews.keys()) {
    if (!seen.has(id)) problems.push({ file: join(reviewsDir, `${id}.json`), message: `review for unknown listing "${id}"` });
  }

  return { entries, problems };
}
