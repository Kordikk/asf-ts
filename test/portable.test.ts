import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument,
  validateDocument,
  serializeDocument,
  resolveValue,
  evaluatePredicate,
} from "../src/portable/index.js";
import { portableFixture } from "./portable-fixtures.js";
import type { WorkflowDocument } from "../src/portable/model.js";

test("portable JSON/YAML round trip and layout preserve meaning", () => {
  const doc = portableFixture(),
    a = validateDocument(doc);
  for (const format of ["json", "yaml"] as const)
    assert.equal(
      validateDocument(parseDocument(serializeDocument(doc, format))).identity,
      a.identity,
    );
  doc.workflows.delivery!.layout = { child: { x: 123, y: 44 } };
  doc.workflows.delivery!.nodes.reverse();
  assert.equal(validateDocument(doc).identity, a.identity);
});
test("safe parser rejects duplicates, aliases, tags, nonfinite and limits", () => {
  for (const text of [
    '{"a":1,"a":2}',
    "a: &thing 1\nb: *thing",
    "a: !evil 1",
    "a: .inf",
    "a: .nan",
    "x".repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => parseDocument(text));
});
test("strict structure rejects unknown fields, missing edges, cycles, recursion and invalid schemas", () => {
  for (const mutate of [
    (d: WorkflowDocument) => Object.assign(d, { extra: true }),
    (d: WorkflowDocument) =>
      d.workflows.delivery!.nodes.push({
        id: "loose",
        kind: "end",
        output: { ok: true },
      }),
    (d: WorkflowDocument) =>
      ((d.workflows.delivery!.nodes[0] as { next: string }).next = "missing"),
    (d: WorkflowDocument) =>
      ((d.workflows.delivery!.nodes[0] as { next: string }).next = "child"),
    (d: WorkflowDocument) =>
      (d.workflows.review!.nodes = [
        {
          id: "end",
          kind: "workflow",
          workflow: "delivery",
          input: { $ref: "#/input" },
          next: "end",
        },
      ]),
    (d: WorkflowDocument) =>
      (d.workflows.review!.inputSchema = {
        $ref: "https://example.com/schema",
      }),
  ]) {
    const d = portableFixture();
    mutate(d);
    assert.throws(() => validateDocument(d));
  }
});
test("references must exist on every incoming path and expose required typed properties", () => {
  const d = portableFixture(),
    w = d.workflows.delivery!;
  w.nodes = [
    {
      id: "branch",
      kind: "branch",
      predicate: { left: { $ref: "#/input/ok" }, op: "truthy" },
      then: "child",
      else: "end",
    },
    ...w.nodes,
  ];
  w.start = "branch";
  assert.throws(() => validateDocument(d), /incoming path/);
  const d2 = portableFixture();
  d2.workflows.review!.inputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    additionalProperties: false,
  };
  assert.throws(() => validateDocument(d2), /optional|missing required/);
});
test("typed child ports reject mismatched data and JSON references resolve deterministically", () => {
  const d = portableFixture();
  (d.workflows.delivery!.nodes[0] as { input: unknown }).input = { ok: 3 };
  assert.throws(() => validateDocument(d), /incompatible/);
  assert.deepEqual(
    resolveValue({ ok: { $ref: "#/nodes/a/ok" } }, null, { a: { ok: false } }),
    { ok: false },
  );
  assert.equal(
    evaluatePredicate({ left: { $ref: "#/nodes/a/ok" }, op: "truthy" }, null, {
      a: { ok: false },
    }),
    false,
  );
  assert.throws(() =>
    resolveValue({ $ref: "#/nodes/a/absent" }, null, { a: { ok: false } }),
  );
});
