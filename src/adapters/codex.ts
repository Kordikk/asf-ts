import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import type {
  Accounting,
  Harness,
  HarnessRequest,
  HarnessSink,
  Json,
  Pricing,
  Receipt,
  Tokens,
} from "../types.js";
import {
  delta,
  estimate,
  incomplete,
  validatePricing,
  zeroTokens,
} from "../accounting.js";
import { command } from "../process.js";
import { clip, errorText, json, boundedJson } from "../util.js";
export const CODEX_VERSION = "0.154.0";
export interface CodexPort {
  startThread(options: ThreadOptions): {
    runStreamed(
      prompt: string,
      options: { signal: AbortSignal },
    ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
  };
  resumeThread(
    id: string,
    options: ThreadOptions,
  ): {
    runStreamed(
      prompt: string,
      options: { signal: AbortSignal },
    ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
  };
}
export interface CodexOptions {
  pricing: Pricing;
  executable?: string;
  client?: CodexPort;
  checkVersion?: () => Promise<void>;
}
export class CodexHarness implements Harness {
  readonly name = "codex";
  readonly live = true;
  readonly identity: Json;
  private readonly client: CodexPort;
  private readonly pricing: Pricing;
  private readonly executable: string;
  private readonly checkVersion?: () => Promise<void>;
  constructor(options: CodexOptions) {
    this.pricing = structuredClone(options.pricing);
    this.executable = options.executable ?? "codex";
    this.checkVersion = options.checkVersion;
    this.identity = json({
      adapter: "codex",
      sdk: CODEX_VERSION,
      cli: CODEX_VERSION,
      policy: 1,
      pricing: this.pricing,
      executable: this.executable,
      transport: options.client ? "injected" : "official SDK",
      versionCheck: options.checkVersion ? "injected" : "CLI",
    });
    const injected = options.client;
    this.client = injected
      ? {
          startThread: injected.startThread.bind(injected),
          resumeThread: injected.resumeThread.bind(injected),
        }
      : new Codex({
          codexPathOverride: fileURLToPath(
            new URL("../../scripts/codex-launcher.mjs", import.meta.url),
          ),
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            ASF_CODEX_EXECUTABLE: this.executable,
          },
          config: {
            model_provider: "openai",
            features: { multi_agent: false },
            // Built-in provider IDs cannot be overridden in CLI 0.154.0.
            // ASF does not retry; request/stream retries remain vendor-controlled.
          },
        });
  }
  async preflight(request: Omit<HarnessRequest, "signal">): Promise<void> {
    validatePricing(this.pricing, request.model);
    if (this.checkVersion) return this.checkVersion();
    const result = await command(
      [this.executable, "--version"],
      request.cwd,
      AbortSignal.timeout(5000),
      5000,
    );
    if (
      result.code !== 0 ||
      result.stdout.trim() !== `codex-cli ${CODEX_VERSION}`
    )
      throw new Error("Codex CLI/SDK version mismatch");
  }
  async invoke(request: HarnessRequest, sink: HarnessSink): Promise<Receipt> {
    const options: ThreadOptions = {
      model: request.model,
      workingDirectory: request.cwd,
      sandboxMode: request.mode === "write" ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    };
    const thread = request.session
      ? this.client.resumeThread(request.session.nativeId, options)
      : this.client.startThread(options);
    let nativeId = request.session?.nativeId;
    let text = "",
      truncated = false,
      total: Tokens | undefined,
      last: Accounting | undefined,
      completed = false,
      failed = false,
      error: string | undefined,
      rerouteNotice: string | undefined;
    const baseline =
      (request.session?.baseline as Tokens | undefined) ?? zeroTokens();
    let invalidScope = false;
    // SDK v0.154 removes child error listeners when its iterator is disposed.
    // Forward cancellation only while this invocation owns that iterator; a
    // later workflow/sibling abort must not signal the already-disposed child.
    const sdkController = new AbortController();
    const abortSdk = () => sdkController.abort(request.signal.reason);
    if (request.signal.aborted) abortSdk();
    else request.signal.addEventListener("abort", abortSdk, { once: true });
    try {
      const { events } = await thread.runStreamed(request.prompt, {
        signal: sdkController.signal,
      });
      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            if (nativeId && nativeId !== event.thread_id)
              throw new Error("Native thread identity changed");
            nativeId = event.thread_id;
            sink.event({
              type: "lifecycle",
              sourceId: nativeId,
              data: { state: "thread.started" },
            });
            break;
          case "turn.started":
            sink.event({
              type: "model",
              data: { requested: request.model, actual: null },
            });
            break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = event.item;
            // v0.154 exposes reroutes as textual error items, not model attribution.
            // Keep the first bounded notice independently of the lossy trace sink.
            if (
              item.type === "error" &&
              item.message.startsWith("model rerouted:")
            ) {
              rerouteNotice ??= clip(item.message, 4096);
              failed = true;
            }
            if (item.type === "agent_message") {
              text = clip(item.text);
              truncated = Buffer.byteLength(item.text) > 64 * 1024;
            }
            const known = [
              "agent_message",
              "reasoning",
              "command_execution",
              "file_change",
              "mcp_tool_call",
              "web_search",
              "error",
              "todo_list",
            ];
            if (!known.includes(item.type)) invalidScope = true;
            sink.event({
              type:
                item.type === "agent_message"
                  ? "message"
                  : item.type === "reasoning"
                    ? "reasoning"
                    : "tool",
              sourceId: item.id,
              data: boundedJson({
                ...item,
                ...("text" in item ? { text: clip(item.text, 6000) } : {}),
                ...("aggregated_output" in item
                  ? { aggregated_output: clip(item.aggregated_output, 6000) }
                  : {}),
              }),
              content: true,
            });
            break;
          }
          case "turn.completed": {
            const u = event.usage;
            // Core v0.154 emits cumulative thread totals despite SDK's "during turn" comment.
            total = {
              input:
                u.input_tokens -
                u.cached_input_tokens -
                u.cache_write_input_tokens,
              cacheRead: u.cached_input_tokens,
              cacheWrite: u.cache_write_input_tokens,
              output: u.output_tokens,
              reasoning: u.reasoning_output_tokens,
            };
            const tokens = delta(total, baseline);
            if (
              tokens.input +
                tokens.cacheRead +
                tokens.cacheWrite +
                tokens.output ===
              0
            )
              throw new Error(
                "Zero terminal usage cannot establish accounting",
              );
            const report: Accounting = {
              status: "complete",
              usd: estimate(tokens, this.pricing),
              kind: "asf-calculated",
              model: request.model,
              modelSource: "requested",
              scope:
                "primary-thread reported cumulative-token delta at requested model rates",
              excluded: [
                "structured actual-model attribution absent; textual reroutes fail closed",
                "unreported subagents/provider-internal requests",
                "invoice/subscription spend",
              ],
              source: "codex turn.completed.usage",
              version: CODEX_VERSION,
              tokens,
              pricing: { ...this.pricing },
              raw: json(u),
            };
            if (last && JSON.stringify(last.tokens) !== JSON.stringify(tokens))
              throw new Error("Conflicting terminal usage");
            last = rerouteNotice
              ? incomplete(request.model, rerouteNotice, report)
              : report;
            sink.report("terminal", last);
            completed = true;
            break;
          }
          case "turn.failed":
            failed = true;
            error = event.error.message;
            break;
          case "error":
            failed = true;
            error = event.message;
            break;
          default:
            break; // Unknown informational events are forward-compatible.
        }
      }
    } catch (e) {
      failed = true;
      error = errorText(e);
    } finally {
      request.signal.removeEventListener("abort", abortSdk);
    }
    error = rerouteNotice ?? error;
    const accounting =
      completed && !failed && !invalidScope && last
        ? last
        : incomplete(
            request.model,
            error ?? "Terminal usage missing or unsupported event/scope",
            last,
          );
    return {
      status: request.signal.aborted
        ? "cancelled"
        : failed || !completed
          ? "failed"
          : "succeeded",
      text,
      truncated,
      accounting,
      ...(nativeId ? { nativeId } : {}),
      ...(error ? { error: clip(error, 4096) } : {}),
      ...(nativeId && total && accounting.status === "complete"
        ? { session: { nativeId, baseline: json(total) } }
        : {}),
    };
  }
}
