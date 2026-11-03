// Compile the Solidity sources with solcjs (pinned in package.json) and, when run directly,
// write ABI + bytecode for the production contracts to out/.
//
//   node scripts/compile.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import solc from "solc";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const COMPILER_SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  // Base supports Cancun. Pinned so the bytecode does not depend on the compiler's default.
  evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
};

function solFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? solFiles(join(dir, e.name)) : e.name.endsWith(".sol") ? [join(dir, e.name)] : [],
  );
}

/**
 * @param {{ includeTests?: boolean }} [opts]
 * @returns {Record<string, { abi: any[]; bytecode: `0x${string}`; deployedBytecode: `0x${string}`; source: string }>}
 */
export function compileContracts(opts = {}) {
  const files = [...solFiles("src"), ...(opts.includeTests ? solFiles("test/contracts") : [])];
  const sources = Object.fromEntries(
    files.map((f) => [relative(ROOT, join(ROOT, f)).split("\\").join("/"), { content: readFileSync(join(ROOT, f), "utf8") }]),
  );
  const input = { language: "Solidity", sources, settings: COMPILER_SETTINGS };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const warnings = (output.errors ?? []).filter((e) => e.severity !== "error");
  if (warnings.length) throw new Error("Compiler warnings are treated as errors:\n" + warnings.map((e) => e.formattedMessage).join("\n"));

  const out = {};
  for (const [source, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      // Skip interfaces and internal-only libraries (no functions, no constructor).
      if (!c.evm.bytecode.object || !c.abi.some((x) => x.type === "function" || x.type === "constructor")) continue;
      out[name] = {
        abi: c.abi,
        bytecode: `0x${c.evm.bytecode.object}`,
        deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
        source,
      };
    }
  }
  return out;
}

export const solcVersion = () => solc.version();

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const contracts = compileContracts();
  mkdirSync(join(ROOT, "out"), { recursive: true });
  console.log(`solc ${solcVersion()}`);
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(join(ROOT, "out", `${name}.json`), JSON.stringify({ contractName: name, ...c }, null, 2) + "\n");
    const runtime = (c.deployedBytecode.length - 2) / 2;
    const init = (c.bytecode.length - 2) / 2;
    console.log(`${name}: runtime ${runtime} bytes, initcode ${init} bytes (EIP-170 limit 24576)`);
  }
}
