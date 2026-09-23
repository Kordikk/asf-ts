import { spawn, type ChildProcess } from "node:child_process";
import { clip, positive, sleep } from "./util.js";
import type { CommandResult } from "./types.js";
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
export async function stopProcess(child: ChildProcess): Promise<void> {
  killGroup(child, "SIGTERM");
  await sleep(150);
  killGroup(child, "SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([
      new Promise<void>((r) => child.once("exit", () => r())),
      sleep(1000),
    ]);
}
export async function command(
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
  outputLimit = 64 * 1024,
): Promise<CommandResult> {
  positive(timeoutMs);
  positive(outputLimit, 1024 * 1024);
  if (
    !argv.length ||
    argv.some((v) => typeof v !== "string" || v.includes("\0"))
  )
    throw new Error("Invalid argv");
  signal.throwIfAborted();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer = Buffer.alloc(0),
    stderr: Buffer = Buffer.alloc(0),
    truncated = false,
    cancelled = false;
  const append = (old: Buffer, chunk: Buffer): Buffer => {
    if (old.length + chunk.length > outputLimit) truncated = true;
    return Buffer.concat([
      old,
      chunk.subarray(0, Math.max(0, outputLimit - old.length)),
    ]);
  };
  child.stdout.on("data", (b: Buffer) => {
    stdout = append(stdout, b);
  });
  child.stderr.on("data", (b: Buffer) => {
    stderr = append(stderr, b);
  });
  let stopping: Promise<void> | undefined;
  let executing = true;
  const abort = (): void => {
    if (!executing) return;
    cancelled = true;
    stopping ??= stopProcess(child);
  };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const finished = (): void => {
    executing = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  };
  try {
    // Wait for leader exit, not pipe close: descendants may hold the writers.
    const [code, exitSignal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve, reject) => {
      child.once("error", (e) => {
        finished();
        reject(e);
      });
      child.once("exit", (c, s) => {
        finished();
        resolve([c, s]);
      });
    });
    await (stopping ??= stopProcess(child));
    return {
      code,
      signal: exitSignal,
      stdout: clip(stdout.toString(), outputLimit),
      stderr: clip(stderr.toString(), outputLimit),
      truncated,
      cancelled,
    };
  } finally {
    finished();
    await (stopping ??= stopProcess(child));
  }
}
