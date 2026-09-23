// Offline browser regression + actual recordVideo capture. Only a fresh SYNTHETIC DB.
// Run after npm run build. Chromium revision is pinned by @playwright/test.
import {
  chromium,
  expect,
  type Route,
  type Browser,
  type BrowserContext,
  type Video,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { sleep } from "../src/util.js";
import { literal, syntheticDemo } from "./ui-fixture.js";

const output = resolve(".asf/ui-verification");
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(output, "synthetic-"));
const db = join(fixture, "demo.db");
const store = new Store(db);
const demo = await syntheticDemo(store, fixture);
const child = spawn(
  process.execPath,
  ["dist/src/cli.js", "serve", "--db", db, "--port", "0"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let video: Video | undefined;
const pace = () => sleep(process.argv.includes("--quick") ? 50 : 1800);
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    recordVideo: { dir: fixture, size: { width: 1280, height: 1000 } },
  });
  const page = await context.newPage();
  video = page.video()!;
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  const base = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`UI server startup timeout: ${stderr}`)),
      10000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI server exited ${code}: ${stderr}`));
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
  });
  await page.goto(base);
  for (const asset of ["index.html", "ui.js", "flow-model.js", "ui.css"]) {
    const response = await page.request.get(
      new URL(asset === "index.html" ? "/" : `/${asset}`, base).href,
    );
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.deepEqual(bytes, readFileSync(`src/web/${asset}`));
    assert.deepEqual(bytes, readFileSync(`dist/src/web/${asset}`));
  }
  await expect(page.locator("header")).toContainText("Prompts aren't retained");
  await expect(page.locator("#runs option")).toHaveCount(21);
  await page.selectOption("#runs", demo.off);
  await expect(page.locator("#run-status")).toHaveText("Status: completed");
  await expect(page.locator("#action-detail")).toContainText(literal);
  await expect(page.locator("#events")).toContainText("CONTENT OMITTED");
  await expect(page.locator("#events")).not.toContainText(
    "This trace body must be omitted.",
  );
  // The .001 report must not be added again to the .001 final ledger.
  await expect(page.locator("#cost")).toContainText("$0.001000 USD");
  await expect(
    page.locator(".flow-card").filter({ hasText: "retained-answer" }),
  ).toContainText("Visible ledger subtotal: $0.001000 USD");
  await pace();
  await page.locator("#turn-detail").scrollIntoViewIfNeeded();
  await expect(page.locator("#turn-detail")).toContainText(
    "SYNTHETIC-native-session",
  );
  await expect(page.locator("#turn-detail")).toContainText(
    "final survives tracing off",
  );
  await pace();
  await page.locator("#events").scrollIntoViewIfNeeded();
  await pace();
  await page.selectOption("#actions", "local-check");
  await expect(page.locator("#action-detail")).toContainText(
    "SYNTHETIC local command stdout",
  );
  await expect(page.locator("#action-detail")).toContainText(
    "SYNTHETIC stderr",
  );
  await expect(page.locator("#action-detail")).toContainText("Exit: 2");
  await page.locator("#actions").scrollIntoViewIfNeeded();
  await pace();

  // Scope-lane map of genuinely overlapping SYNTHETIC branches. No DAG semantics.
  await page.selectOption("#runs", demo.flow);
  await expect(page.locator("#run-status")).toHaveText("Status: completed");
  await expect(page.locator(".flow-card")).toHaveCount(7);
  await expect(page.locator(".flow-lane h3")).toContainText([
    "Scope: api",
    "Scope: tests",
    "Scope: checks",
    "Scope: held",
    "Scope: unloaded/",
  ]);
  await expect(page.locator("#map-coverage")).toContainText(
    "not a dependency or timing diagram",
  );
  const apiPlan = page.locator(".card-pick").filter({ hasText: "api/plan" });
  await apiPlan.click();
  await expect(page.locator("#actions")).toHaveValue("api/plan");
  await expect(apiPlan).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#turn-detail")).toContainText(
    "SYNTHETIC api plan",
  );
  const apiRail = page.locator(".session-rail").filter({ hasText: "api/plan" });
  await expect(apiRail.locator("button")).toHaveCount(2);
  await apiRail
    .getByRole("button", { name: "api/review · turn 0", exact: true })
    .click();
  await expect(page.locator("#actions")).toHaveValue("api/review");
  await expect(page.locator("#turn-detail")).toContainText(
    "SYNTHETIC api follow-up",
  );
  await page.selectOption("#actions", "checks/host");
  await expect(page.locator(".command-card .card-pick")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#action-detail")).toContainText(
    "SYNTHETIC scoped host check",
  );
  const pending = page
    .locator(".flow-card")
    .filter({ hasText: "held/pending" });
  await pending.locator(".card-pick").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#actions")).toHaveValue("held/pending");
  await expect(pending).toContainText("Turn 0 · reserved");
  await expect(pending).toContainText("unknown (not zero)");
  await expect(page.locator("#turn-detail")).toContainText(
    "no final ledger entry",
  );
  await page.locator(".card-pick").filter({ hasText: demo.oddAction }).click();
  await expect(page.locator("#actions")).toHaveValue(demo.oddAction);
  await expect(
    page.locator(".flow-card").filter({ hasText: demo.oddAction }),
  ).toContainText("No loaded invocations");
  await expect(page.locator("#turns option")).toHaveCount(0);
  await page.selectOption("#actions", "api/plan");
  await page.locator("#map-heading").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, "synthetic-flow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await apiPlan.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#actions")).toHaveValue("api/plan");
  const mapBox = await page.locator(".map-panel").boundingBox();
  const detailBox = await page.locator(".detail-panel").boundingBox();
  assert.ok(
    mapBox && detailBox && detailBox.y >= mapBox.y + mapBox.height,
    "Mobile details stack below the map",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "No mobile page overflow (lane tracks scroll locally)",
  );
  await page.screenshot({
    path: join(output, "synthetic-flow-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });

  await page.selectOption("#runs", demo.live);
  await expect(page.locator("#run-status")).toHaveText("Status: running");
  await expect(page.locator("#turn-detail")).toContainText(
    "no final ledger entry (not zero)",
  );
  await expect(page.locator("#cost")).toContainText("unknown (not zero)");
  await expect(page.locator("#cost")).toContainText(
    "Unresolved invocations: 1",
  );
  await page.locator("#run-title").scrollIntoViewIfNeeded();
  await pace();
  const projected = page
    .locator("#events .observation")
    .filter({ hasText: "synthetic-tool" });
  await expect(projected).toContainText("TRUNCATION indicator");
  await expect(projected).toContainText('"projectionLoss": true');
  await expect(projected).toContainText(
    "raw detail cannot restore omitted content",
  );
  demo.progress();
  await expect(page.locator("#events")).toContainText("SYNTHETIC LIVE UPDATE");
  await page.locator("#events .observation").last().scrollIntoViewIfNeeded();
  await pace();
  // Exercise actual network disconnect/reconnect from the retained cursor.
  const fail = (route: Route) => route.abort("failed");
  await page.route("**/events?**", fail);
  await expect(page.locator("#live-status")).toContainText("Disconnected");
  await page.unroute("**/events?**", fail);
  await expect(page.locator("#live-status")).toContainText("Live ·");
  await expect(
    page
      .locator("#events .observation")
      .filter({ hasText: "SYNTHETIC LIVE UPDATE" }),
  ).toHaveCount(1);
  await pace();

  const liveTurn = page.locator(".turn-track button").first();
  await liveTurn.focus();
  const focusKey = await liveTurn.getAttribute("data-map-key");
  demo.finish();
  await demo.work;
  await expect(page.locator("#run-status")).toHaveText("Status: failed");
  await expect(page.locator("#cost")).toContainText("$0.002000 USD");
  await expect(page.locator("#cost")).toContainText(
    "Unresolved invocations: 1",
  );
  await expect(page.locator("#turns option")).toHaveCount(2);
  await expect(page.locator(".turn-track button").first()).toBeFocused();
  assert.equal(
    await page.locator(":focus").getAttribute("data-map-key"),
    focusKey,
  );
  await expect(page.locator("#actions")).toHaveValue("review");
  const turns = await page
    .locator("#turns option")
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value),
    );
  await page.selectOption("#turns", turns[0]!);
  await expect(page.locator("#turn-detail")).toContainText(
    "invalid JSON retained from turn 0",
  );
  await page.locator("#turns").scrollIntoViewIfNeeded();
  await pace();
  await page
    .locator(".turn-track button")
    .filter({ hasText: "Turn 1" })
    .click();
  await expect(page.locator("#turns")).toHaveValue(turns[1]!);
  await expect(page.locator("#turn-detail")).toContainText('{"approved":true}');
  await page.locator("#turn-detail details").first().locator("summary").click();
  await pace();
  await page.selectOption("#actions", "missing-cost");
  await expect(page.locator("#turn-detail")).toContainText(
    "Primary cost: unknown (not zero)",
  );
  await expect(page.locator("#turn-detail")).toContainText(
    "TRUNCATED final response",
  );
  await expect(page.locator("#events")).toContainText("TRUNCATION indicator");
  await expect(page.locator("#turn-detail")).toContainText(literal);
  await page.locator("#turns").scrollIntoViewIfNeeded();
  await pace();
  await page.locator("#events").scrollIntoViewIfNeeded();
  await pace();
  await page.screenshot({
    path: join(output, "workflow-ui.png"),
    fullPage: true,
  });

  // Bounded event backlog pauses, pages explicitly and never duplicates DOM rows.
  store.transaction(() => {
    for (let i = 0; i < 230; i++)
      store.event(demo.live, null, null, null, "lifecycle", {
        synthetic: true,
        index: i,
      });
  });
  await expect(page.locator("#live-status")).toContainText(
    "History paging paused",
  );
  await expect(page.locator("#events .observation")).toHaveCount(100);
  const paused = await page.locator("#window-status").textContent();
  await sleep(1200);
  assert.equal(await page.locator("#window-status").textContent(), paused);
  await page.click("#events-next");
  await expect(page.locator("#window-status")).not.toHaveText(paused!);
  await expect(page.locator("#live-status")).toContainText(
    "History paging paused",
  );
  await page.click("#events-next");
  await expect(page.locator("#live-status")).toContainText("Live ·");
  const cursors = await page
    .locator("#events .observation")
    .evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.cursor),
    );
  assert.equal(cursors.length, 100);
  assert.equal(new Set(cursors).size, cursors.length);

  // Switch runs while polling: no old-window data or continuing old-run requests.
  await page.selectOption("#runs", demo.off);
  await expect(page.locator("#run-status")).toHaveText("Status: completed");
  await expect(page.locator("#events")).not.toContainText(
    "SYNTHETIC LIVE UPDATE",
  );
  const start = requests.length;
  await sleep(1200);
  assert.ok(
    requests
      .slice(start)
      .every((url) => !url.includes(encodeURIComponent(demo.live))),
  );
  await page.click("#runs-next");
  await expect(page.locator("#runs-page")).toContainText("offset 20");
  await expect(page.locator("#runs option")).toHaveCount(5);
  await page.selectOption("#runs", { index: 1 });
  await expect(page.locator("#actions option")).toHaveCount(0);
  await expect(page.locator("#cost")).toContainText("unknown (not zero)");
  // Independently paged action results (no fabricated invocations needed).
  const archive = await page.locator("#runs").inputValue();
  for (let i = 0; i < 21; i++) {
    const id = `SYNTHETIC-record-${i}`;
    store.action(archive, id, id);
    store.finishAction(archive, id, { text: `SYNTHETIC paged result ${i}` });
  }
  await expect(page.locator("#actions option")).toHaveCount(20);
  await expect(page.locator(".flow-card")).toHaveCount(20);
  await expect(page.locator(".flow-card").first()).toContainText(
    "No loaded invocations",
  );
  await page.click("#records-next");
  await expect(page.locator("#records-page")).toContainText(
    "offset 20; 1 actions",
  );
  await expect(page.locator("#action-detail")).toContainText("paged result 20");
  await expect(page.locator(".flow-card")).toHaveCount(1);
  await expect(page.locator("#session-links button")).toHaveCount(0);
  await page.click("#records-prev");
  await expect(page.locator("#actions option")).toHaveCount(20);

  // A stale list item can outlive a run record; it must not look completed/zero-cost.
  const empty = await page.locator("#runs option").last().getAttribute("value");
  store.db.prepare("DELETE FROM runs WHERE id=?").run(empty!);
  await page.selectOption("#runs", empty!);
  await expect(page.locator("#run-status")).toContainText("Unknown run");
  await page.click("#runs-prev");
  await page.selectOption("#runs", demo.live);
  await expect(page.locator("#run-status")).toHaveText("Status: failed");
  await page.locator("header").scrollIntoViewIfNeeded();
  await pace();
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => "uiXss" in globalThis), false);
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every((url) => url.startsWith(base)),
    "No external requests, including from untrusted content",
  );
  console.log(
    "PASS: built/source asset parity, scope map, session membership, pending nodes in completed run, keyboard/cards/turns/dropdown sync, polling focus, mobile stack, selection, turn receipts, command outputs, omissions/truncation, nullable costs, live updates/reconnect, bounded paging, run cleanup, unknown runs, literal XSS strings; no external requests.",
  );
} finally {
  demo.finish();
  await demo.work;
  try {
    await context?.close();
    if (video) {
      await video.saveAs(join(output, "workflow-ui.webm"));
      await video.delete();
    }
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    store.close();
  }
}
console.log(
  `Video: ${join(output, "workflow-ui.webm")} (${statSync(join(output, "workflow-ui.webm")).size} bytes)`,
);
console.log(
  `SYNTHETIC DB: ${db}\nView: npm run asf -- serve --db ${db} --port 8080`,
);
