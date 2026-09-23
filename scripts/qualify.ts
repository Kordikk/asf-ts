import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Runtime, Store } from "../src/index.js";
import { qualificationWorkflow } from "./qualification-workflow.js";
import { agentsFromConfig, type AgentFileConfig } from "../src/config.js";
import { hash } from "../src/util.js";
const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    config: { type: "string" },
    agent: { type: "string", default: "worker" },
    run: { type: "string" },
    db: { type: "string", default: ".asf/qualification.db" },
    budget: { type: "string", default: "parent-qualification-v1" },
    "max-dispatches": { type: "string", default: "20" },
    "soft-usd": { type: "string", default: "10" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Opt-in live qualification: npm run qualify -- --live --config FILE --agent worker --run UNIQUE_ID [--db SHARED_DB --budget parent-qualification-v1 --max-dispatches 20 --soft-usd 10]\nNever run automatically. Reuse SAME database/budget for all qualification probes. Max 20 turns / $10 estimated soft threshold; invisible native requests are not dispatch turns.",
  );
} else {
  if (
    !values.live ||
    !values.config ||
    !values.run ||
    !/^[\w-]{1,100}$/.test(values.run)
  )
    throw new Error("--live --config FILE --run SAFE_ID required");
  const max = Number(values["max-dispatches"]),
    usd = Number(values["soft-usd"]);
  if (
    !Number.isInteger(max) ||
    max < 1 ||
    max > 20 ||
    !Number.isFinite(usd) ||
    usd <= 0 ||
    usd > 10
  )
    throw new Error(
      "Qualification ceilings: 20 dispatches and $10 estimated soft threshold",
    );
  const config = JSON.parse(readFileSync(values.config, "utf8")) as Record<
    string,
    AgentFileConfig
  >;
  const root = resolve(".asf/qualification", values.run),
    cwd = resolve(root, "work");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const agents = agentsFromConfig(config, resolve(root, "native"));
  const agent = agents[values.agent];
  if (!agent) throw new Error("Configured agent not found");
  // Fixture creation is host-side, only after acknowledgement, only in the disposable probe directory.
  writeFileSync(resolve(cwd, "fixture.txt"), "qualification-marker-742\n");
  const store = new Store(resolve(values.db));
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(new Error("Qualification wall time exceeded")),
      12 * 60_000,
    );
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const runtime = new Runtime({
      store,
      runId: values.run,
      workflowIdentity: hash({
        qualification: 1,
        config,
        agent: values.agent,
        cwd,
      }),
      cwd,
      live: true,
      traceContent: true,
      signal: controller.signal,
      budget: { id: values.budget, maxDispatches: max, softUsd: usd },
    });
    await runtime.run((r) => qualificationWorkflow(r, agent));
    writeFileSync(
      resolve(root, "summary.json"),
      JSON.stringify(store.inspect(values.run, 0, 100), null, 2),
      { mode: 0o600 },
    );
    console.log(
      `Qualification retained in ${values.db}; work/evidence ${root}. Inspect tool events and scoped ledger; no invoice/full-coverage claim.`,
    );
  } finally {
    clearTimeout(timer);
    store.close();
  }
}
