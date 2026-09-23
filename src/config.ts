import { resolve } from "node:path";
import { CodexHarness } from "./adapters/codex.js";
import { OpenCodeHarness } from "./adapters/opencode.js";
import type { AgentConfig, Pricing } from "./types.js";
export interface AgentFileConfig {
  adapter: "codex" | "opencode";
  model: string;
  pricing: Pricing;
  mode?: "read-only" | "write";
  instructions?: string;
  timeoutMs?: number;
  executable?: string;
}
export function agentsFromConfig(
  config: Record<string, AgentFileConfig>,
  nativeDirectory: string,
): Record<string, AgentConfig> {
  return Object.fromEntries(
    Object.entries(config).map(([name, c]) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid agent name");
      if (!["codex", "opencode"].includes(c.adapter))
        throw new Error("Unsupported adapter");
      const harness =
        c.adapter === "codex"
          ? new CodexHarness({ pricing: c.pricing, executable: c.executable })
          : new OpenCodeHarness({
              pricing: c.pricing,
              directory: resolve(nativeDirectory, name),
              executable: c.executable,
            });
      return [
        name,
        {
          harness,
          model: c.model,
          mode: c.mode ?? "read-only",
          instructions: c.instructions,
          timeoutMs: c.timeoutMs,
        },
      ];
    }),
  );
}
