import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexHarness, type CodexPort } from "../src/adapters/codex.js";
import { command } from "../src/process.js";
import { fixture, pricing } from "./helpers.js";
import { sleep } from "../src/util.js";

test("Codex forwards active cancellation but detaches the SDK signal after invocation", async () => {
  let sdkSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client: CodexPort = {
    resumeThread() {
      throw new Error("Unexpected synthetic resume");
    },
    startThread() {
      return {
        async runStreamed(
          _prompt: string,
          { signal }: { signal: AbortSignal },
        ) {
          sdkSignal = signal;
          return {
            events: (async function* () {
              started();
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
              throw new Error("synthetic cancellation");
            })(),
          };
        },
      };
    },
  };
  const harness = new CodexHarness({
    pricing,
    client,
    checkVersion: async () => {},
  });
  const controller = new AbortController();
  const pending = harness.invoke(
    {
      model: "test-model",
      prompt: "synthetic",
      cwd: process.cwd(),
      mode: "read-only",
      signal: controller.signal,
    },
    { event() {}, report() {} },
  );
  await ready;
  assert.ok(sdkSignal);
  assert.notEqual(sdkSignal, controller.signal);
  controller.abort(new Error("operator cancelled"));
  const receipt = await pending;
  assert.equal(sdkSignal.aborted, true);
  assert.equal(sdkSignal.reason, controller.signal.reason);
  assert.equal(receipt.status, "cancelled");

  let completedSignal: AbortSignal | undefined;
  const doneClient: CodexPort = {
    resumeThread() {
      throw new Error("Unexpected synthetic resume");
    },
    startThread() {
      return {
        async runStreamed(
          _prompt: string,
          { signal }: { signal: AbortSignal },
        ) {
          completedSignal = signal;
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "synthetic-native" };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 10,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          };
        },
      };
    },
  };
  const done = new CodexHarness({
    pricing,
    client: doneClient,
    checkVersion: async () => {},
  });
  const outer = new AbortController();
  const result = await done.invoke(
    {
      model: "test-model",
      prompt: "synthetic",
      cwd: process.cwd(),
      mode: "read-only",
      signal: outer.signal,
    },
    { event() {}, report() {} },
  );
  assert.equal(result.status, "succeeded");
  outer.abort();
  assert.equal(
    completedSignal?.aborted,
    false,
    "a later workflow abort cannot reach a disposed SDK child",
  );
});

test("real Codex SDK: report-sink failure retains accounting without a late unhandled AbortError", async () => {
  const f = fixture();
  let nativePid: number | undefined;
  try {
    const executable = join(f.dir, "synthetic-codex");
    const pidfile = join(f.dir, "native.pid");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0)}
fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));
process.on('SIGTERM',()=>{});
process.stdin.resume();process.stdin.on('end',()=>{
 for(const e of [{type:'thread.started',thread_id:'synthetic-thread'}, {type:'item.completed',item:{type:'agent_message',id:'message',text:'synthetic result'}}, {type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:4,reasoning_output_tokens:1}}]) console.log(JSON.stringify(e));
});
setInterval(()=>{},100);
`,
    );
    chmodSync(executable, 0o755);
    const urls = {
      runtime: new URL("../src/runtime.ts", import.meta.url).href,
      store: new URL("../src/store.ts", import.meta.url).href,
      codex: new URL("../src/adapters/codex.ts", import.meta.url).href,
    };
    const script = `
import assert from 'node:assert/strict';
import {Runtime} from ${JSON.stringify(urls.runtime)};
import {Store} from ${JSON.stringify(urls.store)};
import {CodexHarness} from ${JSON.stringify(urls.codex)};
const store=new Store(${JSON.stringify(f.store.path)});
const base=new CodexHarness({pricing:${JSON.stringify(pricing)},executable:${JSON.stringify(executable)}});
const h={name:base.name,live:true,identity:{base:base.identity,syntheticRefusal:1},preflight:q=>base.preflight(q),invoke:(q,s)=>base.invoke(q,{event:e=>s.event(e),report:(id,a)=>{s.report(id,{...a,status:'incomplete',reason:'synthetic report refusal'});throw new Error('synthetic report refusal');}})};
try {
 await assert.rejects(new Runtime({store,runId:'run',workflowIdentity:'synthetic',cwd:${JSON.stringify(f.dir)},live:true,budget:{id:'synthetic',maxDispatches:1,softUsd:1}}).run(r=>r.agent('a',{harness:h,model:'test-model'},{prompt:'synthetic no-model transport fixture'})),/Incomplete accounting/);
 const i=store.inspect('run');
 assert.equal(i.totals.modelDispatches,1);assert.equal(i.totals.unresolved,1);assert.ok(i.totals.knownUsd>0);assert.equal(i.reports.length,1);
 console.log('synthetic accounting retained');
} finally {store.close();}
await new Promise(resolve=>setTimeout(resolve,600));
`;
    const result = await command(
      [
        process.execPath,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
      ],
      fileURLToPath(new URL("..", import.meta.url)),
      AbortSignal.timeout(10_000),
      10_000,
    );
    if (existsSync(pidfile)) {
      const pid = Number(readFileSync(pidfile, "utf8"));
      nativePid = pid;
      assert.equal(result.code, 0, result.stderr);
      const alive = () => {
        try {
          return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2000;
      while (alive() && Date.now() < deadline) await sleep(10);
      assert.equal(
        alive(),
        false,
        "owned synthetic native process survived cleanup",
      );
      nativePid = undefined;
    }
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.cancelled, false);
    assert.match(result.stdout, /synthetic accounting retained/);
    assert.ok(!result.stderr.includes("AbortError"), result.stderr);
  } finally {
    // A failing negative control must not leave its synthetic process behind.
    if (nativePid) {
      try {
        process.kill(nativePid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    f.close();
  }
});
