import type { AgentConfig, AgentResult, Runtime } from "../src/index.js";

type ReadResult = { marker: string; subtotal: number };
type CombinedResult = {
  marker: string;
  codexSubtotal: number;
  opencodeSubtotal: number;
  total: number;
};

const readSchema = {
  type: "object",
  properties: {
    marker: { type: "string" },
    subtotal: { type: "integer" },
  },
  required: ["marker", "subtotal"],
  additionalProperties: false,
};
const combinedSchema = {
  type: "object",
  properties: {
    marker: { type: "string" },
    codexSubtotal: { type: "integer" },
    opencodeSubtotal: { type: "integer" },
    total: { type: "integer" },
  },
  required: ["marker", "codexSubtotal", "opencodeSubtotal", "total"],
  additionalProperties: false,
};

export async function mixedQualificationWorkflow(
  runtime: Runtime,
  agents: { codex: AgentConfig; opencode: AgentConfig },
): Promise<{
  codex: AgentResult<ReadResult>;
  opencode: AgentResult<ReadResult>;
  combined: AgentResult<CombinedResult>;
}> {
  const codex = {
    ...agents.codex,
    mode: "read-only" as const,
    timeoutMs: 120_000,
  };
  const opencode = {
    ...agents.opencode,
    mode: "read-only" as const,
    timeoutMs: 120_000,
  };
  const [codexResult, opencodeResult] = await Promise.all([
    runtime.scope("codex").agent<ReadResult>("read", codex, {
      prompt:
        "Use native read-only tooling to read left.json; a read-only command is allowed if required. The file is a JSON fixture with marker and values. Sum values and return only JSON with that marker and integer subtotal. Do not write files, access the network, or inspect unrelated files.",
      schema: readSchema,
      corrections: 0,
    }),
    runtime.scope("opencode").agent<ReadResult>("read", opencode, {
      prompt:
        "Use the native read tool to read right.json. The file is a JSON fixture with marker and values. Sum values and return only JSON with that marker and integer subtotal. Do not write or run commands.",
      schema: readSchema,
      corrections: 0,
    }),
  ]);
  if (codexResult.value.marker !== opencodeResult.value.marker)
    throw new Error("Fixture markers disagree");

  const combined = await runtime
    .scope("codex")
    .agent<CombinedResult>("combine", codex, {
      prompt:
        "Without tools, combine the two returned JSON values in the selected context. Return only JSON with the shared marker, both subtotals, and their integer total.",
      context: { codex: codexResult.value, opencode: opencodeResult.value },
      schema: combinedSchema,
      corrections: 0,
      session: codexResult.session,
    });
  return { codex: codexResult, opencode: opencodeResult, combined };
}
