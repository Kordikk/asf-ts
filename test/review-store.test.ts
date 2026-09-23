import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { boundedJson } from "../src/util.js";
import { fixture, Scripted, accounting } from "./helpers.js";
import type { Json } from "../src/types.js";

test("inspect uses a short readonly snapshot across an interleaved writer commit, and rolls back on error", () => {
  const f = fixture();
  const reader = new Store(f.store.path, true);
  try {
    const owner = f.store.claim("run", "wf");
    f.store.action("run", "a", "identity");
    const iid = f.store.reserve("run", "a", 0, undefined, undefined, false);
    const prepare = reader.db.prepare.bind(reader.db);
    let committed = false;
    reader.db.prepare = (sql) => {
      if (!committed && sql.includes("AS invocations")) {
        committed = true;
        f.store.receipt(
          "run",
          "a",
          iid,
          0,
          { status: "succeeded", text: "ok", accounting },
          "binding",
        );
      }
      return prepare(sql);
    };
    const before = reader.inspect("run");
    assert.equal(committed, true);
    assert.equal(before.invocations[0]?.status, "reserved");
    assert.equal(before.invocations[0]?.accounting, null);
    assert.equal(before.totals.knownUsd, null);
    assert.equal(before.totals.unresolved, 1);
    const after = reader.inspect("run");
    assert.equal(after.invocations[0]?.status, "received");
    assert.equal(after.totals.knownUsd, accounting.usd);
    assert.equal(after.totals.unresolved, 0);
    reader.db.prepare = (sql) => {
      if (sql.includes("AS invocations"))
        throw new Error("injected read failure");
      return prepare(sql);
    };
    assert.throws(() => reader.inspect("run"), /injected read failure/);
    reader.db.prepare = prepare;
    assert.deepEqual(reader.inspect("run"), after);
    f.store.release("run", owner);
  } finally {
    reader.close();
    f.close();
  }
});

test("inspection exposes unresolved legacy evidence without rewriting the complete ledger", () => {
  for (const evidence of ["report", "uncertain"] as const) {
    const f = fixture();
    const reader = new Store(f.store.path, true);
    try {
      const budget = { id: "shared", maxDispatches: 10, softUsd: 100 };
      const owner = f.store.claim("run", "wf");
      f.store.action("run", "a", "identity");
      const iid = f.store.reserve("run", "a", 0, undefined, budget, true);
      f.store.receipt(
        "run",
        "a",
        iid,
        0,
        { status: "succeeded", text: "ok", accounting },
        "binding",
      );
      const ledger = f.store.db.prepare("SELECT * FROM ledger").get();
      const unresolved = {
        ...accounting,
        status: "incomplete" as const,
        reason: "retained unresolved evidence",
      };
      // Construct the contradictory state possible before the reconciliation fix;
      // neither adding evidence nor reading it may replace an immutable ledger.
      if (evidence === "report") f.store.report(iid, "unresolved", unresolved);
      else f.store.uncertain("run", "a", iid, 0, unresolved, unresolved.reason);
      const inspection = reader.inspect("run");
      assert.equal(inspection.totals.unresolved, 1, evidence);
      assert.equal(inspection.budgets[0]?.unresolved, 1, evidence);
      assert.equal(inspection.totals.knownUsd, accounting.usd, evidence);
      assert.deepEqual(
        f.store.db.prepare("SELECT * FROM ledger").get(),
        ledger,
      );
      assert.equal(ledger?.complete, 1);
      f.store.action("run", "blocked", "identity");
      assert.throws(
        () => f.store.reserve("run", "blocked", 0, undefined, budget, true),
        /Incomplete accounting\/uncertain send blocks dispatch/,
      );
      const otherOwner = f.store.claim("other", "wf");
      f.store.action("other", "blocked", "identity");
      assert.throws(
        () => f.store.reserve("other", "blocked", 0, undefined, budget, true),
        /budget exhausted or has unresolved accounting/,
      );
      f.store.release("other", otherOwner);
      f.store.release("run", owner);
    } finally {
      reader.close();
      f.close();
    }
  }
});

test("long UTF-8 report keys are bounded, deduplicated, and collision resistant", () => {
  const f = fixture();
  try {
    const owner = f.store.claim("run", "wf");
    f.store.action("run", "a", "identity");
    const iid = f.store.reserve("run", "a", 0, undefined, undefined, false);
    const shared = "界".repeat(120);
    const first = `${shared}:first`;
    const second = `${shared}:second`;
    f.store.report(iid, first, accounting);
    f.store.report(iid, first, accounting);
    f.store.report(iid, second, accounting);
    const rows = f.store.db
      .prepare("SELECT key,data FROM reports ORDER BY rowid")
      .all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.key, rows[1]?.key);
    for (const row of rows) {
      assert.ok(Buffer.byteLength(String(row.key)) <= 256);
      assert.match(String(row.key), /#sha256:[a-f0-9]{64}$/);
    }
    assert.throws(
      () => f.store.report(iid, first, { ...accounting, usd: 2 }),
      /Conflicting duplicate accounting report/,
    );
    assert.throws(
      () =>
        f.store.report(iid, "oversized", {
          ...accounting,
          raw: { detail: "x".repeat(20 * 1024) },
        }),
      /JSON payload exceeds limit/,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM reports").get()?.n,
      2,
    );
    const usageSources = f.store
      .events("run")
      .filter((event) => event.type === "usage")
      .map((event) => event.sourceId);
    assert.deepEqual(
      usageSources,
      rows.map((row) => String(row.key)),
    );
    f.store.release("run", owner);
  } finally {
    f.close();
  }
});

test("projection marks string, key, collection and depth loss across repeated projections", () => {
  const losses = [
    { text: "é".repeat(800) },
    { files: Array.from({ length: 21 }, (_, i) => i) },
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])),
    { ["k".repeat(101)]: "tail" },
    { a: { b: { c: { d: { e: { f: {} } } } } } },
    "x".repeat(1600),
    Array.from({ length: 21 }, (_, i) => i),
  ];
  for (const value of losses) {
    let result = boundedJson(value);
    for (let i = 0; i < 4; i++) result = boundedJson(result);
    assert.match(JSON.stringify(result), /"projectionLoss":true/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 7500);
  }
  const exact = {
    text: "x".repeat(1500),
    files: Array.from({ length: 20 }, (_, i) => i),
  };
  assert.deepEqual(boundedJson(boundedJson(exact)), exact);
  const overall = boundedJson({
    files: Array.from({ length: 20 }, () => "x".repeat(1500)),
  });
  assert.match(JSON.stringify(boundedJson(overall)), /"truncated":true/);
});

test("projection flags survive adapter/runtime/store; content off and overflow stay separate from accounting", async () => {
  for (const traceContent of [false, true]) {
    const f = fixture();
    try {
      const projected = boundedJson({
        output: "x".repeat(1600),
        files: Array.from({ length: 21 }, (_, i) => i),
      });
      const h = new Scripted([
        async (_r, s) => {
          for (let i = 0; i < 502; i++)
            s.event({ type: "tool", content: true, data: projected });
          s.report("usage", accounting);
          return {
            status: "succeeded",
            text: "ok",
            accounting,
            session: { nativeId: "owned", baseline: 1 },
          };
        },
      ]);
      await f
        .runtime({ traceContent })
        .run((r) =>
          r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
        );
      const data = JSON.parse(
        String(
          f.store.db
            .prepare("SELECT data FROM events WHERE type='tool' LIMIT 1")
            .get()?.data,
        ),
      ) as Json;
      if (traceContent)
        assert.match(JSON.stringify(data), /"projectionLoss":true/);
      else assert.deepEqual(data, { contentOmitted: true });
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) n FROM events WHERE type='trace.truncated'")
          .get()?.n,
        1,
      );
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) n FROM events WHERE type='tool'")
          .get()?.n,
        500,
      );
      assert.equal(
        f.store.db.prepare("SELECT usd FROM ledger").get()?.usd,
        accounting.usd,
      );
    } finally {
      f.close();
    }
  }
});
