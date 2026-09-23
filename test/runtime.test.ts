import test from "node:test";
import assert from "node:assert/strict";
import { fixture, Scripted, accounting } from "./helpers.js";
import { incomplete } from "../src/accounting.js";
import { sleep } from "../src/util.js";
import type { Receipt } from "../src/types.js";
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

test("raw, typed, same-session correction, native continuation; replay is no dispatch", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad", '{"ok":true}', "continued"]);
    const config = { harness: h, model: "test-model" };
    const workflow = async (r: ReturnType<typeof f.runtime>) => {
      const first = await r.agent<{ ok: boolean }>("typed", config, {
        prompt: "answer",
        schema,
        corrections: 1,
      });
      assert.equal(first.value.ok, true);
      return r.agent("next", config, {
        prompt: "continue",
        session: first.session,
      });
    };
    const first = await f.runtime().run(workflow);
    assert.equal(first.value, "continued");
    assert.equal(h.calls[1]?.session?.nativeId, h.calls[2]?.session?.nativeId);
    assert.match(h.calls[1]!.prompt, /Format correction only/);
    const count = f.store.db
      .prepare("SELECT COUNT(*) AS n FROM ledger")
      .get()?.n;
    assert.equal(count, 3);
    assert.deepEqual(await f.runtime().run(workflow), first);
    assert.equal(h.calls.length, 3);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM ledger").get()?.n,
      3,
    );
    assert.ok(f.store.events("run").some((e) => e.type === "action.replayed"));
  } finally {
    f.close();
  }
});
test("content disabled does not disable accounting; trace payload bounded", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["secret"]);
    await f
      .runtime()
      .run((r) =>
        r.agent(
          "a",
          { harness: h, model: "test-model" },
          { prompt: "private" },
        ),
      );
    const events = f.store.events("run");
    assert.ok(!JSON.stringify(events).includes("secret"));
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n,
      1,
    );
    f.store.event("run", "a", null, null, "large", {
      value: "é".repeat(20000),
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(f.store.events("run").at(-1))) < 9000,
    );
  } finally {
    f.close();
  }
});
test("action request identity, duplicate scoped IDs, concurrent independent scopes", async () => {
  const f = fixture();
  try {
    const h = new Scripted();
    const config = { harness: h, model: "test-model" };
    await f
      .runtime()
      .run((r) =>
        Promise.all(
          ["one", "two"].map((s) =>
            r.scope(s).agent("a", config, { prompt: s }),
          ),
        ),
      );
    assert.equal(h.calls.length, 2);
    await assert.rejects(
      f
        .runtime()
        .run((r) => r.scope("one").agent("a", config, { prompt: "changed" })),
      /request changed/,
    );
    await assert.rejects(
      f.runtime({ runId: "dup" }).run(async (r) => {
        await r.agent("a", config, { prompt: "a" });
        await r.agent("a", config, { prompt: "a" });
      }),
      /Duplicate action/,
    );
  } finally {
    f.close();
  }
});
test("incomplete failure preserves usable report and blocks further dispatch", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (_r, s) => {
        s.report("usage", accounting);
        throw new Error("transport lost");
      },
    ]);
    h.live = true;
    await assert.rejects(
      f
        .runtime({ live: true })
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "a" }),
        ),
      /transport lost/,
    );
    const ledger = f.store.db.prepare("SELECT data FROM ledger").get();
    assert.match(String(ledger?.data), /0.001/);
    await assert.rejects(
      f
        .runtime({ live: true })
        .run((r) =>
          r.agent("b", { harness: h, model: "test-model" }, { prompt: "b" }),
        ),
      /Incomplete accounting/,
    );
    assert.equal(h.calls.length, 1);
  } finally {
    f.close();
  }
});
test("reservation abandonment is uncertain, never replayed even with complete report", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (_r, s) => {
        s.report("usage", accounting);
        throw new Error("crash");
      },
    ]);
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "a" }),
        ),
    );
    f.store.db
      .prepare("UPDATE actions SET status='pending' WHERE id='a'")
      .run();
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "a" }),
        ),
      /Uncertain send/,
    );
    assert.equal(h.calls.length, 1);
  } finally {
    f.close();
  }
});
test("durable receipt recovers local validation/parent commit without resend", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad", '{"ok":true}']);
    const c = { harness: h, model: "test-model" };
    const workflow = (r: ReturnType<typeof f.runtime>) =>
      r.agent("a", c, { prompt: "x", schema, corrections: 1 });
    const result = await f.runtime().run(workflow);
    // Exact post-receipt/pre-action-commit storage image.
    f.store.db
      .prepare("UPDATE actions SET status='pending',result=NULL WHERE id='a'")
      .run();
    assert.deepEqual(await f.runtime().run(workflow), result);
    assert.equal(h.calls.length, 2);
  } finally {
    f.close();
  }
});
test("malformed, oversized and schema failures retain raw receipts before validation", async () => {
  for (const text of ["not json", '{"ok":2}', "x".repeat(100000)]) {
    const f = fixture();
    try {
      const h = new Scripted([text]);
      await assert.rejects(
        f
          .runtime()
          .run((r) =>
            r.agent(
              "a",
              { harness: h, model: "test-model" },
              { prompt: "x", schema },
            ),
          ),
        /validation|limit/,
      );
      const receipt = JSON.parse(
        String(
          f.store.db.prepare("SELECT receipt FROM invocations").get()?.receipt,
        ),
      ) as Receipt;
      assert.ok(receipt.text.length <= 65536);
      assert.equal(receipt.accounting.usd, 0.001);
    } finally {
      f.close();
    }
  }
});
test("cancellation/timeouts retain known failed usage and cannot correct failure", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (r, s) => {
        s.report("before", accounting);
        await new Promise<void>((resolve) =>
          r.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          status: "cancelled",
          text: "partial",
          accounting: incomplete("test-model", "cancelled", accounting),
        };
      },
    ]);
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          r.agent(
            "a",
            { harness: h, model: "test-model", timeoutMs: 10 },
            { prompt: "x", schema, corrections: 1 },
          ),
        ),
      /Incomplete accounting/,
    );
    assert.equal(h.calls.length, 1);
  } finally {
    f.close();
  }
});
test("concurrent run ownership and same native session exclusion", async () => {
  const f = fixture();
  try {
    const owner = f.store.claim("locked", "wf");
    assert.throws(() => f.store.claim("locked", "wf"), /already executing/);
    f.store.release("locked", owner);
    const h = new Scripted([
      "start",
      async (r) => {
        await sleep(40);
        return {
          status: "succeeded",
          text: "end",
          session: r.session,
          accounting,
        };
      },
    ]);
    const c = { harness: h, model: "test-model" };
    await assert.rejects(
      f.runtime().run(async (r) => {
        const a = await r.agent("a", c, { prompt: "x" });
        await Promise.all(
          ["b", "c"].map((id) =>
            r.agent(id, c, { prompt: "y", session: a.session }),
          ),
        );
      }),
      /busy/,
    );
    assert.equal(h.calls.length, 2);
  } finally {
    f.close();
  }
});
test("hard budget reserved before invoke; replay consumes no budget; immutable limits", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async () => {
        assert.equal(
          f.store.db.prepare("SELECT COUNT(*) AS n FROM invocations").get()?.n,
          1,
        );
        return {
          status: "succeeded",
          text: "ok",
          session: { nativeId: "s", baseline: 0 },
          accounting,
        };
      },
    ]);
    h.live = true;
    const options = {
      live: true,
      budget: { id: "global", maxDispatches: 1, softUsd: 1 },
    };
    await f
      .runtime(options)
      .run((r) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
      );
    await f
      .runtime(options)
      .run((r) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
      );
    await assert.rejects(
      f
        .runtime({ ...options, runId: "run2" })
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
        ),
      /budget exhausted/,
    );
    assert.equal(h.calls.length, 1);
    assert.throws(
      () => f.store.db.prepare("UPDATE ledger SET usd=0").run(),
      /immutable/,
    );
  } finally {
    f.close();
  }
});
test("commands can branch on failure; replay never reruns; bounded output", async () => {
  const f = fixture();
  try {
    const result = await f.runtime().run(async (r) => {
      const a = await r.command("negative", [
        "node",
        "-e",
        'console.log("x".repeat(200000));process.exit(2)',
      ]);
      assert.equal(a.code, 2);
      assert.equal(a.truncated, true);
      return r.command("repair", ["node", "-e", 'console.log("ok")']);
    });
    assert.equal(result.stdout, "ok\n");
    const replay = await f
      .runtime()
      .run((r) => r.command("repair", ["node", "-e", 'console.log("ok")']));
    assert.deepEqual(replay, result);
  } finally {
    f.close();
  }
});

test("session baseline compare-and-swap rejects stale preflight continuation", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["start", "fast"]);
    const c = { harness: h, model: "test-model" };
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    h.preflight = async (
      q?: Omit<import("../src/types.js").HarnessRequest, "signal">,
    ) => {
      if (q?.prompt === "slow") {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
      }
    };
    await f.runtime().run(async (r) => {
      const a = await r.agent("a", c, { prompt: "start" });
      const slow = r.agent("slow", c, { prompt: "slow", session: a.session });
      await ready;
      await r.agent("fast", c, { prompt: "fast", session: a.session });
      release();
      await assert.rejects(slow, /advanced/);
    });
    assert.equal(h.calls.length, 2);
  } finally {
    f.close();
  }
});
test("ordinary catch and finite repair after known format failure; session ownership enforced", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad", '{"ok":true}']);
    const c = { harness: h, model: "test-model" };
    await f.runtime().run(async (r) => {
      try {
        await r.agent("bad", c, { prompt: "x", schema });
      } catch {
        await r.agent("repair", c, { prompt: "fix", schema });
      }
    });
    const result = JSON.parse(
      String(
        f.store.db.prepare("SELECT result FROM actions WHERE id='repair'").get()
          ?.result,
      ),
    ) as { session: string };
    await assert.rejects(
      f
        .runtime({ runId: "other" })
        .run((r) =>
          r.agent("steal", c, { prompt: "x", session: result.session }),
        ),
      /not owned/,
    );
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          r.agent(
            "policy-change",
            { ...c, mode: "write" },
            { prompt: "x", session: result.session },
          ),
        ),
      /not owned/,
    );
  } finally {
    f.close();
  }
});
test("trace overflow is lossy only; mandatory reports never share its budget", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (_r, s) => {
        for (let i = 0; i < 600; i++)
          s.event({
            type: "tool",
            data: { text: "x".repeat(300000) },
            content: true,
          });
        s.report("late", accounting);
        return {
          status: "succeeded",
          text: "ok",
          accounting,
          session: { nativeId: "s", baseline: 0 },
        };
      },
    ]);
    await f
      .runtime({ traceContent: true })
      .run((r) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
      );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type='tool'")
        .get()?.n,
      500,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("terminal zero reset cannot erase a known usable report", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (_r, s) => {
        s.report("before", accounting);
        return {
          status: "failed",
          text: "partial",
          accounting: incomplete("test-model", "crashed"),
        };
      },
    ]);
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
        ),
      /Incomplete/,
    );
    const row = f.store.db.prepare("SELECT data FROM ledger").get();
    assert.equal((JSON.parse(String(row?.data)) as { usd: number }).usd, 0.001);
  } finally {
    f.close();
  }
});

test("raw control-character output remains durably recoverable within byte bounds", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["\0".repeat(65536)]);
    const result = await f
      .runtime()
      .run((r) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
      );
    assert.equal(result.text.length, 65536);
    const c = await f
      .runtime()
      .run((r) =>
        r.command("binary", [
          "node",
          "-e",
          `process.stdout.write(Buffer.alloc(50000));process.stderr.write(Buffer.alloc(50000));`,
        ]),
      );
    assert.equal(c.truncated, true);
    assert.equal(c.stdout.length, 24 * 1024);
  } finally {
    f.close();
  }
});
