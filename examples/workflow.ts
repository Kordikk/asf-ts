import type { AgentConfig, Json, Runtime } from "../src/index.js";
/** Trusted workflow: explicit IDs, selected context, parallel scopes, finite repair. */
export async function workflow(
  r: Runtime,
  input: Json,
  agents: Record<string, AgentConfig>,
): Promise<unknown> {
  const agent = agents.worker;
  if (!agent) {
    // runnable offline example, including negative branch
    const first = await r.command("check", ["node", "-e", "process.exit(1)"]);
    return first.code === 0
      ? first
      : r.command("repair-check", [
          "node",
          "-e",
          'console.log("finite offline repair verified")',
        ]);
  }
  const analyses = await Promise.all(
    ["requirements", "risks"].map((topic) =>
      r.scope(topic).agent(
        "plan",
        { ...agent, mode: "read-only" },
        {
          prompt: `Briefly analyze ${topic}. Do not edit files.`,
          context: input,
        },
      ),
    ),
  );
  const implementation = await r.agent(
    "implement",
    { ...agent, mode: "write" },
    {
      prompt:
        "Implement the selected task in this workdir; keep changes small.",
      context: { task: input, plans: analyses.map((a) => a.text) },
    },
  );
  let check = await r.command("check", ["npm", "test"], { timeoutMs: 120_000 });
  if (check.code !== 0) {
    await r.agent(
      "repair",
      { ...agent, mode: "write" },
      {
        prompt: "Fix the failed check. One repair attempt only.",
        session: implementation.session,
        context: { stdout: check.stdout, stderr: check.stderr },
      },
    );
    check = await r.command("recheck", ["npm", "test"], { timeoutMs: 120_000 });
  }
  const review = await r.agent<{ approved: boolean; reason: string }>(
    "review",
    { ...agent, mode: "read-only" },
    {
      prompt: "Review the change and check evidence. Do not edit.",
      context: {
        implementation: implementation.text,
        check: { code: check.code, stdout: check.stdout, stderr: check.stderr },
      },
      schema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["approved", "reason"],
        additionalProperties: false,
      },
      corrections: 1,
    },
  );
  return {
    accepted: check.code === 0 && review.value.approved,
    review: review.value,
  };
}
