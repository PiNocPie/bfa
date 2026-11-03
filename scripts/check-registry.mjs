#!/usr/bin/env node
// Validate every listing and review in a registry. Exits 1 on any problem. Used in CI and by reviewers.
//   node scripts/check-registry.mjs [registryDir] [schemaDir]
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../packages/core/dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = resolve(process.argv[2] ?? join(root, "registry"));
const schemaDir = resolve(process.argv[3] ?? join(root, "registry/schema"));
const { entries, problems } = await loadRegistry(dir, schemaDir);
for (const e of entries) {
  const state = e.routable ? "routable    " : "not routable";
  const why = e.not_routable_reason ? `  (${e.not_routable_reason})` : "";
  console.log(`${state}  ${e.listing.id}  $${e.listing.pricing.amount_usd}${why}`);
}
for (const p of problems) console.error(`PROBLEM  ${p.file}: ${p.message}`);
console.log(`${entries.length} listing(s), ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
