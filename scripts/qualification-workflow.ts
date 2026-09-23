// Shared by the opt-in CLI and separately authorized programmatic qualification.
// Importing this module performs no IO or model work.
import type { AgentConfig, Harness, Json, Runtime } from "../src/index.js";

export async function qualificationWorkflow(
  r: Runtime,
  agent: AgentConfig,
): Promise<void> {
  const read = await r.agent(
    "read-tool",
    { ...agent, mode: "read-only", timeoutMs: 120_000 },
    {
      prompt:
        "Use a file read tool to read fixture.txt. Return its exact marker. Do not write.",
    },
  );
  if (!read.text.includes("qualification-marker-742"))
    throw new Error("Read evidence missing");
  const continued = await r.agent(
    "continuation",
    { ...agent, mode: "read-only", timeoutMs: 120_000 },
    {
      prompt: "Without tools, repeat the marker you just read.",
      session: read.session,
    },
  );
  if (!continued.text.includes("qualification-marker-742"))
    throw new Error("Continuation evidence missing");
  await r.agent(
    "write",
    { ...agent, mode: "write", timeoutMs: 120_000 },
    {
      prompt:
        "Read fixture.txt, then write its exact contents into result.txt in this directory using a write tool. Do not run unrelated commands.",
    },
  );
  const check = await r.command("verify-write", [
    "node",
    "-e",
    `const f=require('fs');if(f.readFileSync('result.txt','utf8')!==f.readFileSync('fixture.txt','utf8'))process.exit(1)`,
  ]);
  if (check.code !== 0) throw new Error("Write evidence failed");
  // Deliberate format-only fixture: real native response, no forged output/usage.
  const base = agent.harness;
  const fixture: Harness = {
    name: base.name,
    live: true,
    identity: { base: base.identity, formatFixture: 1 } as Json,
    preflight: (q) => base.preflight(q),
    invoke: (q, s) =>
      base.invoke(
        {
          ...q,
          prompt: q.prompt.includes("ASF_FORMAT_FIXTURE")
            ? "For a format-repair qualification test, return exactly NOT_JSON and nothing else. Do not use tools. A later prompt will request JSON."
            : q.prompt,
        },
        s,
      ),
  };
  await r.agent<{ ok: boolean }>(
    "format",
    { ...agent, harness: fixture, mode: "read-only", timeoutMs: 120_000 },
    {
      prompt: "ASF_FORMAT_FIXTURE",
      schema: {
        type: "object",
        properties: { ok: { const: true } },
        required: ["ok"],
        additionalProperties: false,
      },
      corrections: 1,
    },
  );
}
