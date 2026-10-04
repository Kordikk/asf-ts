import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProfile,
  parseProfiles,
  resolveProfile,
  type ProfileBinding,
  type ProfileSelection,
} from "../src/profiles.js";
import { Scripted, fixture } from "./helpers.js";

function binding(extra: Partial<ProfileBinding> = {}): ProfileBinding {
  return {
    agent: { harness: new Scripted(), model: "test-model" },
    capabilities: {
      revision: "fixture/v1",
      modes: ["read-only", "write"],
      tools: ["read", "write"],
      strictTools: false,
      nativeSystem: false,
      fresh: true,
    },
    ...extra,
  };
}
function selection(extra: Partial<ProfileSelection> = {}): ProfileSelection {
  return {
    profiles: {
      writer: { instructions: "Write", mode: "write" },
      reviewer: { instructions: "Review" },
    },
    bindings: { writer: binding(), reviewer: binding() },
    defaultProfile: "writer",
    ...extra,
  };
}

test("named profiles replace defaults; explicit caller selection and field overrides win", () => {
  const resolved = resolveProfile(
    selection({
      defaults: { instructions: "Default", mode: "read-only", timeoutMs: 1000 },
      nodeProfile: "reviewer",
      callerProfile: "writer",
      override: { instructions: "Caller" },
    }),
  );
  assert.equal(resolved.name, "writer");
  assert.equal(resolved.agentConfig.instructions, "Caller");
  assert.equal(resolved.agentConfig.mode, "write");
  assert.equal(resolved.agentConfig.timeoutMs, 1000);
  assert.equal(resolved.sessionPolicy, "fresh");
  assert.equal(
    resolveProfile(selection({ nodeProfile: "reviewer" })).agentConfig
      .instructions,
    "Review",
  );
  assert.throws(
    () => resolveProfile(selection({ nodeProfile: "absent" })),
    /Unknown selected/,
  );
  assert.throws(
    () => resolveProfile(selection({ bindings: {} })),
    /Missing local binding/,
  );
});

test("portable profiles reject unknown fields, literal credentials and invalid scalar shapes", () => {
  for (const value of [
    { secret: "private" },
    { executable: "/bin/tool" },
    { capabilities: {} },
    { credentials: { key: "private" } },
    { model: "" },
    { strict: "false" },
    { instructions: 42 },
    { tools: "read" },
    { tools: ["read", "read"] },
    { timeoutMs: 1.5 },
    { timeoutMs: Infinity },
    { session: "continue" },
    { mode: "admin" },
    { instructionsChannel: "system" },
    { strict: true },
  ])
    assert.throws(() => parseProfile(value));
  for (const value of [
    [],
    null,
    "profiles",
    { "../escape": {} },
    { __proto__: {} },
  ])
    assert.throws(() => parseProfiles(value));
  assert.equal(parseProfile({ strict: true, tools: [] }).tools!.length, 0);
});

test("resolved identities and previews are frozen snapshots without harness credentials", () => {
  const tools = ["read"],
    instructions = { instructions: "Review", tools };
  const bind = binding();
  const resolved = resolveProfile(
    selection({
      profiles: { reviewer: instructions },
      bindings: { reviewer: bind },
      defaultProfile: "reviewer",
    }),
  );
  const initial = JSON.stringify(resolved.preview());
  tools.push("write");
  instructions.instructions = "Changed";
  bind.agent.model = "changed";
  assert.equal(JSON.stringify(resolved.preview()), initial);
  assert.equal(resolved.agentConfig.model, "test-model");
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.intent.tools));
  assert.ok(!JSON.stringify(resolved.preview()).includes("harness"));
  const first = resolveProfile(selection());
  const changed = resolveProfile(selection({ defaults: { timeoutMs: 12 } }));
  assert.notEqual(first.identity, changed.identity);
});

test("tools are explicit requirements; strict empty selection means no tools", () => {
  assert.throws(
    () =>
      resolveProfile(selection({ profiles: { writer: { tools: ["shell"] } } })),
    /does not provide/,
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({ profiles: { writer: { tools: ["read"], strict: true } } }),
      ),
    /exact strict/,
  );
  const local = binding();
  local.capabilities = { ...local.capabilities, tools: [], strictTools: true };
  const resolved = resolveProfile(
    selection({
      profiles: { writer: { tools: [], strict: true } },
      bindings: { writer: local },
    }),
  );
  assert.equal(
    (resolved.preview() as Record<string, unknown>).toolSupport,
    "enforced",
  );
  local.capabilities = { ...local.capabilities, tools: ["read", "write"] };
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { tools: ["read"], strict: true } },
          bindings: { writer: local },
        }),
      ),
    /exact strict/,
  );
  const unknown = binding();
  delete unknown.capabilities.tools;
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { tools: [] } },
          bindings: { writer: unknown },
        }),
      ),
    /inventory is unknown/,
  );
});

test("native system instructions require an exact preconfigured native binding", () => {
  const intent = {
    instructions: "Review",
    instructionsChannel: "native-system" as const,
  };
  assert.throws(
    () => resolveProfile(selection({ profiles: { writer: intent } })),
    /exact native system/,
  );
  const local = binding({
    instructionChannel: "native-system",
    nativeInstructions: "Review",
  });
  local.capabilities = { ...local.capabilities, nativeSystem: true };
  const resolved = resolveProfile(
    selection({ profiles: { writer: intent }, bindings: { writer: local } }),
  );
  assert.equal(resolved.agentConfig.instructions, undefined);
  assert.equal(
    (resolved.preview() as Record<string, unknown>).instructionSupport,
    "enforced",
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { ...intent, instructions: "Different" } },
          bindings: { writer: local },
        }),
      ),
    /exact native system/,
  );
});

test("fresh reviewers reject continuation; compatible profiles bind all resolved identity", () => {
  const fresh = resolveProfile(selection());
  assert.throws(() => fresh.checkContinuation(fresh.identity), /Fresh profile/);
  const compatible = resolveProfile(
    selection({ override: { session: "compatible" } }),
  );
  compatible.checkContinuation(compatible.identity);
  assert.throws(
    () => compatible.checkContinuation(fresh.identity),
    /identity changed/,
  );
  const local = binding();
  local.capabilities = {
    ...local.capabilities,
    fresh: false,
    modes: ["write"],
  };
  assert.throws(
    () => resolveProfile(selection({ bindings: { writer: local } })),
    /fresh sessions/,
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({
          bindings: { writer: local },
          override: { mode: "read-only" },
        }),
      ),
    /does not support mode/,
  );
});

test("legacy runtime receives one visible prompt prefix and advisory tool guidance", async () => {
  const f = fixture(),
    local = binding();
  try {
    const resolved = resolveProfile(
      selection({
        profiles: {
          writer: { instructions: "Review carefully", tools: ["read"] },
        },
        bindings: { writer: local },
      }),
    );
    await f.runtime().run((run) =>
      run.agent("review", resolved.agentConfig, {
        prompt: "Review candidate",
      }),
    );
    const request = (local.agent.harness as Scripted).calls[0]!;
    assert.equal(request.prompt.split("Review carefully").length, 2);
    assert.match(request.prompt, /Advisory tool guidance/);
    assert.match(request.prompt, /does not enforce/);
    assert.equal(request.mode, "read-only");
    assert.equal(
      (resolved.preview() as Record<string, unknown>).instructionChannel,
      "prompt-prefix",
    );
  } finally {
    f.close();
  }
});
