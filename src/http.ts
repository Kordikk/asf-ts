import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

import { Store } from "./store.js";
import { errorText } from "./util.js";
/** Local read-only inspection; clients poll SQLite independently, never provider drains. */
export async function serve(store: Store, port = 0): Promise<Server> {
  // Explicit allowlist, resolved relative to this module for source and dist.
  const assets = new Map(
    [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/flow-model.js", "flow-model.js", "text/javascript; charset=utf-8"],
      ["/ui.js", "ui.js", "text/javascript; charset=utf-8"],
      ["/ui.css", "ui.css", "text/css; charset=utf-8"],
    ].map(([route, file, type]) => [
      route,
      {
        body: readFileSync(new URL(`./web/${file}`, import.meta.url)),
        type: type!,
      },
    ]),
  );
  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    // No CORS, no remote bind, no mutation; deny browser cross-origin fetches.
    const host = req.headers.host ?? "";
    if (
      req.method !== "GET" ||
      req.headers.origin ||
      !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const asset = assets.get(url.pathname);
      if (asset) {
        res.setHeader("Content-Type", asset.type);
        res.end(asset.body);
        return;
      }
      if (url.pathname === "/runs") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            store.runs(
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          ),
        );
        return;
      }
      if (url.pathname !== "/inspect" && url.pathname !== "/events") {
        res.writeHead(404).end();
        return;
      }
      const run = url.searchParams.get("run");
      if (!run || run.length > 200) {
        res.writeHead(400).end("run required");
        return;
      }
      if (url.pathname === "/inspect") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            store.inspect(
              run,
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          ),
        );
        return;
      }
      if (url.pathname !== "/events") {
        res.writeHead(404).end();
        return;
      }
      let cursor = Number(
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      let rows = store.events(
        run,
        cursor,
        Math.min(100, Number(url.searchParams.get("limit") ?? 100)),
      );
      if (url.searchParams.get("stream") !== "1") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(rows));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      let busy = false;
      let stalledAt = 0;
      const timer = setInterval(() => {
        if (busy) {
          if (Date.now() - stalledAt > 2000) res.destroy();
          return;
        }
        try {
          rows = store.events(run, cursor, 100);
          for (const row of rows) {
            cursor = row.cursor;
            if (
              !res.write(`id: ${row.cursor}\ndata: ${JSON.stringify(row)}\n\n`)
            ) {
              busy = true;
              stalledAt = Date.now();
              break;
            }
          }
        } catch {
          res.destroy();
        }
      }, 50);
      res.on("drain", () => {
        busy = false;
      });
      res.on("close", () => clearInterval(timer));
    } catch (e) {
      res.writeHead(400).end(errorText(e));
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
