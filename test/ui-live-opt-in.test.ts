import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

test("live UI recorder no-args/help are inert and missing acknowledgement fails closed", () => {
  const dir = mkdtempSync(resolve(".ui-live-opt-in-"));
  try {
    const runner = resolve("scripts/verify-ui-live.ts");
    const tsx = resolve("node_modules/tsx/dist/cli.mjs");
    for (const args of [[], ["--help"], ["--help", "--live"]]) {
      const result = spawnSync(process.execPath, [tsx, runner, ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Opt-in REAL review/);
      assert.deepEqual(readdirSync(dir), []);
    }
    const denied = spawnSync(
      process.execPath,
      [tsx, runner, "--config", join(dir, "absent.json"), "--run", "denied"],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Explicit live\/config\/run required/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
