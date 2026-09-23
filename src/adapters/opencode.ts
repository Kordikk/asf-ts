import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  SessionLogOutput,
  TokenUsageInfo,
  V2Event,
} from "@opencode-ai/client";
import type {
  Accounting,
  AdditionalCost,
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
import {
  clip,
  errorText,
  json,
  canonical,
  boundedJson,
  hash,
  sleep,
} from "../util.js";
import {
  privateServer,
  requirePolicy,
  OPENCODE_VERSION,
  validatePrivateApiKey,
  type PrivateApiKey,
  type PrivateServer,
} from "./opencode-server.js";
interface Baseline {
  seq: number;
  tokens: Tokens;
  serverKey: string;
  nativeCost: number;
}
export interface OpenCodeOptions {
  /** Opt-in native credential provisioning; supply from a separately authorized secret source. */
  apiKey?: PrivateApiKey;
  pricing: Pricing;
  directory: string;
  executable?: string;
  server?: (request: HarnessRequest) => Promise<PrivateServer>;
  checkVersion?: () => Promise<void>;
}
export const openCodeTokens = (t: TokenUsageInfo): Tokens => ({
  input: t.input,
  cacheRead: t.cache.read,
  cacheWrite: t.cache.write,
  output: t.output + t.reasoning,
  reasoning: t.reasoning,
});
export class OpenCodeHarness implements Harness {
  readonly name = "opencode";
  readonly live = true;
  readonly identity: Json;
  private readonly pricing: Pricing;
  private readonly apiKey?: PrivateApiKey;
  private readonly directory: string;
  private readonly executable: string;
  private readonly server?: OpenCodeOptions["server"];
  private readonly checkVersion?: () => Promise<void>;
  constructor(options: OpenCodeOptions) {
    this.pricing = structuredClone(options.pricing);
    this.apiKey = options.apiKey ? { ...options.apiKey } : undefined;
    this.directory = resolve(options.directory);
    this.executable = options.executable ?? "opencode2";
    this.server = options.server;
    this.checkVersion = options.checkVersion;
    this.identity = json({
      adapter: "opencode",
      sdk: OPENCODE_VERSION,
      cli: OPENCODE_VERSION,
      transport: options.server
        ? "injected official-client server"
        : "official HTTP client/private stdio server",
      policy: 1,
      pricing: this.pricing,
      directory: this.directory,
      executable: this.executable,
      versionCheck: options.checkVersion ? "injected" : "CLI",
      ...(this.apiKey
        ? {
            authentication: {
              mode: "private-api-key",
              integrationID: this.apiKey.integrationID,
            },
          }
        : {}),
    });
  }
  async preflight(request: Omit<HarnessRequest, "signal">): Promise<void> {
    validatePricing(this.pricing, request.model);
    if (!/^[^/]+\/.+$/.test(request.model))
      throw new Error("OpenCode model must be provider/model");
    if (this.apiKey) {
      validatePrivateApiKey(this.apiKey);
      if (request.model.split("/")[0] !== this.apiKey.integrationID)
        throw new Error(
          "OpenCode private credential does not match the requested provider",
        );
    }
    if (this.checkVersion) return this.checkVersion();
    const result = await command(
      [this.executable, "--version"],
      request.cwd,
      AbortSignal.timeout(5000),
      5000,
    );
    if (
      result.code !== 0 ||
      ![
        OPENCODE_VERSION,
        `v${OPENCODE_VERSION}`,
        `opencode2 v${OPENCODE_VERSION}`,
      ].includes(result.stdout.trim())
    )
      throw new Error("OpenCode CLI/SDK version mismatch");
  }
  async invoke(request: HarnessRequest, sink: HarnessSink): Promise<Receipt> {
    const serverKey = request.session
      ? (request.session.baseline as unknown as Baseline).serverKey
      : randomUUID();
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(serverKey))
      throw new Error("Invalid owned native server key");
    const server = await (this.server?.(request) ??
      privateServer({
        directory: resolve(this.directory, serverKey),
        cwd: request.cwd,
        mode: request.mode,
        executable: this.executable,
        signal: request.signal,
        // Continuations reuse their owned database and the credential already
        // provisioned there. Never import a global native credential/session DB.
        ...(this.apiKey && !request.session ? { apiKey: this.apiKey } : {}),
      }));
    const client = server.client;
    let sessionID = request.session?.nativeId;
    let baseline: Baseline = request.session
      ? (request.session.baseline as unknown as Baseline)
      : { seq: 0, tokens: zeroTokens(), serverKey, nativeCost: 0 };
    let seq = baseline.seq,
      text = "",
      truncated = false,
      succeeded = false,
      bad: string | undefined;
    let last: Accounting | undefined;
    const sum = zeroTokens();
    const additional: AdditionalCost[] = [];
    const models = new Map<string, string>();
    const seen = new Map<number, string>();
    let eventCount = 0,
      stepCount = 0,
      pricedStepCount = 0;
    const streamAbort = new AbortController();
    let stream: Promise<void> | undefined;
    let nativeStepCost = 0,
      unpricedNativeStepCost = 0;
    const accounting = (): Accounting => {
      const hasPricedSteps = pricedStepCount > 0;
      return {
        additional: [
          ...(unpricedNativeStepCost > 0
            ? [
                {
                  usd: unpricedNativeStepCost,
                  kind: "harness-estimated" as const,
                  scope:
                    "native failed-step estimate without reported token usage",
                  model: null,
                  source: "session.step.failed.cost",
                  version: OPENCODE_VERSION,
                },
              ]
            : []),
          ...additional,
        ],
        status: hasPricedSteps ? "complete" : "incomplete",
        usd: hasPricedSteps ? estimate(sum, this.pricing) : null,
        kind: "asf-calculated",
        model: request.model,
        modelSource: "observed",
        scope:
          "exposed main-session inference tokens; explicit rates, not native catalog cost",
        excluded: [
          "provider-internal requests and unreported token components",
          "invoice/subscription spend",
        ],
        source:
          "OpenCode public event feed / assistant model / aggregate watermark",
        version: OPENCODE_VERSION,
        tokens: hasPricedSteps ? { ...sum } : null,
        pricing: { ...this.pricing },
        ...(!hasPricedSteps
          ? { reason: "Main-session token usage unavailable" }
          : {}),
      };
    };
    const consume = (event: SessionLogOutput | V2Event): void => {
      if (
        event.type === "log.synced" ||
        !("data" in event) ||
        !("sessionID" in event.data) ||
        event.data.sessionID !== sessionID
      )
        return;
      if (!("durable" in event)) {
        if (
          event.type === "session.text.delta" ||
          event.type === "session.reasoning.delta" ||
          event.type === "session.tool.progress"
        )
          sink.event({
            type:
              event.type === "session.text.delta"
                ? "message"
                : event.type === "session.reasoning.delta"
                  ? "reasoning"
                  : "tool",
            sourceId: event.id,
            data: boundedJson({ nativeType: event.type, ...event.data }),
            content: true,
          });
        return;
      }
      const n = event.durable.seq;
      if (n <= baseline.seq) return;
      const digest = hash(boundedJson(event));
      if (seen.has(n)) {
        if (seen.get(n) !== digest)
          throw new Error("Conflicting native log event");
        return;
      }
      if (++eventCount > 5000) throw new Error("Native event limit exceeded");
      seen.set(n, digest);
      if (n !== seq + 1)
        bad = "Native live sequence gap; historical replay unavailable";
      seq = Math.max(seq, n);
      if (event.type === "session.step.started") {
        text = "";
        truncated = false;
        const model = `${event.data.model.providerID}/${event.data.model.id}`;
        models.set(event.data.assistantMessageID, model);
        sink.event({
          type: "model",
          sourceId: event.id,
          data: json(event.data),
        });
      } else if (
        event.type === "session.step.ended" ||
        event.type === "session.step.failed"
      ) {
        if (++stepCount > 1000) throw new Error("Step limit exceeded");
        const d = event.data;
        const nativeCost =
          d.cost !== undefined && Number.isFinite(d.cost) && d.cost >= 0
            ? d.cost
            : undefined;
        if (nativeCost !== undefined) nativeStepCost += nativeCost;
        const model = models.get(d.assistantMessageID);
        if (model !== request.model)
          bad = "Observed model missing or differs from explicit pricing";
        if (!d.tokens) {
          bad = "Failed step has no usage";
          if (nativeCost !== undefined && nativeCost > 0)
            unpricedNativeStepCost += nativeCost;
          last = incomplete(request.model, bad, accounting());
        } else {
          const t = openCodeTokens(d.tokens);
          estimate(t, this.pricing);
          if (t.input + t.cacheRead + t.cacheWrite + t.output === 0)
            bad = "Zero normalized usage is not reliable accounting";
          for (const k of Object.keys(sum) as (keyof Tokens)[]) sum[k] += t[k];
          pricedStepCount++;
          last = accounting();
          if (bad) last = incomplete(request.model, bad, last);
        }
        sink.report(`step:${event.id}`, {
          ...last,
          raw: json({
            model: model ?? null,
            tokens: d.tokens ?? null,
            nativeCost: nativeCost ?? null,
            ...(event.type === "session.step.failed"
              ? { failure: boundedJson(event.data.error) }
              : {}),
          }),
        });
        if (event.type === "session.step.failed")
          bad = "Native inference failed; failure coverage may be incomplete";
      } else if (event.type === "session.text.ended") {
        const combined = text + event.data.text;
        truncated ||= Buffer.byteLength(combined) > 64 * 1024;
        text = clip(combined);
      } else if (event.type === "session.usage.recorded") {
        bad = `Auxiliary ${event.data.source} usage lacks model provenance`;
        additional.push({
          usd: event.data.cost > 0 ? event.data.cost : null,
          kind: "harness-estimated",
          scope: `auxiliary ${event.data.source}`,
          model: null,
          source: "session.usage.recorded",
          version: OPENCODE_VERSION,
        });
        last = incomplete(request.model, bad, accounting());
        sink.report(`aux:${event.id}`, { ...last, raw: json(event.data) });
      } else if (event.type === "session.retry.scheduled") {
        bad = "Native retry scheduled despite no-retry policy";
        streamAbort.abort(new Error(bad));
      } else if (event.type === "session.execution.succeeded") succeeded = true;
      else if (event.type === "session.execution.failed")
        bad = `${event.type}: ${clip(event.data.error.message, 2048)}`;
      else if (event.type === "session.execution.interrupted") bad = event.type;
      const type = event.type.includes("reasoning")
        ? "reasoning"
        : event.type.includes("text")
          ? "message"
          : event.type.includes("tool")
            ? "tool"
            : "lifecycle";
      sink.event({
        type,
        sourceId: event.id,
        data: boundedJson({ nativeType: event.type, ...event.data }),
        content: true,
      });
    };
    try {
      const signal = request.signal;
      await requirePolicy(client, request.cwd, signal);
      const catalog = await client.model.list(
        { location: { directory: request.cwd } },
        { signal },
      );
      if (
        !catalog.data.some(
          (m) => `${m.providerID}/${m.id}` === request.model && m.enabled,
        )
      )
        throw new Error(
          "Requested OpenCode model is absent or disabled; refusing prompt dispatch",
        );
      if (!sessionID) {
        const slash = request.model.indexOf("/");
        const session = await client.session.create(
          {
            title: "ASF owned session",
            agent: "asf",
            model: {
              providerID: request.model.slice(0, slash),
              id: request.model.slice(slash + 1),
            },
            location: { directory: request.cwd },
          },
          { signal },
        );
        sessionID = session.id;
        baseline = { seq: 0, tokens: zeroTokens(), serverKey, nativeCost: 0 };
      } else {
        const before = await client.session.get({ sessionID }, { signal });
        if (
          canonical(openCodeTokens(before.tokens)) !==
          canonical(baseline.tokens)
        )
          throw new Error("Session aggregate changed outside ASF baseline");
      }
      const sid = sessionID;
      let readyResolve!: () => void;
      let readyReject!: (e: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      stream = (async () => {
        try {
          for await (const event of client.event.subscribe({
            signal: AbortSignal.any([signal, streamAbort.signal]),
          })) {
            if (event.type === "server.connected") readyResolve();
            else consume(event);
          }
          if (!streamAbort.signal.aborted)
            throw new Error("Native log disconnected");
        } catch (e) {
          readyReject(e);
          if (!streamAbort.signal.aborted) {
            bad = errorText(e);
            streamAbort.abort(e);
          }
        }
      })();
      await ready;
      // No HTTP or native error retries. Reservation has already committed in ASF.
      await client.session.prompt(
        { sessionID: sid, text: request.prompt },
        { signal },
      );
      await client.session.wait(
        { sessionID: sid },
        { signal: AbortSignal.any([signal, streamAbort.signal]) },
      );
      // The beta CLI does NOT persist log events, even in follow mode.
      // Mandatory observations come from event.subscribe, never session.log(follow).
      // A non-follow read supplies a commit watermark, not reliable replay data.
      let watermark = seq;
      for await (const event of client.session.log(
        { sessionID: sid, after: baseline.seq, follow: false },
        { signal },
      )) {
        if (event.type === "log.synced")
          watermark = Math.max(watermark, event.seq ?? 0);
        else consume(event);
      }
      const deadline = Date.now() + 5000;
      while (
        (seq < watermark || !succeeded) &&
        !bad &&
        !streamAbort.signal.aborted &&
        !signal.aborted &&
        Date.now() < deadline
      )
        await sleep(10);
      if (seq < watermark || !succeeded)
        throw new Error(
          bad ?? "Native live event gap; historical replay unavailable",
        );
      streamAbort.abort();
      await stream;
      const aggregate = await client.session.get(
        { sessionID: sid },
        { signal },
      );
      const total = openCodeTokens(aggregate.tokens);
      const unattributed =
        aggregate.cost -
        baseline.nativeCost -
        nativeStepCost -
        additional.reduce((sum, p) => sum + (p.usd ?? 0), 0);
      if (Number.isFinite(unattributed) && unattributed > 1e-9) {
        additional.push({
          usd: unattributed,
          kind: "harness-estimated",
          scope: "unattributed session aggregate residual (model unavailable)",
          model: null,
          source: "session.get.cost minus observed native step costs",
          version: OPENCODE_VERSION,
        });
        bad ??= "Unattributed native aggregate cost";
        last = incomplete(request.model, bad, accounting());
        sink.report("aggregate-residual", last);
      }
      if (canonical(delta(total, baseline.tokens)) !== canonical(sum))
        bad ??= "Aggregate differs from accounted main-session steps";
      const messages = await client.message.list(
        { sessionID: sid, order: "desc", limit: 100 },
        { signal },
      );
      const final = messages.data.find(
        (m) => m.type === "assistant" && models.has(m.id),
      );
      if (final?.type === "assistant") {
        const finalText = final.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        text = clip(finalText);
        truncated = Buffer.byteLength(finalText) > 64 * 1024;
      } else bad ??= "Final assistant message missing";
      if (!stepCount || !succeeded)
        bad ??= "No successful execution/step receipt";
      const result = bad ? incomplete(request.model, bad, last) : accounting();
      sink.report("terminal", result);
      return {
        status: bad ? "failed" : "succeeded",
        text,
        truncated,
        nativeId: sid,
        accounting: result,
        ...(bad
          ? { error: bad }
          : {
              session: {
                nativeId: sid,
                baseline: json({
                  seq,
                  tokens: total,
                  serverKey,
                  nativeCost: aggregate.cost,
                }),
              },
            }),
      };
    } catch (e) {
      bad = errorText(e);
      return {
        status: request.signal.aborted ? "cancelled" : "failed",
        text,
        truncated,
        ...(sessionID ? { nativeId: sessionID } : {}),
        accounting: incomplete(request.model, bad, last),
        error: bad,
      };
    } finally {
      streamAbort.abort();
      if (sessionID) {
        try {
          await client.session.interrupt(
            { sessionID, continue: false },
            { signal: AbortSignal.timeout(3000) },
          );
        } catch {
          /* closing owned server is final fallback */
        }
      }
      await server.close();
      await stream;
    }
  }
}
