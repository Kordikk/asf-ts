import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode-ai/client";
import { stopProcess } from "../process.js";
import { clip, sleep } from "../util.js";
export const OPENCODE_VERSION = "0.0.0-beta-19271";
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;
export interface PrivateServer {
  client: OpenCodeClient;
  close(): Promise<void>;
}
/** Explicit handoff only; never included in ASF identity, argv, or inline config. */
export interface PrivateApiKey {
  integrationID: string;
  key: string;
}
export interface ServerOptions {
  apiKey?: PrivateApiKey;
  directory: string;
  cwd: string;
  mode: "read-only" | "write";
  executable?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
export async function privateServer(
  options: ServerOptions,
): Promise<PrivateServer> {
  if (options.apiKey) validatePrivateApiKey(options.apiKey);
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  const config = {
    plugins: [
      fileURLToPath(new URL("../../scripts/opencode-policy/", import.meta.url)),
    ],
    compaction: { auto: false },
    share: "disabled",
    snapshots: false,
    formatter: false,
    lsp: false,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      ...[
        "read",
        "glob",
        "grep",
        "list",
        ...(options.mode === "write"
          ? ["edit", "write", "apply_patch", "bash"]
          : []),
      ].map((action) => ({ action, resource: "*", effect: "allow" })),
    ],
    agents: {
      title: { disabled: true },
      compaction: { disabled: true },
      asf: {
        mode: "primary",
        steps: 20,
        system:
          "Work only on the requested task. Do not delegate, use subagents, or start background jobs.",
      },
    },
  };
  const child = spawn(
    options.executable ?? "opencode2",
    ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...(options.env ?? process.env),
        OPENCODE_DB: resolve(directory, "native.db"),
        OPENCODE_CONFIG_DIR: resolve(directory, "config"),
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FILEWATCHER: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    },
  );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= stopProcess(child));
  const abort = (): void => {
    void close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    await close();
    throw new Error("Server startup cancelled");
  }
  try {
    const url = await ready(child);
    const client = OpenCode.make({
      baseUrl: url,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
    });
    const health = await client.health.get({
      signal: AbortSignal.timeout(5000),
    });
    if (health.version !== OPENCODE_VERSION)
      throw new Error(`OpenCode protocol mismatch: ${health.version}`);
    if (options.apiKey) {
      const signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(10_000),
      ]);
      await requirePolicy(client, options.cwd, signal);
      await provisionPrivateApiKey(client, options.apiKey, options.cwd, signal);
    }
    return {
      client,
      close: async () => {
        options.signal?.removeEventListener("abort", abort);
        await close();
      },
    };
  } catch (e) {
    options.signal?.removeEventListener("abort", abort);
    await close();
    throw e;
  }
}
export function validatePrivateApiKey(value: PrivateApiKey): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.integrationID) ||
    typeof value.key !== "string" ||
    !value.key ||
    value.key === "public" ||
    value.key !== value.key.trim() ||
    /[\r\n]/u.test(value.key) ||
    Buffer.byteLength(value.key) > 4096
  )
    throw new Error("Invalid explicit OpenCode private API-key configuration");
}

export async function provisionPrivateApiKey(
  client: OpenCodeClient,
  value: PrivateApiKey,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  validatePrivateApiKey(value);
  try {
    await client.integration.connect.key(
      {
        integrationID: value.integrationID,
        key: value.key,
        label: "ASF owned private server",
        location: { directory: cwd },
      },
      { signal },
    );
  } catch {
    // SDK/native authorization errors may contain request details. Never persist
    // or print them; the key belongs only in this owned native credential store.
    throw new Error(
      "OpenCode private API-key provisioning failed (details withheld)",
    );
  }
}

function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "",
      stderr = "";
    const timer = setTimeout(
      () => finish(new Error(`OpenCode startup timeout: ${stderr}`)),
      15000,
    );
    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timer);
      child.stdout?.off("data", data);
      if (error) reject(error);
      else resolve(url!);
    };
    const data = (b: Buffer): void => {
      buffer += b.toString();
      if (Buffer.byteLength(buffer) > 8192) {
        finish(new Error("Oversized server handshake"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as { url: string };
        const url = new URL(value.url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
          throw new Error("Non-local server handshake");
        child.stdout?.resume();
        finish(undefined, url.href);
      } catch {
        finish(
          new Error(`Invalid private server handshake: ${clip(buffer, 1000)}`),
        );
      }
    };
    child.stdout?.on("data", data);
    child.stderr?.on("data", (b: Buffer) => {
      stderr = clip(stderr + b.toString(), 4096);
    });
    child.once("error", (e) => finish(e));
    child.once("exit", () =>
      finish(new Error(`OpenCode exited during startup: ${stderr}`)),
    );
  });
}

export async function requirePolicy(
  client: OpenCodeClient,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    signal.throwIfAborted();
    const plugins = await client.plugin.list(
      { location: { directory: cwd } },
      { signal },
    );
    if (
      plugins.data.some(
        (p) => p.state.status === "active" && p.id === "asf-no-retry",
      )
    )
      return;
    const failed = plugins.data.find((p) => p.state.status === "failed");
    if (failed)
      throw new Error(
        `Policy initialization failed: ${JSON.stringify(failed)}`,
      );
    await sleep(100);
  }
  throw new Error(
    "Required no-retry policy plugin not active; refusing model dispatch",
  );
}
