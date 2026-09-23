import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeHarness } from "../src/adapters/opencode.js";
import {
  privateServer,
  requirePolicy,
  OPENCODE_VERSION,
} from "../src/adapters/opencode-server.js";
// No model/session send. Tests use empty XDG roots and an owned private server only.
const executable = process.env.ASF_TEST_OPENCODE;
test(
  "exact installed beta: private handshake, official SDK health, policy load, cleanup (no model)",
  { skip: !executable },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "asf-private-server-"));
    try {
      // Exercise the real adapter's version preflight, not only SDK server health.
      await new OpenCodeHarness({
        executable,
        directory: join(dir, "native"),
        pricing: {
          model: "fixture/model",
          source: "offline fixture; no request is sent",
          version: "test",
          input: 1,
          cacheRead: 1,
          cacheWrite: 1,
          output: 1,
        },
      }).preflight({
        prompt: "never sent",
        model: "fixture/model",
        cwd: dir,
        mode: "read-only",
      });
      const env = {
        PATH: process.env.PATH,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_STATE_HOME: join(dir, "state"),
        OPENCODE_TEST_HOME: dir,
      };
      const server = await privateServer({
        directory: join(dir, "server"),
        cwd: dir,
        mode: "read-only",
        executable,
        env,
      });
      let pid: number;
      try {
        const health = await server.client.health.get();
        assert.equal(health.version, OPENCODE_VERSION);
        pid = health.pid;
        await requirePolicy(server.client, dir, AbortSignal.timeout(10000));
        const plugins = await server.client.plugin.list({
          location: { directory: dir },
        });
        assert.ok(
          plugins.data.some(
            (p) => p.status === "active" && p.id === "asf-no-retry",
          ),
          JSON.stringify(plugins),
        );
        const agents = await server.client.agent.list({
          location: { directory: dir },
        });
        assert.ok(
          !agents.data.some((a) => a.id === "title" || a.id === "compaction"),
        );
        const session = await server.client.session.create({
          title: "Offline API fixture (no prompt)",
          agent: "asf",
          location: { directory: dir },
        });
        await server.client.session.wait(
          { sessionID: session.id },
          { signal: AbortSignal.timeout(5000) },
        );
        const liveAbort = new AbortController();
        const live = server.client.event
          .subscribe({
            signal: AbortSignal.any([
              liveAbort.signal,
              AbortSignal.timeout(5000),
            ]),
          })
          [Symbol.asyncIterator]();
        assert.equal((await live.next()).value?.type, "server.connected");
        await server.client.session.rename({
          sessionID: session.id,
          title: "Offline renamed",
        });
        let found = false;
        for (let i = 0; i < 100; i++) {
          const e = (await live.next()).value;
          if (e?.type === "session.renamed") {
            found = true;
            break;
          }
        }
        assert.equal(found, true);
        liveAbort.abort();
        const events = [];
        for await (const event of server.client.session.log(
          { sessionID: session.id, follow: false },
          { signal: AbortSignal.timeout(5000) },
        ))
          events.push(event);
        // Exact CLI defaults persist=false: a historical read is ONLY a watermark.
        assert.deepEqual(
          events.map((e) => e.type),
          ["log.synced"],
        );
        await server.client.session.interrupt({
          sessionID: session.id,
          continue: false,
        });
        assert.equal(
          (await server.client.session.get({ sessionID: session.id })).id,
          session.id,
        );
        assert.ok(existsSync(join(dir, "server", "native.db")));
      } finally {
        await server.close();
      }
      let alive = false;
      try {
        alive = !/\) Z /.test(readFileSync(`/proc/${pid!}/stat`, "utf8"));
      } catch {
        /* reaped */
      }
      assert.equal(alive, false);
      // A synthetic key exercises native private credential persistence only.
      // No provider request validates the key and no prompt/session is created.
      const key = "SYNTHETIC-ASF-key-no-provider-request";
      const credentialDirectory = join(dir, "credential-server");
      for (const initial of [true, false]) {
        const credentialed = await privateServer({
          directory: credentialDirectory,
          cwd: dir,
          mode: "read-only",
          executable,
          env,
          ...(initial ? { apiKey: { integrationID: "opencode-go", key } } : {}),
        });
        try {
          await requirePolicy(
            credentialed.client,
            dir,
            AbortSignal.timeout(10_000),
          );
          const catalog = await credentialed.client.model.list({
            location: { directory: dir },
          });
          assert.ok(
            catalog.data.some(
              (model) => model.providerID === "opencode-go" && model.enabled,
            ),
          );
          const health = await credentialed.client.health.get();
          assert.ok(
            !readFileSync(`/proc/${health.pid}/cmdline`, "utf8").includes(key),
          );
          assert.ok(
            !readFileSync(`/proc/${health.pid}/environ`, "utf8").includes(key),
          );
        } finally {
          await credentialed.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
