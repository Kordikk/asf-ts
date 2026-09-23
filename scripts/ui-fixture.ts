// SYNTHETIC OFFLINE ONLY. No provider imports, constructors, native state or model calls.
import { Runtime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import type {
  Accounting,
  Harness,
  HarnessSink,
  Receipt,
} from "../src/types.js";

export const literal =
  '<img src="https://invalid.example/leak" onerror="globalThis.uiXss=1"> <script>globalThis.uiXss=1</script>';
const accounting: Accounting = {
  status: "complete",
  usd: 0.001,
  kind: "asf-calculated",
  model: "SYNTHETIC-no-model",
  modelSource: "requested",
  scope: "SYNTHETIC fixture only — not a real charge",
  excluded: [],
  source: "offline fixture",
  version: "1",
  tokens: null,
  pricing: null,
};
function mock(invoke: Harness["invoke"]): Harness {
  return {
    name: "SYNTHETIC",
    live: false,
    identity: { synthetic: true },
    async preflight() {},
    invoke,
  };
}
function receipt(text: string): Receipt {
  return {
    status: "succeeded",
    text,
    accounting,
    session: { nativeId: "SYNTHETIC-native-session", baseline: 1 },
  };
}
export async function syntheticDemo(store: Store, cwd: string) {
  const runtime = (runId: string, traceContent = false) =>
    new Runtime({
      store,
      runId,
      cwd,
      workflowIdentity: "SYNTHETIC-ui-v1",
      traceContent,
    });
  // Small empty runs exercise run paging without any external work.
  for (let i = 0; i < 21; i++) {
    await runtime(`SYNTHETIC-archive-${String(i).padStart(2, "0")}`).run(
      async () => {},
    );
  }
  const off = "SYNTHETIC-1-tracing-off";
  await runtime(off).run(async (r) => {
    await r.agent(
      "retained-answer",
      {
        model: "SYNTHETIC-no-model",
        harness: mock(async (_request, sink) => {
          sink.event({
            type: "message",
            content: true,
            data: { text: "This trace body must be omitted." },
          });
          sink.event({
            type: "tool",
            content: true,
            data: { tool: "synthetic read", output: "omitted" },
          });
          sink.report("terminal", accounting);
          return receipt(
            `SYNTHETIC final survives tracing off. Literal untrusted content:\n${literal}`,
          );
        }),
      },
      { prompt: "SYNTHETIC prompt is not retained" },
    );
    await r.command("local-check", [
      process.execPath,
      "-e",
      `console.log(${JSON.stringify(`SYNTHETIC local command stdout\n${literal}`)}); console.error('SYNTHETIC stderr'); process.exitCode=2;`,
    ]);
  });
  const flow = "SYNTHETIC-3-scoped-flow";
  await runtime(flow).run(async (r) => {
    let arrivals = 0;
    let releaseBranches!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBranches = resolve;
    });
    // Actual overlapping synthetic branches, but the UI must not infer parallelism from names.
    await Promise.all(
      ["api", "tests"].map(async (name) => {
        const scope = r.scope(name);
        const agent = {
          model: "SYNTHETIC-no-model",
          harness: mock(async (request) => {
            if (!request.session) {
              if (++arrivals === 2) releaseBranches();
              await both;
            }
            return {
              ...receipt(
                `SYNTHETIC ${name} ${request.session ? "follow-up" : "plan"}`,
              ),
              session: {
                nativeId: `SYNTHETIC-${name}`,
                baseline: request.session ? 2 : 1,
              },
            };
          }),
        };
        const plan = await scope.agent("plan", agent, {
          prompt: "SYNTHETIC plan",
        });
        await scope.agent("review", agent, {
          prompt: "SYNTHETIC follow-up",
          session: plan.session,
        });
      }),
    );
    await r
      .scope("checks")
      .command("host", [
        process.execPath,
        "-e",
        "console.log('SYNTHETIC scoped host check')",
      ]);
  });
  // Deliberately contradictory durable node states: completed run is not a status override.
  store.action(flow, "held/pending", "SYNTHETIC pending");
  store.reserve(flow, "held/pending", 0, undefined, undefined, false, "model");
  const oddAction = `unloaded/quotes['"] # : ${literal}`;
  store.action(flow, oddAction, "SYNTHETIC no invocation");
  const live = "SYNTHETIC-2-live-observations";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let sink: HarnessSink;
  let turn = 0;
  const harness = mock(async (_request, s) => {
    sink = s;
    turn++;
    s.event({
      type: "reasoning",
      sourceId: `synthetic-item-${turn}`,
      content: true,
      data: {
        text: `SYNTHETIC reasoning observation, turn ${turn}; not a transcript.`,
      },
    });
    if (turn === 1) {
      s.event({
        type: "tool",
        sourceId: "synthetic-tool",
        content: true,
        data: {
          tool: "synthetic read",
          output: "SYNTHETIC local fixture only — waiting for progress",
          retainedPrefix: "SYNTHETIC projection loss ".repeat(100),
        },
      });
      ready();
      await gate;
    }
    s.report("terminal", accounting);
    return receipt(
      turn === 1
        ? "SYNTHETIC invalid JSON retained from turn 0"
        : '{"approved":true}',
    );
  });
  // Catch only the deliberately incomplete/truncated final action. No resend/correction follows it.
  const work = runtime(live, true)
    .run(async (r) => {
      await r.agent(
        "review",
        { harness, model: "SYNTHETIC-no-model" },
        {
          prompt: "SYNTHETIC typed correction",
          corrections: 1,
          schema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
            additionalProperties: false,
          },
        },
      );
      await r.agent(
        "missing-cost",
        {
          model: "SYNTHETIC-no-model",
          harness: mock(async (_request, s) => {
            s.event({
              type: "message",
              content: true,
              data: Object.fromEntries(
                Array.from({ length: 20 }, (_, i) => [
                  `part${i}`,
                  "SYNTHETIC ".repeat(100),
                ]),
              ),
            });
            return {
              ...receipt(
                "SYNTHETIC partial final response; remaining output unavailable.",
              ),
              truncated: true,
              status: "failed",
              error: `SYNTHETIC provider failure ${literal}`,
              accounting: {
                ...accounting,
                status: "incomplete",
                usd: null,
                reason: "SYNTHETIC usage unavailable; do not interpret as zero",
              },
            };
          }),
        },
        { prompt: "SYNTHETIC incomplete receipt" },
      );
    })
    .then(
      () => {
        throw new Error("Expected synthetic failure");
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("SYNTHETIC"))
          throw error;
      },
    );
  await started;
  return {
    off,
    flow,
    oddAction,
    live,
    work,
    finish: release,
    progress: () =>
      sink.event({
        type: "tool",
        sourceId: "synthetic-tool-progress",
        content: true,
        data: {
          tool: "synthetic read",
          output: "SYNTHETIC LIVE UPDATE arrived while invocation was running",
          literal,
        },
      }),
  };
}
