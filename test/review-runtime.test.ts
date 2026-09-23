import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fixture, Scripted, accounting } from "./helpers.js";
import { knownUsd, incomplete, validateAccounting } from "../src/accounting.js";
import type { Accounting } from "../src/types.js";

const schema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
  additionalProperties: false,
};

test("empty and falsy action failures persist failure events and reject replay without resend", async () => {
  for (const error of [new Error(""), null, undefined, false, 0, ""]) {
    const f = fixture();
    try {
      const h = new Scripted([
        async () => {
          throw error;
        },
      ]);
      const run = () =>
        f
          .runtime()
          .run((r) =>
            r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
          );
      await assert.rejects(run());
      assert.equal(
        f.store.db.prepare("SELECT status FROM runs").get()?.status,
        "failed",
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM actions").get()?.status,
        "failed",
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM invocations").get()?.status,
        "uncertain",
      );
      const types = f.store.events("run").map((e) => e.type);
      assert.ok(
        types.includes("action.failed") && types.includes("run.failed"),
      );
      assert.ok(
        !types.includes("action.completed") && !types.includes("run.completed"),
      );
      await assert.rejects(run(), {
        message: error instanceof Error ? error.message : String(error),
      });
      assert.equal(h.calls.length, 1);
    } finally {
      f.close();
    }
  }
});

test("falsy uncaught workflow rejections are not run completion", async () => {
  for (const error of [new Error(""), null, undefined, false, 0, ""]) {
    const f = fixture();
    try {
      await assert.rejects(
        f.runtime().run(async () => {
          throw error;
        }),
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM runs").get()?.status,
        "failed",
      );
      assert.equal(f.store.events("run").at(-1)?.type, "run.failed");
    } finally {
      f.close();
    }
  }
});

test("explicit resume after acknowledgement or temporary preflight gate sends only once", async () => {
  for (const gate of ["live", "preflight"]) {
    const f = fixture();
    try {
      const h = new Scripted();
      h.live = true;
      let checks = 0;
      h.preflight = async () => {
        checks++;
        if (gate === "preflight" && checks === 1)
          throw new Error("temporary preflight");
      };
      const workflow = (r: ReturnType<typeof f.runtime>) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" });
      await assert.rejects(
        f.runtime({ live: gate !== "live" }).run(workflow),
        /acknowledgement|temporary/,
      );
      assert.equal(h.calls.length, 0);
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM invocations").get()?.n,
        0,
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM actions").get()?.status,
        "pending",
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM runs").get()?.status,
        "failed",
      );
      assert.ok(f.store.events("run").some((e) => e.type === "action.blocked"));
      await assert.rejects(
        f
          .runtime({ live: true })
          .run((r) =>
            r.agent(
              "a",
              { harness: h, model: "test-model" },
              { prompt: "changed" },
            ),
          ),
        /request changed/,
      );
      await f.runtime({ live: true }).run(workflow);
      assert.equal(h.calls.length, 1);
      assert.equal(checks, gate === "live" ? 1 : 2);
    } finally {
      f.close();
    }
  }
});

test("post-receipt correction survives blocked live/preflight resume with fresh mocks", async () => {
  const f = fixture();
  try {
    const source = `import {Runtime} from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)};
      import {Store} from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import {Scripted} from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};
      const store=new Store(${JSON.stringify(f.store.path)});
      const receipt=store.receipt.bind(store); store.receipt=(...args)=>{receipt(...args);process.exit(0);};
      const h=new Scripted(['{}']);h.live=true;
      await new Runtime({store,cwd:${JSON.stringify(f.dir)},runId:'run',workflowIdentity:'wf',live:true}).run(r=>r.agent('a',{harness:h,model:'test-model'},{prompt:'x',schema:${JSON.stringify(schema)},corrections:1}));`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const original = f.store.invocation("run", "a", 0)!;
    const workflow = (h: Scripted) => (r: ReturnType<typeof f.runtime>) =>
      r.agent(
        "a",
        { harness: h, model: "test-model" },
        { prompt: "x", schema, corrections: 1 },
      );
    const blocked = new Scripted();
    blocked.live = true;
    await assert.rejects(f.runtime().run(workflow(blocked)), /acknowledgement/);
    assert.equal(blocked.calls.length, 0);
    const preflight = new Scripted();
    preflight.live = true;
    preflight.preflight = async () => {
      throw new Error("temporary preflight");
    };
    await assert.rejects(
      f.runtime({ live: true }).run(workflow(preflight)),
      /temporary/,
    );
    assert.equal(preflight.calls.length, 0);
    assert.equal(f.store.invocation("run", "a", 1), undefined);
    const resumed = new Scripted([
      async () => ({
        status: "succeeded",
        text: '{"ok":true}',
        accounting,
        session: { nativeId: "native-1", baseline: 2 },
      }),
    ]);
    resumed.live = true;
    const result = await f.runtime({ live: true }).run(workflow(resumed));
    assert.deepEqual(result.value, { ok: true });
    assert.equal(resumed.calls.length, 1);
    assert.deepEqual(resumed.calls[0]?.session, {
      nativeId: "native-1",
      baseline: 1,
    });
    assert.match(resumed.calls[0]!.prompt, /Format correction only/);
    assert.deepEqual(f.store.invocation("run", "a", 0), original);
    assert.equal(f.store.invocation("run", "a", 1)?.session, original.session);
    assert.equal(f.store.invocation("run", "a", 2), undefined);
    assert.deepEqual(
      JSON.parse(
        String(
          f.store.db
            .prepare("SELECT native FROM sessions WHERE id=?")
            .get(original.session!)?.native,
        ),
      ),
      { nativeId: "native-1", baseline: 2 },
    );
    const refusals = f.store
      .events("run")
      .filter((e) => e.type === "action.blocked");
    assert.equal(refusals.length, 2);
    for (const event of refusals) {
      assert.equal(event.turn, 1);
      assert.equal(event.invocationId, null);
      assert.match(JSON.stringify(event.data), /"recoverable":true/);
    }
    const validation = f.store
      .events("run")
      .find((e) => e.type === "output.validation_failed");
    assert.equal(validation?.turn, 0);
    assert.equal(validation?.invocationId, original.id);
    assert.match(JSON.stringify(validation?.data), /required|ok/);
    assert.match(JSON.stringify(validation?.data), /schemaHash/);
    assert.ok(!JSON.stringify(validation?.data).includes("Format correction"));
    const replay = new Scripted();
    replay.live = true;
    await f.runtime().run(workflow(replay));
    assert.equal(replay.calls.length, 0);
  } finally {
    f.close();
  }
});

test("reservation attempt failure remains terminal, even if nothing persisted", async () => {
  const f = fixture();
  try {
    const reserve = f.store.reserve.bind(f.store);
    f.store.reserve = () => {
      throw new Error("reservation failed");
    };
    const h = new Scripted();
    const run = () =>
      f
        .runtime()
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
        );
    await assert.rejects(run(), /reservation failed/);
    f.store.reserve = reserve;
    await assert.rejects(run(), { message: "reservation failed" });
    assert.equal(h.calls.length, 0);
    assert.equal(
      f.store.db.prepare("SELECT status FROM actions").get()?.status,
      "failed",
    );
  } finally {
    f.close();
  }
});

test("post-reservation setup failure becomes uncertain, blocks later dispatch, and replays without send", async () => {
  const f = fixture();
  try {
    const event = f.store.event.bind(f.store);
    let injected = false;
    f.store.event = (run, action, invocation, turn, type, data, source) => {
      if (!injected && type === "invocation.request") {
        injected = true;
        throw new Error("injected request event failure");
      }
      event(run, action, invocation, turn, type, data, source);
    };
    const h = new Scripted();
    h.live = true;
    const workflow = async (r: ReturnType<typeof f.runtime>) => {
      await assert.rejects(
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "a" }),
        /injected request event failure/,
      );
      await assert.rejects(
        r.agent("b", { harness: h, model: "test-model" }, { prompt: "b" }),
        /Incomplete accounting\/uncertain send blocks dispatch/,
      );
      return "caught";
    };
    assert.equal(await f.runtime({ live: true }).run(workflow), "caught");
    assert.equal(h.calls.length, 0);
    assert.deepEqual(
      f.store.db
        .prepare("SELECT action,status FROM invocations ORDER BY rowid")
        .all()
        .map((row) => ({ ...row })),
      [{ action: "a", status: "uncertain" }],
    );
    assert.equal(
      f.store.db.prepare("SELECT complete FROM ledger").get()?.complete,
      0,
    );
    assert.equal(await f.runtime({ live: true }).run(workflow), "caught");
    assert.equal(h.calls.length, 0);
  } finally {
    f.close();
  }
});

test("handled parallel validation failures honor fallback regardless of sibling timing", async () => {
  for (const settleBeforeReturn of [false, true]) {
    const f = fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const h = new Scripted([
        "bad",
        async () => {
          await gate;
          return {
            status: "succeeded",
            text: "bad",
            accounting,
            session: { nativeId: "second", baseline: 1 },
          };
        },
      ]);
      const result = await f.runtime().run(async (r) => {
        const actions = ["fast", "slow"].map((id) =>
          r.agent(
            id,
            { harness: h, model: "test-model" },
            { prompt: id, schema },
          ),
        );
        try {
          await Promise.all(actions);
        } catch (e) {
          assert.match((e as Error).message, /^Output validation failed:/);
          if (settleBeforeReturn) {
            release();
            await Promise.allSettled(actions);
          } else setImmediate(release);
          return "fallback";
        }
        throw new Error("expected failure");
      });
      assert.equal(result, "fallback");
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) n FROM actions WHERE status='failed'")
          .get()?.n,
        2,
      );
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) n FROM ledger WHERE complete=1")
          .get()?.n,
        2,
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM runs").get()?.status,
        "completed",
      );
    } finally {
      f.close();
    }
  }
});

test("selective validation and command failure catches are identical on replay", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad"]);
    const workflow = async (r: ReturnType<typeof f.runtime>) => {
      try {
        await r.agent(
          "a",
          { harness: h, model: "test-model" },
          { prompt: "x", schema },
        );
      } catch (e) {
        if (
          !(e instanceof Error) ||
          !e.message.startsWith("Output validation failed:")
        )
          throw e;
      }
      try {
        await r.command("c", []);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "Invalid argv") throw e;
        return "fallback";
      }
      throw new Error("expected command failure");
    };
    assert.equal(await f.runtime().run(workflow), "fallback");
    assert.equal(await f.runtime().run(workflow), "fallback");
    assert.equal(h.calls.length, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM invocations").get()?.n,
      2,
    );
  } finally {
    f.close();
  }
});

const auxiliary = {
  usd: 10,
  kind: "harness-estimated",
  scope: "auxiliary",
  model: null,
  source: "fixture",
  version: "1",
} as const;
test("complete accounting rejects unknown auxiliary cost and blocks later dispatch", async () => {
  const invalid: Accounting = {
    ...accounting,
    additional: [{ ...auxiliary, usd: null }],
  };
  assert.throws(() => validateAccounting(invalid), /Complete accounting/);
  const f = fixture();
  try {
    const h = new Scripted([
      async () => ({ status: "succeeded", text: "x", accounting: invalid }),
    ]);
    h.live = true;
    await f.runtime({ live: true }).run(async (r) => {
      await assert.rejects(
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
        /Complete accounting/,
      );
      await assert.rejects(
        r.agent("b", { harness: h, model: "test-model" }, { prompt: "x" }),
        /Incomplete accounting/,
      );
    });
    assert.equal(h.calls.length, 1);
  } finally {
    f.close();
  }
});

test("incomplete reports survive later equal or higher snapshots in ledger, inspection, and gates", async () => {
  for (const scenario of [
    { name: "equal terminal", later: undefined, terminal: 1, expected: 1 },
    { name: "higher terminal", later: undefined, terminal: 3, expected: 3 },
    { name: "earlier weaker report", later: 2, terminal: 3, expected: 3 },
  ]) {
    const f = fixture();
    try {
      const unresolved: Accounting = {
        ...accounting,
        status: "incomplete",
        reason: "unknown auxiliary",
        usd: 1,
        additional: [{ ...auxiliary, usd: null }],
      };
      const h = new Scripted([
        async (_request, sink) => {
          sink.report("unresolved", unresolved);
          if (scenario.later !== undefined)
            sink.report("later-complete", {
              ...accounting,
              usd: scenario.later,
            });
          return {
            status: "succeeded",
            text: "not json",
            accounting: { ...accounting, usd: scenario.terminal },
            session: { nativeId: "native", baseline: 1 },
          };
        },
      ]);
      h.live = true;
      const options = {
        live: true,
        budget: { id: "shared", maxDispatches: 10, softUsd: 100 },
      };
      await f.runtime(options).run(async (r) => {
        await assert.rejects(
          r.agent(
            "a",
            { harness: h, model: "test-model" },
            { prompt: scenario.name, schema, corrections: 1 },
          ),
          /Incomplete accounting/,
        );
        await assert.rejects(
          r.agent(
            "blocked",
            { harness: h, model: "test-model" },
            { prompt: "blocked" },
          ),
          /Incomplete accounting\/uncertain send blocks dispatch/,
        );
      });
      assert.equal(h.calls.length, 1, scenario.name);
      const row = f.store.db
        .prepare("SELECT data,usd,complete FROM ledger")
        .get();
      const retained = JSON.parse(String(row?.data)) as Accounting;
      assert.equal(retained.status, "incomplete", scenario.name);
      assert.equal(knownUsd(retained), scenario.expected, scenario.name);
      assert.equal(row?.usd, scenario.expected, scenario.name);
      assert.equal(row?.complete, 0, scenario.name);
      const receipt = JSON.parse(
        String(
          f.store.db.prepare("SELECT receipt FROM invocations").get()?.receipt,
        ),
      ) as { accounting: Accounting };
      assert.deepEqual(receipt.accounting, retained, scenario.name);
      const inspection = f.store.inspect("run");
      assert.equal(inspection.totals.unresolved, 1, scenario.name);
      assert.equal(
        inspection.totals.knownUsd,
        scenario.expected,
        scenario.name,
      );
      assert.equal(inspection.budgets[0]?.unresolved, 1, scenario.name);
      await assert.rejects(
        f
          .runtime({ ...options, runId: `other-${scenario.terminal}` })
          .run((r) =>
            r.agent(
              "other",
              { harness: h, model: "test-model" },
              { prompt: "other" },
            ),
          ),
        /budget exhausted or has unresolved accounting/,
      );
      assert.equal(h.calls.length, 1, scenario.name);
    } finally {
      f.close();
    }
  }
});

test("report recovery keeps strongest total including auxiliary amounts, never sums snapshots", async () => {
  for (const terminal of [false, true]) {
    const f = fixture();
    try {
      const strong: Accounting = {
        ...accounting,
        usd: 1,
        additional: [auxiliary, { ...auxiliary, usd: null }],
        status: "incomplete",
      };
      const h = new Scripted([
        async (_r, s) => {
          s.report("strong", strong);
          s.report("primary-only", { ...accounting, usd: 2 });
          s.report("unknown", incomplete("test-model", "reset"));
          if (!terminal) throw new Error("transport lost");
          return {
            status: "failed",
            text: "",
            accounting: { ...accounting, usd: 2 },
          };
        },
      ]);
      await assert.rejects(
        f
          .runtime()
          .run((r) =>
            r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
          ),
      );
      const final = JSON.parse(
        String(f.store.db.prepare("SELECT data FROM ledger").get()?.data),
      ) as Accounting;
      assert.equal(knownUsd(final), 11);
      assert.equal(final.status, "incomplete");
      assert.equal(final.additional?.[1]?.usd, null);
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) n FROM reports").get()?.n,
        3,
      );
    } finally {
      f.close();
    }
  }
});

test("successful receipts without a new native baseline fail after durable accounting and never resend", async () => {
  for (const continuation of [false, true]) {
    const f = fixture();
    try {
      const h = new Scripted(
        continuation
          ? [
              "start",
              async () => ({
                status: "succeeded",
                text: "continued",
                accounting,
              }),
            ]
          : [
              async () => ({
                status: "succeeded",
                text: "fresh",
                accounting,
              }),
            ],
      );
      let firstSession: string | undefined;
      if (continuation)
        firstSession = (
          await f
            .runtime()
            .run((r) =>
              r.agent(
                "start",
                { harness: h, model: "test-model" },
                { prompt: "start" },
              ),
            )
        ).session;
      const action = continuation ? "continue" : "fresh";
      const run = () =>
        f.runtime().run((r) =>
          r.agent(
            action,
            { harness: h, model: "test-model" },
            {
              prompt: action,
              ...(firstSession ? { session: firstSession } : {}),
            },
          ),
        );
      await assert.rejects(run(), /Native session baseline missing/);
      const calls = continuation ? 2 : 1;
      assert.equal(h.calls.length, calls);
      const invocation = f.store.invocation("run", action, 0)!;
      assert.equal(invocation.status, "received");
      const receipt = JSON.parse(String(invocation.receipt)) as {
        accounting: Accounting;
        session?: unknown;
      };
      assert.equal(receipt.session, undefined);
      assert.equal(receipt.accounting.status, "complete");
      assert.equal(
        f.store.db
          .prepare("SELECT complete FROM ledger WHERE invocation=?")
          .get(invocation.id)?.complete,
        1,
      );
      if (continuation) {
        assert.equal(invocation.session, firstSession);
        assert.equal(
          f.store.db
            .prepare("SELECT busy FROM sessions WHERE id=?")
            .get(firstSession!)?.busy,
          invocation.id,
        );
      }
      await assert.rejects(run(), /Native session baseline missing/);
      assert.equal(h.calls.length, calls);
    } finally {
      f.close();
    }
  }
});

test("native failure remains terminal on explicit later run, not a preflight recovery", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async () => ({
        status: "failed",
        text: "bad",
        error: "native failed",
        accounting,
        session: { nativeId: "s", baseline: 1 },
      }),
    ]);
    h.live = true;
    const run = () =>
      f
        .runtime({ live: true })
        .run((r) =>
          r.agent(
            "a",
            { harness: h, model: "test-model" },
            { prompt: "x", schema, corrections: 1 },
          ),
        );
    await assert.rejects(run(), { message: "native failed" });
    await assert.rejects(run(), { message: "native failed" });
    assert.equal(h.calls.length, 1);
    assert.ok(!f.store.events("run").some((e) => e.type === "action.blocked"));
  } finally {
    f.close();
  }
});
