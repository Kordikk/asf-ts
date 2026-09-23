import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import type {
  Accounting,
  Harness,
  HarnessRequest,
  HarnessSink,
  Json,
  Pricing,
  Receipt,
} from "../src/types.js";
export const pricing: Pricing = {
  model: "test-model",
  source: "test rate card",
  version: "fixture-1",
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 2,
  output: 3,
};
export const accounting: Accounting = {
  status: "complete",
  usd: 0.001,
  kind: "asf-calculated",
  model: "test-model",
  modelSource: "observed",
  scope: "fixture",
  excluded: [],
  source: "fixture",
  version: "1",
  tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 2 },
  pricing,
};
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "asf-test-"));
  const store = new Store(join(dir, "store.db"));
  return {
    dir,
    store,
    runtime: (extra: Partial<ConstructorParameters<typeof Runtime>[0]> = {}) =>
      new Runtime({
        store,
        runId: "run",
        workflowIdentity: "wf",
        cwd: dir,
        ...extra,
      }),
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export class Scripted implements Harness {
  name = "scripted";
  live = false;
  identity: Json = { adapter: "scripted", v: 1 };
  calls: HarnessRequest[] = [];
  constructor(
    private responses: (
      | string
      | ((r: HarnessRequest, s: HarnessSink) => Promise<Receipt>)
    )[] = ["ok"],
  ) {}
  async preflight(): Promise<void> {
    /* no side effects */
  }
  async invoke(r: HarnessRequest, s: HarnessSink): Promise<Receipt> {
    this.calls.push(r);
    const response = this.responses[this.calls.length - 1] ?? "ok";
    if (typeof response === "function") return response(r, s);
    s.event({ type: "message", data: { text: response }, content: true });
    s.report("terminal", accounting);
    return {
      status: "succeeded",
      text: response,
      accounting,
      session: {
        nativeId: r.session?.nativeId ?? `native-${this.calls.length}`,
        baseline: this.calls.length,
      },
    };
  }
}
