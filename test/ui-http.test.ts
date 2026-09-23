import test from "node:test";
import assert from "node:assert/strict";
import { request, type RequestOptions } from "node:http";
import { serve } from "../src/http.js";
import { Store } from "../src/store.js";
import { fixture } from "./helpers.js";

test("bounded run summaries have stable newest-first/tie order and validate pagination", () => {
  const f = fixture();
  try {
    for (const id of ["b", "a", "c"]) {
      const owner = f.store.claim(id, "synthetic");
      f.store.release(id, owner);
    }
    f.store.db.prepare("UPDATE runs SET created=100").run();
    assert.deepEqual(
      f.store.runs(0, 2).map((r) => r.id),
      ["c", "b"],
    );
    assert.deepEqual(
      f.store.runs(2, 2).map((r) => r.id),
      ["a"],
    );
    f.store.db.prepare("UPDATE runs SET created=101 WHERE id='a'").run();
    assert.deepEqual(
      f.store.runs(0, 2).map((r) => r.id),
      ["a", "c"],
    );
    assert.deepEqual(f.store.runs(3, 2), []);
    assert.deepEqual(Object.keys(f.store.runs()[0]!).sort(), [
      "created",
      "error",
      "id",
      "status",
    ]);
    for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => f.store.runs(offset));
    for (const limit of [0, -1, 201, NaN, 1.5])
      assert.throws(() => f.store.runs(0, limit));
  } finally {
    f.close();
  }
});

test("explicit UI assets and run-list GETs preserve loopback/Origin restrictions and unknown run semantics", async () => {
  const f = fixture();
  const reader = new Store(f.store.path, true);
  const server = await serve(reader);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [path, mime] of [
      ["/", "text/html"],
      ["/ui.js", "text/javascript"],
      ["/flow-model.js", "text/javascript"],
      ["/ui.css", "text/css"],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(mime!));
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(
        response.headers.get("content-security-policy")!,
        /default-src 'none'/,
      );
      assert.match(
        response.headers.get("content-security-policy")!,
        /frame-ancestors 'none'/,
      );
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.ok((await response.text()).length > 100);
    }
    assert.deepEqual(await (await fetch(`${base}/runs`)).json(), []);
    const owner = f.store.claim("SYNTHETIC <script>", "test");
    f.store.release("SYNTHETIC <script>", owner);
    assert.equal(
      await (await fetch(`${base}/runs?limit=1`)).text(),
      JSON.stringify(f.store.runs(0, 1)),
    );
    for (const query of [
      "offset=-1",
      "offset=0.1",
      "offset=NaN",
      "offset=9007199254740992",
      "limit=201",
      "limit=0",
      "limit=1.5",
    ])
      assert.equal((await fetch(`${base}/runs?${query}`)).status, 400);
    for (const path of [
      "/store.ts",
      "/web/index.html",
      "/AGENTS.md",
      "/%2e%2e/AGENTS.md",
      "/missing",
    ])
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    for (const path of [
      "/",
      "/ui.js",
      "/flow-model.js",
      "/ui.css",
      "/runs",
      "/inspect?run=x",
      "/events?run=x",
    ]) {
      const denied: RequestOptions[] = [
        { method: "POST" },
        { method: "HEAD" },
        { headers: { Origin: base } },
        { headers: { Origin: "https://evil.example" } },
        { headers: { Host: "evil.example:8080" } },
        { headers: { "Sec-Fetch-Site": "cross-site" } },
      ];
      for (const options of denied) {
        const status = await new Promise<number | undefined>(
          (resolve, reject) => {
            const req = request(`${base}${path}`, options, (res) => {
              res.resume();
              resolve(res.statusCode);
            });
            req.on("error", reject);
            req.end();
          },
        );
        assert.equal(status, 403, `${path}: ${JSON.stringify(options)}`);
      }
      assert.equal(
        (
          await fetch(`${base}${path}`, {
            headers: { "Sec-Fetch-Site": "same-origin" },
          })
        ).status,
        200,
      );
    }
    const unknown = (await (
      await fetch(`${base}/inspect?run=unknown`)
    ).json()) as {
      run?: unknown;
      actions: unknown[];
      totals: { knownUsd: number | null };
    };
    assert.equal(unknown.run, undefined);
    assert.deepEqual(unknown.actions, []);
    assert.equal(unknown.totals.knownUsd, null);
    assert.deepEqual(
      await (await fetch(`${base}/events?run=unknown`)).json(),
      [],
    );
    assert.equal((await fetch(`${base}/inspect`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    f.close();
  }
});

test("SDK import and CLI help work with unavailable UI assets; only serve loads them", async () => {
  const { spawnSync } = await import("node:child_process");
  const source = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import assert from 'node:assert/strict';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      if (/\\/web\\/(index\\.html|ui\\.js|ui\\.css)$/.test(String(path))) throw new Error('UI assets unavailable');
      return read(path, ...args);
    };
    syncBuiltinESMExports();
    const sdk = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
    assert.equal(typeof sdk.Runtime, 'function');
    process.argv = ['node', 'asf', '--help'];
    await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});
    await assert.rejects(sdk.serve(null), /UI assets unavailable/);
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /ASF v0.1/);
});
