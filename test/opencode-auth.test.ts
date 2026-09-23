import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHarness } from "../src/adapters/opencode.js";
import {
  provisionPrivateApiKey,
  validatePrivateApiKey,
  type OpenCodeClient,
} from "../src/adapters/opencode-server.js";

const secret = "SYNTHETIC-KEY-not-a-real-provider-credential";

test("private key handoff uses the exact SDK route once and withholds reflected errors", async () => {
  const calls: unknown[][] = [];
  let fail = false;
  const client = {
    integration: {
      connect: {
        key: async (
          ...args: Parameters<OpenCodeClient["integration"]["connect"]["key"]>
        ) => {
          calls.push(args);
          if (fail) throw new Error(`reflected request contains ${secret}`);
        },
      },
    },
  } as unknown as OpenCodeClient;
  const apiKey = { integrationID: "opencode-go", key: secret };
  const signal = AbortSignal.timeout(1000);
  await provisionPrivateApiKey(client, apiKey, "/owned/work", signal);
  assert.deepEqual(calls, [
    [
      {
        integrationID: "opencode-go",
        key: secret,
        label: "ASF owned private server",
        location: { directory: "/owned/work" },
      },
      { signal },
    ],
  ]);
  fail = true;
  await assert.rejects(
    provisionPrivateApiKey(client, apiKey, "/owned/work", signal),
    (error: Error) => {
      assert.match(error.message, /provisioning failed \(details withheld\)/);
      assert.ok(!String(error.stack).includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(calls.length, 2, "a failed handoff is never retried");
});

test("explicit key preflight binds its provider, snapshots inputs, and never records the key in identity", async () => {
  const apiKey = { integrationID: "opencode-go", key: secret };
  const pricing = {
    model: "opencode-go/test-model",
    source: "synthetic rates",
    version: "1",
    input: 1,
    cacheRead: 1,
    cacheWrite: 1,
    output: 1,
  };
  let versions = 0;
  const harness = new OpenCodeHarness({
    apiKey,
    pricing,
    directory: "/owned/native",
    checkVersion: async () => {
      versions++;
    },
  });
  const identity = JSON.stringify(harness.identity);
  assert.ok(!identity.includes(secret));
  assert.match(identity, /private-api-key/);
  assert.match(identity, /opencode-go/);
  apiKey.key = "public";
  apiKey.integrationID = "other";
  await harness.preflight({
    prompt: "never sent",
    model: pricing.model,
    cwd: "/owned/work",
    mode: "read-only",
  });
  assert.equal(versions, 1);
  assert.equal(JSON.stringify(harness.identity), identity);
  const mismatched = new OpenCodeHarness({
    apiKey: { integrationID: "other", key: secret },
    pricing,
    directory: "/owned/native",
    checkVersion: async () => {
      versions++;
    },
  });
  await assert.rejects(
    mismatched.preflight({
      prompt: "never sent",
      model: pricing.model,
      cwd: "/owned/work",
      mode: "read-only",
    }),
    /does not match the requested provider/,
  );
  assert.equal(
    versions,
    1,
    "provider mismatch fails before version subprocess or reservation",
  );
});

test("missing, public, oversized, and malformed explicit keys fail without exposing input", () => {
  for (const key of ["", "public", `${secret}\n`, "x".repeat(4097)]) {
    assert.throws(
      () => validatePrivateApiKey({ integrationID: "opencode-go", key }),
      (error: Error) => {
        assert.equal(
          error.message,
          "Invalid explicit OpenCode private API-key configuration",
        );
        return true;
      },
    );
  }
  assert.throws(
    () => validatePrivateApiKey({ integrationID: "../other", key: secret }),
    /Invalid explicit/,
  );
});
