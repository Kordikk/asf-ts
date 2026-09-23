import type { Json } from "./types.js";

/** SQLite inspection DTOs. JSON receipt/result/accounting columns remain encoded. */
export interface RunSummary {
  id: string;
  status: string;
  error: string | null;
  created: number;
}
export interface Inspection {
  run?: RunSummary & {
    identity: string;
    pid: number | null;
    owner: string | null;
  };
  actions: {
    run: string;
    id: string;
    identity: string;
    status: string;
    result: string | null;
    error: string | null;
  }[];
  invocations: {
    id: string;
    run: string;
    action: string;
    turn: number;
    status: string;
    receipt: string | null;
    session: string | null;
    kind: string;
    paid: number;
    budget: string | null;
    created: number;
    accounting: string | null;
  }[];
  reports: { invocation: string; key: string; data: string }[];
  budgets: {
    id: string;
    max: number;
    soft: number;
    reserved: number;
    knownUsd: number | null;
    unresolved: number;
  }[];
  totals: {
    invocations: number;
    modelDispatches: number | null;
    knownUsd: number | null;
    unresolved: number | null;
  };
  costsByKind: { kind: string; knownUsd: number | null }[];
  offset: number;
  limit: number;
}
export interface EventRow {
  cursor: number;
  v: 1;
  attempt: 1;
  runId: string;
  actionId: string | null;
  invocationId: string | null;
  turn: number | null;
  sourceId: string | null;
  observedAt: number;
  type: string;
  data: Json;
}
