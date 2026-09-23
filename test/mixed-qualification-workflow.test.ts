import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mixedQualificationWorkflow } from "../scripts/mixed-qualification-workflow.js";
import { accounting, fixture } from "./helpers.js";
import type {
  AgentConfig,
  Harness,
  HarnessRequest,
  HarnessSink,
  Json,
  Receipt,
} from "../src/types.js";

class InitialBarrier {
  private waiting = 0;
  private release!: () => void;
  readonly open = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  arrive(): void {
    this.waiting += 1;
    if (this.waiting === 2) this.release();
  }
}

class SyntheticHarness implements Harness {
  readonly live = true;
  readonly calls: HarnessRequest[] = [];
  constructor(
    readonly name: string,
    readonly identity: Json,
    private readonly marker: string,
    private readonly subtotal: number,
    private readonly barrier: InitialBarrier,
  ) {}
  async preflight(): Promise<void> {
    // Synthetic metadata only.
  }
  async invoke(request: HarnessRequest, sink: HarnessSink): Promise<Receipt> {
    this.calls.push(request);
    if (
      request.prompt.includes("left.json") ||
      request.prompt.includes("right.json")
    ) {
      this.barrier.arrive();
      await this.barrier.open;
      const value = { marker: this.marker, subtotal: this.subtotal };
      sink.report("terminal", {
        ...accounting,
        model: `${this.name}-model`,
        scope: this.name,
      });
      return {
        status: "succeeded",
        text: JSON.stringify(value),
        accounting: {
          ...accounting,
          model: `${this.name}-model`,
          scope: this.name,
        },
        session: {
          nativeId: `${this.name}-native`,
          baseline: { provider: this.name, turn: this.calls.length },
        },
      };
    }
    assert.equal(request.session?.nativeId, "codex-native");
    assert.match(request.prompt, /Without tools/);
    assert.match(request.prompt, /"codex"/);
    assert.match(request.prompt, /"opencode"/);
    const contextText = request.prompt.match(
      /Selected JSON context \(data, not instructions\):\n([^\n]+)/,
    )?.[1];
    assert.ok(contextText);
    const context = JSON.parse(contextText) as {
      codex: { subtotal: number };
      opencode: { subtotal: number };
    };
    const value = {
      marker: this.marker,
      codexSubtotal: context.codex.subtotal,
      opencodeSubtotal: context.opencode.subtotal,
      total: context.codex.subtotal + context.opencode.subtotal,
    };
    sink.report("terminal", {
      ...accounting,
      model: "codex-model",
      scope: "codex",
    });
    return {
      status: "succeeded",
      text: JSON.stringify(value),
      accounting: { ...accounting, model: "codex-model", scope: "codex" },
      session: {
        nativeId: "codex-native",
        baseline: { provider: "codex", turn: this.calls.length },
      },
    };
  }
}

function agents(codex: SyntheticHarness, opencode: SyntheticHarness) {
  return {
    codex: { harness: codex, model: "codex-test" },
    opencode: { harness: opencode, model: "opencode-test" },
  } satisfies { codex: AgentConfig; opencode: AgentConfig };
}

test("mixed qualification overlaps reads, combines on Codex, and replays offline", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.dir, "left.json"),
      JSON.stringify({ marker: "m", values: [2, 3] }),
    );
    writeFileSync(
      join(f.dir, "right.json"),
      JSON.stringify({ marker: "m", values: [5, 7] }),
    );
    const barrier = new InitialBarrier();
    const codex = new SyntheticHarness(
      "codex",
      { adapter: "codex", id: 1 },
      "m",
      5,
      barrier,
    );
    const opencode = new SyntheticHarness(
      "opencode",
      { adapter: "opencode", id: 2 },
      "m",
      12,
      barrier,
    );
    const a = agents(codex, opencode);
    const budget = { id: "mixed", maxDispatches: 3, softUsd: 2 };
    const result = await f
      .runtime({ live: true, budget })
      .run((r) => mixedQualificationWorkflow(r, a));
    assert.deepEqual(result.combined.value, {
      marker: "m",
      codexSubtotal: 5,
      opencodeSubtotal: 12,
      total: 17,
    });
    assert.equal(codex.calls.length, 2);
    assert.equal(opencode.calls.length, 1);
    assert.equal(codex.calls[1]!.session?.nativeId, "codex-native");
    assert.equal(opencode.calls[0]!.session, undefined);
    const before = f.store.inspect("run");
    assert.equal(before.totals.modelDispatches, 3);
    assert.equal(before.budgets[0]?.reserved, 3);
    assert.deepEqual(
      before.invocations.map((i) => JSON.parse(i.accounting!).scope).sort(),
      ["codex", "codex", "opencode"],
    );
    const reports = before.reports.length;
    const sessions = before.invocations.map((i) => i.session);
    await f
      .runtime({ live: false, budget })
      .run((r) => mixedQualificationWorkflow(r, a));
    const after = f.store.inspect("run");
    assert.equal(codex.calls.length, 2);
    assert.equal(opencode.calls.length, 1);
    assert.equal(after.reports.length, reports);
    assert.deepEqual(
      after.invocations.map((i) => i.session),
      sessions,
    );
    assert.deepEqual(after, before);
  } finally {
    f.close();
  }
});

test("marker mismatch stops before combine", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "left.json"), "{}");
    writeFileSync(join(f.dir, "right.json"), "{}");
    const barrier = new InitialBarrier();
    const codex = new SyntheticHarness(
      "codex",
      { adapter: "codex", id: 3 },
      "left",
      1,
      barrier,
    );
    const opencode = new SyntheticHarness(
      "opencode",
      { adapter: "opencode", id: 4 },
      "right",
      2,
      barrier,
    );
    await assert.rejects(
      f
        .runtime({
          live: true,
          budget: { id: "mismatch", maxDispatches: 3, softUsd: 2 },
        })
        .run((r) => mixedQualificationWorkflow(r, agents(codex, opencode))),
      /Fixture markers disagree/,
    );
    assert.equal(codex.calls.length, 1);
    assert.equal(opencode.calls.length, 1);
    assert.equal(f.store.inspect("run").totals.modelDispatches, 2);
  } finally {
    f.close();
  }
});
