/** USD amounts are handled as integer micro-dollars (1e-6 USD) to avoid float drift on sub-cent prices. */
export type Micros = bigint;

const USD_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/;

export function usdToMicros(usd: string): Micros {
  const m = USD_RE.exec(usd);
  if (!m) throw new Error(`invalid USD amount "${usd}" (expected a decimal string with up to 6 decimals)`);
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000n + frac;
}

export function microsToUsd(micros: Micros): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** USDC has 6 decimals, so atomic USDC units equal micro-dollars at a 1:1 peg. */
export function usdcAtomicToMicros(atomic: string | bigint): Micros {
  return typeof atomic === "bigint" ? atomic : BigInt(atomic);
}
