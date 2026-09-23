import type { Accounting, Pricing, Tokens } from "./types.js";
import { clip } from "./util.js";
export const zeroTokens = (): Tokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});
export function validTokens(t: Tokens): void {
  for (const n of Object.values(t))
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("Invalid token count");
  if (t.reasoning > t.output)
    throw new Error("Reasoning must be included in output");
}
export function delta(total: Tokens, baseline: Tokens): Tokens {
  validTokens(total);
  validTokens(baseline);
  const d = zeroTokens();
  for (const k of Object.keys(d) as (keyof Tokens)[]) {
    d[k] = total[k] - baseline[k];
    if (d[k] < 0) throw new Error("Cumulative usage regressed");
  }
  validTokens(d);
  return d;
}
export function validatePricing(p: Pricing, model: string): void {
  if (p.model !== model || !p.source || !p.version)
    throw new Error("Explicit matching model/rate provenance required");
  for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const)
    if (!Number.isFinite(p[k]) || p[k] < 0) throw new Error("Invalid price");
}
export function estimate(t: Tokens, p: Pricing): number {
  validTokens(t);
  validatePricing(p, p.model);
  return (
    (t.input * p.input +
      t.cacheRead * p.cacheRead +
      t.cacheWrite * p.cacheWrite +
      t.output * p.output) /
    1e6
  );
}
export function incomplete(
  model: string,
  reason: string,
  last?: Accounting,
): Accounting {
  return {
    ...(last ?? {
      usd: null,
      kind: "asf-calculated",
      model,
      modelSource: "requested",
      scope: "unknown",
      excluded: [],
      source: "unavailable",
      version: "1",
      tokens: null,
      pricing: null,
    }),
    status: "incomplete",
    reason,
  };
}

/**
 * Select one cumulative snapshot without adding snapshots together. The largest
 * known subtotal wins; incomplete evidence wins ties and can never be erased by
 * a later/higher complete snapshot.
 */
export function strongestAccounting(
  snapshots: readonly Accounting[],
): Accounting | undefined {
  let best: Accounting | undefined;
  let unresolved: Accounting | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.status === "incomplete") unresolved = snapshot;
    if (!best) {
      best = snapshot;
      continue;
    }
    const amount = knownUsd(snapshot) ?? -1;
    const bestAmount = knownUsd(best) ?? -1;
    if (
      amount > bestAmount ||
      (amount === bestAmount &&
        (snapshot.status === best.status || snapshot.status === "incomplete"))
    )
      best = snapshot;
  }
  if (!best || !unresolved || best.status === "incomplete") return best;
  return incomplete(
    best.model,
    clip(
      `Durable mandatory accounting remains unresolved: ${
        unresolved.reason ?? "incomplete report"
      }`,
      4096,
    ),
    best,
  );
}
export function validateAccounting(a: Accounting): void {
  if (a.usd !== null && (!Number.isFinite(a.usd) || a.usd < 0))
    throw new Error("Invalid cost");
  for (const part of a.additional ?? []) {
    if (part.usd !== null && (!Number.isFinite(part.usd) || part.usd < 0))
      throw new Error("Invalid supplemental cost");
  }
  if (a.tokens) validTokens(a.tokens);
  if (
    a.status === "complete" &&
    (a.usd === null ||
      (a.additional ?? []).some((part) => part.usd === null) ||
      !a.scope ||
      !a.source ||
      !a.version)
  )
    throw new Error("Complete accounting needs usable scoped cost");
}

/** Known subtotal only; null components remain unresolved in their enclosing accounting record. */
export function knownUsd(a: Accounting): number | null {
  const values = [a.usd, ...(a.additional ?? []).map((p) => p.usd)].filter(
    (n): n is number => n !== null,
  );
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}
