import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { CODEX_VERSION, CodexHarness } from "../src/adapters/codex.js";
import { pricing } from "./helpers.js";

// Capture the actual official SDK/launcher argv, never passing a prompt to a CLI.
test("Codex SDK generates supported scope config without built-in provider overrides", async (t) => {
  const dir = mkdtempSync(resolve(".codex-config-test-"));
  try {
    const capture = join(dir, "capture.cjs");
    const argvFile = join(dir, "argv.json");
    writeFileSync(
      capture,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));process.stdin.resume();\n`,
      { mode: 0o700 },
    );
    await new CodexHarness({ pricing, executable: capture }).invoke(
      {
        prompt: "local capture only",
        model: "test-model",
        cwd: dir,
        mode: "read-only",
        signal: AbortSignal.timeout(5000),
      },
      { event: () => {}, report: () => {} },
    );
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const config = argv.flatMap((arg, i) =>
      arg === "--config" ? [arg, argv[i + 1]!] : [],
    );
    assert.deepEqual(config, [
      "--config",
      'model_provider="openai"',
      "--config",
      "features.multi_agent=false",
      "--config",
      "sandbox_workspace_write.network_access=false",
      "--config",
      'web_search="disabled"',
      "--config",
      'approval_policy="never"',
    ]);
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");

    const executable = process.env.ASF_TEST_CODEX;
    await t.test(
      "exact installed CLI validates generated config via app-server metadata (no model)",
      { skip: !executable },
      async () => {
        // Whitelist environment: no inherited auth, user config, or native history.
        const env = {
          PATH: process.env.PATH,
          HOME: dir,
          CODEX_HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CACHE_HOME: join(dir, "cache"),
          XDG_STATE_HOME: join(dir, "state"),
        };
        const options = { cwd: dir, env };
        const version = spawnSync(executable!, ["--version"], {
          ...options,
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(version.status, 0, version.stderr);
        assert.equal(version.stdout.trim(), `codex-cli ${CODEX_VERSION}`);

        const child = spawn(executable!, ["app-server", ...config], {
          ...options,
          detached: true,
          signal: AbortSignal.timeout(10000),
          stdio: ["pipe", "pipe", "pipe"],
        });
        const exit = once(child, "close");
        // Attach a handler immediately, including for spawn/timeout errors.
        void exit.catch(() => {});
        let stderr = "";
        child.stderr.on("data", (b: Buffer) => {
          stderr = (stderr + b.toString()).slice(-8192);
        });
        const lines = createInterface({ input: child.stdout });
        const send = (message: unknown) =>
          child.stdin.write(JSON.stringify(message) + "\n");
        try {
          send({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "asf-offline-test", version: "1" } },
          });
          let validated = false;
          for await (const line of lines) {
            const message = JSON.parse(line);
            if (message.id === 1) {
              assert.ok(message.result, line);
              send({ method: "initialized" });
              send({
                id: 2,
                method: "config/read",
                params: { includeLayers: false },
              });
            } else if (message.id === 2) {
              assert.ok(message.result, line);
              assert.equal(message.result.config.model_provider, "openai");
              assert.equal(message.result.config.features.multi_agent, false);
              validated = true;
              break;
            }
          }
          assert.ok(validated, `No config/read response: ${stderr}`);
        } finally {
          lines.close();
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // Already exited.
            }
          }
          await exit;
        }

        // Negative control: the removed overrides must fail before initialization.
        const rejected = spawnSync(
          executable!,
          [
            "app-server",
            ...config,
            "--config",
            "model_providers.openai.request_max_retries=0",
            "--config",
            "model_providers.openai.stream_max_retries=0",
          ],
          { ...options, input: "", encoding: "utf8", timeout: 10000 },
        );
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /reserved built-in provider IDs/);
        assert.equal(rejected.stdout, "");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
