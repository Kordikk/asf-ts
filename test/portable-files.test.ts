import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableFixture } from "./portable-fixtures.js";
import {
  loadDocument,
  bundleDocument,
  verifyBundle,
  renderDocument,
  compileDocument,
} from "../src/portable/files.js";
import { validateDocument } from "../src/portable/validation.js";
test("bundle closure verifies without extraction and detects changed source, render and report", () => {
  const doc = portableFixture(),
    bundle = bundleDocument(doc);
  assert.equal(bundle, bundleDocument(doc));
  assert.equal(verifyBundle(bundle).identity, validateDocument(doc).identity);
  for (const mutate of [
    (b: Record<string, unknown>) => (b.workflowIdentity = "wrong"),
    (b: Record<string, unknown>) => (b.support = {}),
    (b: Record<string, unknown>) => {
      const m = b.members as Record<string, { data: string }>;
      m["workflow.svg"]!.data = "tampered";
    },
    (b: Record<string, unknown>) => {
      const m = b.members as Record<string, unknown>;
      m["../../escape"] = { data: "x", sha256: "x" };
    },
  ]) {
    const b = JSON.parse(bundle) as Record<string, unknown>;
    mutate(b);
    assert.throws(() => verifyBundle(JSON.stringify(b)));
  }
});
test("renderer escapes labels and generated ASF driver freezes complete source without bindings", () => {
  const doc = portableFixture();
  doc.workflows.review!.version = '<script>alert("x")</script>';
  const svg = renderDocument(doc);
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(!svg.includes("<script>"));
  const source = compileDocument(doc);
  assert.ok(source.includes("executeDocument"));
  assert.ok(source.includes("verification") === false);
  assert.ok(source.includes("review"));
  assert.ok(!source.includes("apiKey"));
});
test("CLI closure loader resolves local definitions and rejects escape, cycles and duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-files-"));
  try {
    const doc = portableFixture(),
      review = doc.workflows.review!;
    delete doc.workflows.review;
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["child.json"] }),
    );
    writeFileSync(
      join(dir, "child.json"),
      JSON.stringify({
        format: doc.format,
        root: "review",
        workflows: { review },
      }),
    );
    assert.equal(
      loadDocument(join(dir, "root.json")).document.workflows.review!.version,
      "1",
    );
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["../outside.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /imports/);
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["root.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /cycle/);
    mkdirSync(join(dir, "sub"));
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["child.json", "child.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /Duplicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
