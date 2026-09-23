#!/usr/bin/env node
// Transport/lifecycle shim only. The official SDK remains the sole JSONL parser.
import { spawn } from "node:child_process";
const child = spawn(
  process.env.ASF_CODEX_EXECUTABLE || "codex",
  process.argv.slice(2),
  {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  },
);
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.stdout.pipe(process.stdout);
let stderrBytes = 0;
child.stderr.on("data", (b) => {
  const room = Math.max(0, 65536 - stderrBytes);
  if (room) process.stderr.write(b.subarray(0, room));
  stderrBytes += b.length;
});
function kill(signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    /* exited */
  }
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  kill("SIGTERM");
  setTimeout(() => {
    kill("SIGKILL");
    process.exit(143);
  }, 200);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", (e) => {
  process.stderr.write(String(e));
  process.exitCode = 1;
});
child.on("exit", (code) => {
  if (stopping) return;
  kill("SIGTERM");
  setTimeout(() => {
    kill("SIGKILL");
    process.exit(code ?? 1);
  }, 150);
});

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) stop();
}, 250).unref();
