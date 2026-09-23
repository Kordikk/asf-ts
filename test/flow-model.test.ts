import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Inspection } from "../src/inspection.js";

type Card = {
  id: string;
  scope: string | null;
  action?: Inspection["actions"][number];
  invocations: Inspection["invocations"];
  knownUsd: number | null;
  unresolved: number;
};
// The browser uses a classic script to avoid Origin-bearing module fetches.
const model = runInNewContext(
  `${readFileSync(new URL("../src/web/flow-model.js", import.meta.url), "utf8")}\nexecutionMap;`,
) as (s: Inspection) => {
  cards: Card[];
  lanes: Map<string | null, Card[]>;
  sessions: Map<string, Inspection["invocations"]>;
};
const empty = (): Inspection => ({
  actions: [],
  invocations: [],
  reports: [],
  budgets: [],
  costsByKind: [],
  totals: {
    invocations: 0,
    modelDispatches: null,
    knownUsd: null,
    unresolved: null,
  },
  offset: 20,
  limit: 20,
});
function invocation(
  id: string,
  action: string,
  turn: number,
  session: string | null,
): Inspection["invocations"][number] {
  return {
    id,
    run: "synthetic",
    action,
    turn,
    session,
    kind: "model",
    status: "reserved",
    receipt: null,
    accounting: null,
    paid: 0,
    budget: null,
    created: 100,
  };
}

test("map keeps independently paged records, explicit prefixes and turn gaps without inferring dependencies", () => {
  const page = empty();
  page.actions.push({
    run: "synthetic",
    id: "empty/quoted['\"]",
    identity: "x",
    status: "completed",
    result: null,
    error: null,
  });
  page.invocations.push(
    invocation("later", "a/nested/review", 3, "same"),
    invocation("early", "a/nested/review", 0, "same"),
    invocation("other", "b/plan", 0, "same"),
    invocation("unscoped", "host", 0, null),
  );
  const result = model(page);
  assert.deepEqual(Array.from(result.lanes.keys()), [
    "empty",
    "a/nested",
    "b",
    null,
  ]);
  assert.equal(result.cards.length, 4);
  assert.equal(result.cards[0]!.invocations.length, 0);
  assert.equal(result.cards[0]!.knownUsd, null);
  assert.equal(result.cards[1]!.action, undefined);
  assert.deepEqual(
    Array.from(result.cards[1]!.invocations, (i) => i.turn),
    [0, 3],
  );
  assert.deepEqual(Array.from(result.sessions.keys()), ["same"]);
  assert.equal(result.sessions.get("same")!.length, 3);
  assert.deepEqual(Object.keys(result).sort(), ["cards", "lanes", "sessions"]);
  // Same timestamp, distinct sessions (or absent sessions) never establish links.
  page.invocations[2]!.session = "separate";
  assert.equal(model(page).sessions.get("same")!.length, 2);
  assert.equal(model(empty()).cards.length, 0);
});

test("visible map costs use final ledger once, including auxiliary known amounts; missing is not zero", () => {
  const page = empty();
  page.invocations.push(
    invocation("a", "check", 0, null),
    invocation("b", "check", 1, null),
  );
  page.invocations[0]!.accounting = JSON.stringify({
    status: "incomplete",
    usd: null,
    additional: [{ usd: 0.25 }, { usd: null }],
  });
  page.reports.push({
    invocation: "a",
    key: "not-a-ledger",
    data: JSON.stringify({ usd: 999 }),
  });
  let card = model(page).cards[0]!;
  assert.equal(card.knownUsd, 0.25);
  assert.equal(card.unresolved, 2);
  page.invocations[0]!.accounting = JSON.stringify({
    status: "complete",
    usd: 0,
    additional: [],
  });
  page.invocations.pop();
  card = model(page).cards[0]!;
  assert.equal(card.knownUsd, 0);
  assert.equal(card.unresolved, 0);
  page.invocations[0]!.accounting = null;
  assert.equal(model(page).cards[0]!.knownUsd, null);
  page.invocations[0]!.accounting = "invalid JSON";
  assert.equal(model(page).cards[0]!.unresolved, 1);
});
