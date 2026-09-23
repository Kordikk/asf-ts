import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { serve } from "../src/http.js";
import { Store } from "../src/store.js";
import { fixture, Scripted, accounting } from "./helpers.js";
import { sleep } from "../src/util.js";
test("SSE visible during running harness; reconnect IDs and bounded read-only pages", async () => {
  const f = fixture();
  const reader = new Store(f.store.path, true);
  const server = await serve(reader);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  try {
    let finish!: () => void;
    const h = new Scripted([
      async (_r, s) => {
        s.event({
          type: "message",
          data: { text: "in flight" },
          content: true,
        });
        s.report("progress", accounting);
        await new Promise<void>((r) => {
          finish = r;
        });
        return {
          status: "succeeded",
          text: "done",
          accounting,
          session: { nativeId: "s", baseline: 0 },
        };
      },
    ]);
    const work = f
      .runtime({ traceContent: true })
      .run((r) =>
        r.agent("a", { harness: h, model: "test-model" }, { prompt: "x" }),
      );
    const response = await fetch(`${base}/events?run=run&stream=1`, {
      signal: abort.signal,
    });
    const stream = response.body!.getReader();
    const chunk = await stream.read();
    const text = Buffer.from(chunk.value!).toString();
    assert.match(text, /in flight/);
    assert.match(text, /usage/);
    const ids = [...text.matchAll(/id: (\d+)/g)].map((m) => Number(m[1]));
    const cursor = ids.at(-1)!;
    finish();
    await work;
    abort.abort();
    const resumed = await fetch(
      `${base}/events?run=run&after=${cursor}&limit=2`,
    );
    const rows = (await resumed.json()) as { cursor: number }[];
    assert.ok(rows.length <= 2 && rows.every((r) => r.cursor > cursor));
    const reconnectAbort = new AbortController();
    const reconnected = await fetch(`${base}/events?run=run&stream=1`, {
      headers: { "Last-Event-ID": String(cursor) },
      signal: reconnectAbort.signal,
    });
    const next = await reconnected.body!.getReader().read();
    assert.ok(
      [
        ...Buffer.from(next.value!)
          .toString()
          .matchAll(/id: (\d+)/g),
      ].every((m) => Number(m[1]) > cursor),
    );
    reconnectAbort.abort();
    assert.equal((await fetch(`${base}/events?run=run&limit=999`)).status, 200); // capped at HTTP boundary
    assert.equal((await fetch(`${base}/events?run=run&after=-1`)).status, 400);
    assert.equal(
      (await fetch(`${base}/inspect?run=run`, { method: "POST" })).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/inspect?run=run`, {
          headers: { Origin: "http://evil.example" },
        })
      ).status,
      403,
    );
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    f.close();
  }
});
test("malformed raw request URL returns 400 and inspection remains available", async () => {
  const f = fixture();
  const reader = new Store(f.store.path, true);
  const server = await serve(reader);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await f.runtime().run(async () => {});
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: address.port,
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () =>
        socket.destroy(new Error("Socket timeout")),
      );
      socket.on("error", reject);
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text));
      socket.on("connect", () =>
        socket.write(
          `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`,
        ),
      );
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
    const valid = await fetch(
      `http://127.0.0.1:${address.port}/inspect?run=run`,
    );
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), JSON.stringify(f.store.inspect("run")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    f.close();
  }
});

test("slow SSE consumer cannot block producer or independent readers", async () => {
  const f = fixture();
  const reader = new Store(f.store.path, true);
  const server = await serve(reader);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const slow = httpRequest(`${base}/events?run=run&stream=1`, (r) => r.pause());
  slow.on("error", () => {});
  slow.end();
  try {
    await sleep(50);
    const start = Date.now();
    for (let i = 0; i < 500; i++)
      f.store.event("run", "a", null, null, "message", {
        text: "x".repeat(5000),
      });
    assert.ok(Date.now() - start < 5000);
    const fast = await fetch(`${base}/events?run=run&after=490`);
    const rows = (await fast.json()) as unknown[];
    assert.equal(rows.length, 10);
  } finally {
    slow.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    reader.close();
    f.close();
  }
});
