import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexHarness, type CodexPort } from "../src/adapters/codex.js";
import type { Receipt } from "../src/types.js";
import { fixture, pricing } from "./helpers.js";
import { encode } from "../src/util.js";

const generic = "Codex exec exited with code 1";
const message = "native request rejected: detailed cause";
const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 1,
};
const terminal: ThreadEvent = { type: "turn.completed", usage };
const item = (message: string): ThreadEvent => ({
  type: "item.completed",
  item: { id: "diagnostic", type: "error", message },
});
const failure = (message: string): ThreadEvent => ({
  type: "turn.failed",
  error: { message },
});
const topError = (message: string): ThreadEvent => ({ type: "error", message });

function synthetic(events: ThreadEvent[], thrown?: string) {
  let calls = 0;
  const thread = () => ({
    async runStreamed() {
      calls++;
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "owned" } as ThreadEvent;
          for (const event of events) yield event;
          if (thrown !== undefined) throw new Error(thrown);
        })(),
      };
    },
  });
  const client: CodexPort = { startThread: thread, resumeThread: thread };
  return {
    harness: new CodexHarness({
      pricing,
      client,
      checkVersion: async () => {},
    }),
    calls: () => calls,
  };
}

async function invoke(harness: CodexHarness, cwd: string) {
  return harness.invoke(
    {
      model: "test-model",
      prompt: "synthetic",
      cwd,
      mode: "read-only",
      signal: AbortSignal.timeout(5000),
    },
    { event() {}, report() {} },
  );
}

for (const traceContent of [false, true]) {
  for (const diagnostic of [failure, topError, item]) {
    test(`native ${diagnostic.name} survives SDK throw with trace ${traceContent}`, async () => {
      const f = fixture();
      try {
        const noise = Array.from(
          { length: traceContent ? 501 : 1 },
          (_, i): ThreadEvent => ({
            type: "item.completed",
            item: {
              id: `message-${i}`,
              type: "agent_message",
              text: "NOT_JSON",
            },
          }),
        );
        const c = synthetic([...noise, terminal, diagnostic(message)], generic);
        await f.runtime({ live: true, traceContent }).run(async (r) => {
          const config = { harness: c.harness, model: "test-model" };
          await assert.rejects(
            r.agent("typed", config, {
              prompt: "synthetic",
              schema: { type: "object" },
              corrections: 1,
            }),
            /Incomplete accounting: native request rejected/,
          );
          await assert.rejects(
            r.agent("next", config, { prompt: "synthetic" }),
            /Incomplete accounting\/uncertain send blocks dispatch/,
          );
        });
        assert.equal(c.calls(), 1);
        const rows = f.store.db
          .prepare("SELECT receipt FROM invocations")
          .all();
        assert.equal(rows.length, 1);
        const receipt = JSON.parse(String(rows[0]!.receipt)) as Receipt;
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.text, "NOT_JSON");
        assert.equal(receipt.error, `${message}\nSDK/invocation: ${generic}`);
        assert.equal(receipt.accounting.reason, receipt.error);
        assert.equal(receipt.accounting.status, "incomplete");
        assert.deepEqual(receipt.accounting.raw, usage);
        assert.equal(receipt.accounting.usd, 25 / 1e6);
        assert.equal(receipt.session, undefined);
        const totals = f.store.inspect("run").totals;
        assert.equal(totals.knownUsd, 25 / 1e6);
        assert.equal(totals.unresolved, 1);
        assert.equal(totals.modelDispatches, 1);
        if (traceContent)
          assert.ok(
            f.store.db
              .prepare("SELECT 1 FROM events WHERE type='trace.truncated'")
              .get(),
          );
      } finally {
        f.close();
      }
    });
  }
}

test("native-only diagnostics, SDK fallback, terminal priority and successful warnings", async () => {
  const f = fixture();
  try {
    for (const events of [
      [failure(message)],
      [topError(message)],
      [item(message)],
    ]) {
      const receipt = await invoke(synthetic(events).harness, f.dir);
      assert.equal(receipt.status, "failed");
      // Missing terminal usage fails closed; the retained item explains that failure.
      assert.equal(receipt.error, message);
      assert.equal(receipt.accounting.reason, message);
      assert.equal(receipt.accounting.usd, null);
    }
    const fallback = await invoke(synthetic([], generic).harness, f.dir);
    assert.equal(fallback.error, generic);
    assert.equal(fallback.accounting.reason, generic);
    assert.equal(fallback.accounting.usd, null);
    const priority = await invoke(
      synthetic([item("warning"), failure(message)], generic).harness,
      f.dir,
    );
    assert.equal(priority.error, `${message}\nSDK/invocation: ${generic}`);
    const success = await invoke(
      synthetic([item("ordinary warning"), terminal]).harness,
      f.dir,
    );
    assert.equal(success.status, "succeeded");
    assert.equal(success.error, undefined);
    assert.equal(success.accounting.reason, undefined);
    assert.equal(success.accounting.status, "complete");
    assert.deepEqual(success.session, {
      nativeId: "owned",
      baseline: {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 5,
        reasoning: 1,
      },
    });
  } finally {
    f.close();
  }
});

test("reroute remains primary and accounting fails closed before or after usage", async () => {
  const f = fixture();
  try {
    const notice = "model rerouted: test-model -> other-model";
    for (const events of [
      [item(notice), terminal],
      [terminal, item(notice)],
    ]) {
      const receipt = await invoke(
        synthetic([...events, failure(message)], generic).harness,
        f.dir,
      );
      assert.equal(receipt.error, `${notice}\nSDK/invocation: ${generic}`);
      assert.equal(receipt.accounting.reason, receipt.error);
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.accounting.status, "incomplete");
      assert.equal(receipt.accounting.usd, 25 / 1e6);
      assert.equal(receipt.session, undefined);
    }
  } finally {
    f.close();
  }
});

test("long multibyte and control diagnostics fit receipt and serialized accounting bounds", async () => {
  const f = fixture();
  try {
    for (const diagnostic of [failure, topError, item]) {
      for (const thrown of [
        undefined,
        `SDK detail ${"\u0000😀".repeat(5000)}`,
      ]) {
        const receipt = await invoke(
          synthetic(
            [
              terminal,
              diagnostic(`native cause ${"😀\u0000\n\t".repeat(10000)}`),
            ],
            thrown,
          ).harness,
          f.dir,
        );
        if (diagnostic === item && thrown === undefined) {
          assert.equal(receipt.status, "succeeded");
          continue;
        }
        assert.ok(receipt.error);
        assert.ok(receipt.error.startsWith("native cause"));
        assert.ok(!receipt.error.includes("\uFFFD"));
        assert.ok(Buffer.byteLength(receipt.error) <= 4096);
        assert.ok(Buffer.byteLength(JSON.stringify(receipt.error)) <= 4096);
        assert.equal(receipt.accounting.reason, receipt.error);
        if (thrown) assert.match(receipt.error, /SDK\/invocation: SDK detail/);
        encode(receipt, 1024 * 1024);
        encode(receipt.accounting, 16 * 1024);
      }
    }
  } finally {
    f.close();
  }
});

test("real official SDK retains JSON native failure when synthetic executable exits 1", async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, "synthetic-codex.cjs");
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "synthetic-owned" },
      item("native item detail"),
      terminal,
      failure(message),
    ];
    writeFileSync(
      executable,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join("\n") + "\n")}, () => process.exit(1));
});
`,
      { mode: 0o700 },
    );
    // The official SDK/launcher runs only this local fixture, never a provider CLI.
    const receipt = await invoke(
      new CodexHarness({ pricing, executable }),
      f.dir,
    );
    assert.equal(receipt.status, "failed");
    assert.ok(receipt.error);
    assert.ok(receipt.error.startsWith(`${message}\nSDK/invocation:`));
    assert.match(receipt.error, /exited with code 1/);
    assert.equal(receipt.accounting.reason, receipt.error);
    assert.deepEqual(receipt.accounting.raw, usage);
    assert.equal(receipt.accounting.usd, 25 / 1e6);
    assert.equal(receipt.accounting.status, "incomplete");
    assert.equal(receipt.session, undefined);
  } finally {
    f.close();
  }
});
