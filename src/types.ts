export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Tokens = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};
/** Rates per million tokens. Input excludes cache reads/writes; output includes reasoning. */
export interface Pricing {
  model: string;
  version: string;
  source: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export interface AdditionalCost {
  usd: number | null;
  kind: "billed" | "harness-estimated" | "asf-calculated";
  scope: string;
  model: string | null;
  source: string;
  version: string;
}
export interface Accounting {
  additional?: AdditionalCost[];
  status: "complete" | "incomplete";
  usd: number | null;
  kind: "billed" | "harness-estimated" | "asf-calculated";
  model: string;
  modelSource: "observed" | "requested";
  scope: string;
  excluded: string[];
  source: string;
  version: string;
  tokens: Tokens | null;
  pricing: Pricing | null;
  reason?: string;
  raw?: Json;
}
export interface NativeSession {
  nativeId: string;
  baseline: Json;
}
export interface HarnessRequest {
  traceContent?: boolean;
  prompt: string;
  model: string;
  cwd: string;
  mode: "read-only" | "write";
  session?: NativeSession;
  signal: AbortSignal;
}
export interface HarnessEvent {
  type: "message" | "tool" | "reasoning" | "lifecycle" | "model";
  sourceId?: string;
  data: Json;
  content?: boolean;
}
export interface Receipt {
  status: "succeeded" | "failed" | "cancelled";
  text: string;
  session?: NativeSession;
  nativeId?: string;
  accounting: Accounting;
  error?: string;
  truncated?: boolean;
}
/** Callbacks are owned by runtime, synchronous, bounded, durable; never user/network callbacks. */
export interface HarnessSink {
  event(event: HarnessEvent): void;
  report(key: string, accounting: Accounting): void;
}
export interface Harness {
  readonly name: string;
  readonly live: boolean;
  readonly identity: Json;
  preflight(request: Omit<HarnessRequest, "signal">): Promise<void>;
  invoke(request: HarnessRequest, sink: HarnessSink): Promise<Receipt>;
  /** Reusable harness lifetime belongs to its caller, not Runtime; close once when no longer used. */
  close?(): Promise<void>;
}
export interface AgentConfig {
  harness: Harness;
  model: string;
  instructions?: string;
  mode?: "read-only" | "write";
  timeoutMs?: number;
}
export interface AgentResult<T = string> {
  value: T;
  text: string;
  session: string;
}
export interface AgentOptions {
  prompt: string;
  context?: Json;
  session?: string;
  schema?: Record<string, unknown>;
  corrections?: number;
}
export interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled: boolean;
}
