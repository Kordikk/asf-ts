import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualificationWorkflow } from "../scripts/qualification-workflow.js";
import { accounting, fixture, Scripted } from "./helpers.js";

test("shared qualification performs five bounded turns and replays without model dispatch", async () => {
  const f = fixture();
  try {
    const marker = "qualification-marker-742\n";
    writeFileSync(join(f.dir, "fixture.txt"), marker);
    const harness = new Scripted([
      marker,
      marker,
      async (request, sink) => {
        writeFileSync(
          join(request.cwd, "result.txt"),
          readFileSync(join(request.cwd, "fixture.txt")),
        );
        sink.report("terminal", accounting);
        return {
          status: "succeeded",
          text: "written",
          accounting,
          session: { nativeId: "native-write", baseline: 1 },
        };
      },
      "NOT_JSON",
      '{"ok":true}',
    ]);
    harness.live = true;
    const agent = { harness, model: "test-model" };
    const budget = { id: "qualification", maxDispatches: 5, softUsd: 2 };
    await f
      .runtime({ live: true, budget })
      .run((r) => qualificationWorkflow(r, agent));
    assert.equal(harness.calls.length, 5);
    assert.equal(harness.calls[1]?.session?.nativeId, "native-1");
    assert.equal(harness.calls[4]?.session?.nativeId, "native-4");
    assert.match(harness.calls[3]!.prompt, /return exactly NOT_JSON/);
    assert.match(harness.calls[4]!.prompt, /Format correction only/);
    assert.deepEqual(
      harness.calls.map((q) => q.mode),
      ["read-only", "read-only", "write", "read-only", "read-only"],
    );
    const before = f.store.inspect("run");
    assert.equal(before.totals.modelDispatches, 5);
    assert.equal(before.budgets[0]?.reserved, 5);
    assert.equal(before.totals.unresolved, 0);
    await f
      .runtime({ live: false, budget })
      .run((r) => qualificationWorkflow(r, agent));
    assert.equal(harness.calls.length, 5);
    assert.equal(f.store.inspect("run").totals.modelDispatches, 5);
  } finally {
    f.close();
  }
});
