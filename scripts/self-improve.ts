// Opt-in trusted CLI. No-args/--help do not load adapters or open a database.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentFileConfig } from "../src/config.js";
import type { Json } from "../src/types.js";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    help: { type: "boolean" },
    config: { type: "string" },
    task: { type: "string" },
    cwd: { type: "string" },
    db: { type: "string" },
    run: { type: "string" },
    budget: { type: "string" },
    "max-dispatches": { type: "string" },
    "soft-usd": { type: "string" },
    "trace-content": { type: "boolean" },
  },
});
if (!process.argv.slice(2).length || values.help) {
  console.log(
    "Trusted self-improvement (Node 22.22.x): --live --config FILE --task FILE --cwd ISOLATED_REPO --db PRIVATE_PATH --run ID --budget ID --max-dispatches COUNT --soft-usd AMOUNT [--trace-content]\nRepeat identical arguments/code for explicit resume; no automatic retry. Limits are author-provided and immutable in Store. USD is a soft known-estimate gate, not a hard cap. No default model/prices; tracing off by default.",
  );
} else {
  try {
    for (const name of [
      "config",
      "task",
      "cwd",
      "db",
      "run",
      "budget",
      "max-dispatches",
      "soft-usd",
    ] as const)
      if (!values[name]) throw new Error(`--${name} required`);
    if (!values.live)
      throw new Error(
        "--live acknowledgement required, including explicit resume",
      );
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(values.run!) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(values.budget!)
    )
      throw new Error("Invalid run/budget ID");
    const maxDispatches = Number(values["max-dispatches"]),
      softUsd = Number(values["soft-usd"]);
    if (
      !Number.isInteger(maxDispatches) ||
      maxDispatches < 1 ||
      maxDispatches > 100000 ||
      !Number.isFinite(softUsd) ||
      softUsd <= 0
    )
      throw new Error("Explicit finite positive budget limits required");
    const jsonFile = (path: string): Json => {
      if (!lstatSync(path).isFile() || lstatSync(path).size > 64 * 1024)
        throw new Error("Oversized/nonregular input file");
      return JSON.parse(readFileSync(path, "utf8")) as Json;
    };
    const configPath = realpathSync(values.config!),
      taskPath = realpathSync(values.task!),
      cwd = realpathSync(values.cwd!),
      db = resolve(values.db!);
    const config = jsonFile(configPath) as unknown as Record<
        string,
        AgentFileConfig
      >,
      input = jsonFile(taskPath);
    if (
      !config ||
      Array.isArray(config) ||
      typeof config !== "object" ||
      !config.worker ||
      !config.reviewer
    )
      throw new Error("Agent config requires worker and reviewer");
    const fields = [
      "adapter",
      "model",
      "pricing",
      "mode",
      "instructions",
      "timeoutMs",
      "executable",
    ];
    for (const c of Object.values(config)) {
      if (
        !c ||
        typeof c !== "object" ||
        Object.keys(c).some((k) => !fields.includes(k))
      )
        throw new Error("Invalid agent fields; no secret/key fields supported");
    }
    // Hash the executing TS or frozen JS tree, not the target being edited. Include
    // all runtime imports, shims/policy and exact package/lock pins; changed imports
    // invalidate old runs rather than silently resuming with different code.
    const runner = fileURLToPath(import.meta.url),
      base = dirname(dirname(runner));
    const root = base.endsWith("/dist") ? dirname(base) : base;
    const sources: Record<string, string> = {};
    const digestFile = (path: string): void => {
      sources[path] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    };
    const tree = (path: string): void => {
      for (const name of readdirSync(path).sort()) {
        const full = join(path, name),
          stat = lstatSync(full);
        if (stat.isDirectory()) tree(full);
        else if (stat.isFile()) digestFile(full);
        else throw new Error("Nonregular executing source");
      }
    };
    tree(join(base, "src"));
    tree(join(base, "scripts", "opencode-policy"));
    for (const path of [
      runner,
      join(
        base,
        "examples",
        base === root ? "self-improvement.ts" : "self-improvement.js",
      ),
      join(base, "scripts", "self-improvement-files.mjs"),
      join(base, "scripts", "codex-launcher.mjs"),
      join(root, "package.json"),
      join(root, "package-lock.json"),
    ])
      digestFile(path);
    const { Store } = await import("../src/store.js");
    const { Runtime } = await import("../src/runtime.js");
    const { agentsFromConfig } = await import("../src/config.js");
    const { workflow } = await import("../examples/self-improvement.js");
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          sources,
          configPath,
          taskPath,
          config,
          input,
          cwd,
          db,
          traceContent: !!values["trace-content"],
          node: process.version,
          budget: { id: values.budget, maxDispatches, softUsd },
        }),
      )
      .digest("hex");
    const agents = agentsFromConfig(
      config,
      resolve(dirname(db), "native", values.run!),
    );
    const store = new Store(db),
      controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Operator cancelled"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let result: unknown, failure: string | undefined;
    try {
      const runtime = new Runtime({
        store,
        runId: values.run!,
        workflowIdentity: identity,
        cwd,
        live: true,
        traceContent: !!values["trace-content"],
        signal: controller.signal,
        budget: { id: values.budget!, maxDispatches, softUsd },
      });
      try {
        result = await runtime.run((r) => workflow(r, input, agents));
      } catch (e) {
        failure = String(e instanceof Error ? e.message : e).slice(0, 8000);
      }
      const inspection = store.inspect(values.run!, 0, 1);
      console.log(
        JSON.stringify({
          result: result ?? null,
          failure: failure ?? null,
          totals: inspection.totals,
          budgets: inspection.budgets,
          costsByKind: inspection.costsByKind,
        }),
      );
      if (failure || !(result as { accepted?: boolean })?.accepted)
        process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      try {
        await Promise.all(
          [...new Set(Object.values(agents).map((a) => a.harness))].map((h) =>
            h.close?.(),
          ),
        );
      } finally {
        store.close();
      }
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e).slice(0, 8000));
    process.exitCode = 1;
  }
}
