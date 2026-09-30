import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpenCode, type PluginInfo } from "@opencode-ai/client";
import { CODEX_VERSION, CodexHarness } from "../src/adapters/codex.js";
import { OpenCodeHarness } from "../src/adapters/opencode.js";
import {
  OPENCODE_VERSION,
  requirePolicy,
} from "../src/adapters/opencode-server.js";
import { fixture, pricing, Scripted } from "./helpers.js";
import type { Json } from "../src/types.js";

const manifest = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("SDK, transitive CLI/protocol and adapter identities use exact supported pins", () => {
  assert.equal(CODEX_VERSION, "0.159.2");
  assert.equal(OPENCODE_VERSION, "0.0.0-beta-19271");
  const root = manifest("../package.json");
  assert.equal(root.dependencies["@openai/codex-sdk"], CODEX_VERSION);
  assert.equal(root.dependencies["@opencode-ai/client"], OPENCODE_VERSION);
  const codex = manifest("../node_modules/@openai/codex-sdk/package.json");
  assert.equal(codex.version, CODEX_VERSION);
  assert.equal(codex.dependencies["@openai/codex"], CODEX_VERSION);
  assert.equal(
    manifest("../node_modules/@openai/codex/package.json").version,
    CODEX_VERSION,
  );
  const client = manifest("../node_modules/@opencode-ai/client/package.json");
  assert.equal(client.version, OPENCODE_VERSION);
  for (const name of ["protocol", "schema"]) {
    assert.equal(client.dependencies[`@opencode-ai/${name}`], OPENCODE_VERSION);
    assert.equal(
      manifest(`../node_modules/@opencode-ai/${name}/package.json`).version,
      OPENCODE_VERSION,
    );
  }
});

for (const [name, current, historical] of [
  ["codex", new CodexHarness({ pricing }).identity, "0.154.0"],
  [
    "opencode",
    new OpenCodeHarness({ pricing, directory: ".asf/sdk-upgrade/unused" })
      .identity,
    "0.0.0-beta-18684",
  ],
] as const) {
  for (const continuation of [false, true]) {
    test(`${name}: new pin rejects historical ${continuation ? "session" : "action"} binding without dispatch`, async () => {
      const f = fixture();
      try {
        const h = new Scripted();
        const identity = current as { [key: string]: Json };
        h.identity = { ...identity, sdk: historical, cli: historical };
        const config = { harness: h, model: "test-model" };
        const first = await f
          .runtime()
          .run((r) => r.agent("first", config, { prompt: "synthetic" }));
        h.identity = current;
        await assert.rejects(
          f.runtime().run((r) =>
            r.agent(continuation ? "next" : "first", config, {
              prompt: "synthetic",
              ...(continuation ? { session: first.session } : {}),
            }),
          ),
          continuation ? /session/i : /Action request changed: first/,
        );
        assert.equal(h.calls.length, 1);
      } finally {
        f.close();
      }
    });
  }
}

test("beta policy readiness uses nested state through the real HTTP client", async () => {
  let calls = 0;
  let state: PluginInfo["state"] = { status: "active" };
  const client = OpenCode.make({
    baseUrl: "http://127.0.0.1:1",
    fetch: async () => {
      calls++;
      const plugins: PluginInfo[] = [
        {
          id: "asf-no-retry",
          source: { type: "local", path: "synthetic" },
          features: { server: true },
          state,
        },
      ];
      return Response.json({ data: plugins });
    },
  });
  await requirePolicy(client, process.cwd(), AbortSignal.timeout(1000));
  state = { status: "failed", error: "synthetic hook failure" };
  await assert.rejects(
    requirePolicy(client, process.cwd(), AbortSignal.timeout(1000)),
    /Policy initialization failed/,
  );
  assert.equal(calls, 2, "failed policy is not retried or accepted");
});
