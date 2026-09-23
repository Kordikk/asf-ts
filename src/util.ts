import { createHash } from "node:crypto";
import type { Json } from "./types.js";
export const TEXT_LIMIT = 64 * 1024;
export function clip(text: string, bytes = TEXT_LIMIT): string {
  const b = Buffer.from(text);
  return b.length <= bytes
    ? text
    : b
        .subarray(0, bytes)
        .toString("utf8")
        .replace(/\uFFFD$/u, "");
}
export function encode(value: unknown, limit = 256 * 1024): string {
  const result = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("Non-finite JSON number");
    return v;
  });
  if (result === undefined || Buffer.byteLength(result) > limit)
    throw new Error("JSON payload exceeds limit or is undefined");
  return result;
}
export function canonical(value: unknown): string {
  const normalized: unknown = JSON.parse(encode(value));
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(normalized));
}
export const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const json = (value: unknown): Json => JSON.parse(encode(value)) as Json;
export const errorText = (e: unknown): string =>
  clip(e instanceof Error ? e.message : String(e), 4096);
export function positive(value: number, max = 3_600_000): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error("Invalid positive bound");
  return value;
}
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
/** Lossy trace projection, deliberately independent of mandatory accounting serialization. */
export function boundedJson(value: unknown): Json {
  const seen = new WeakSet<object>();
  let loss = false;
  const walk = (v: unknown, depth: number): Json => {
    if (typeof v === "string") {
      const prefix = clip(v, 1500);
      if (prefix !== v) loss = true;
      return prefix;
    }
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v !== "object") return String(v);
    if (depth > 5 || seen.has(v)) {
      loss = true;
      return "[bounded]";
    }
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 20) loss = true;
      return v.slice(0, 20).map((x) => walk(x, depth + 1));
    }
    if (Object.entries(v).length > 20) loss = true;
    return Object.fromEntries(
      Object.entries(v)
        .slice(0, 20)
        .map(([k, x]) => {
          const key = clip(k, 100);
          if (key !== k) loss = true;
          return [key, walk(x, depth + 1)];
        }),
    );
  };
  let result = walk(value, 0);
  if (loss) {
    // First key survives subsequent adapter/runtime/store projections. Keep the
    // collection bound including this marker; primitive/array roots use a wrapper.
    result =
      result !== null && typeof result === "object" && !Array.isArray(result)
        ? {
            projectionLoss: true,
            ...Object.fromEntries(
              Object.entries(result)
                .filter(([k]) => k !== "projectionLoss")
                .slice(0, 19),
            ),
          }
        : { projectionLoss: true, value: result };
  }
  const text = JSON.stringify(result);
  return Buffer.byteLength(text) <= 7500
    ? result
    : { truncated: true, preview: clip(text, 4000) };
}
