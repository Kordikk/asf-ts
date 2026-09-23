# Verification and remaining qualification

Historical checks: 2026-09-19; follow-ups: 2026-09-22. Local environment: Node 22.22.3, Linux. Only Codex and OpenCode were used for live harness testing. The Python reference checkout was not modified.

**Current status:** the authorized Go route and a mixed Codex GPT + OpenCode GLM workflow passed bounded live checks and no-dispatch replay on 2026-09-22 (below). The original 20-reservation allowance is exhausted. The earlier free-route denial and its unresolved accounting remain historical evidence, not erased liabilities.

## Offline checks

`npm run check` covers strict typechecking, lint, formatting, deterministic tests, and the compiled library/CLI. Tests include both adapters' shared contract, accounting scopes/deduplication, correction, native continuation, crash/uncertain-send recovery, replay, concurrent actions/sessions, subprocess-group termination, bounded capture, and SSE paging/reconnect/backpressure. No provider credentials or model calls are required.

Additional opt-in **no-model** tests use the installed executables:

```sh
ASF_TEST_CODEX="$(command -v codex)" npx tsx --test test/codex-config.test.ts
ASF_TEST_OPENCODE="$(command -v opencode2)" npx tsx --test test/opencode-lifecycle.test.ts
```

These validate the actual Codex SDK config flags and the exact OpenCode version preflight, official client, private server, policy readiness, public event delivery, log watermark behavior and process cleanup. They use isolated temporary configuration/state. CI runs only the offline suite; its workflow is under `.gitea/workflows/`.

## Post-review offline fixes

After the live checks, Codex textual reroute notices were made fail-closed independently of disabled/exhausted content tracing. Offline regressions retain the notice, reported tokens and incomplete requested-rate known subtotal, and verify that neither structured correction nor a subsequent paid action dispatches. HTTP URL parsing now stays inside the request error boundary; a raw-socket malformed-URL regression verifies a 400 response followed by successful inspection. `npm run check` passed after these fixes. No post-fix live reruns occurred; the historical evidence file and native qualification claims below are unchanged.

## Live Codex: passed for the tested scope

`codex-cli 0.154.0`, official SDK 0.154.0, model `gpt-6-astra`:

1. A native tool read a synthetic fixture; the final response matched its marker.
2. A separate ASF action continued the same native session and recalled the marker.
3. A fresh write-mode session used tools to write the fixture contents. A host command checked exact bytes.
4. A qualification wrapper asked the model for literal `NOT_JSON`; the actual unmodified response failed the local schema.
5. The correction turn in that same session returned valid `{"ok":true}`.

All five model turns produced positive reported usage and complete **declared-scope estimates**. Tool/message events were persisted before terminal receipts. Replaying the completed workflow reused all five actions and created **zero** new dispatches or ledger entries.

Recorded estimated model cost: **$0.196624** using the OpenAI standard short-context list rates retrieved on the test date. This is a requested-model API-rate estimate, not the subscription bill or proof of complete hidden vendor usage. Cancellation/provider-failure handling was verified offline, not by cancelling an additional billable Codex turn.

## 2026-09-19 OpenCode free route: blocked (historical)

The exact `opencode2` / official HTTP-client beta `0.0.0-beta-18684` passed the no-model lifecycle tests. Its enabled model catalog contained only free-tier routes. A synthetic `opencode/big-pickle` request reached the provider, which returned `provider.auth`, HTTP 403:

> OpenCode's free tier can only be used from within OpenCode

The failure and incomplete accounting were retained, owned processes were cleaned up, and further live dispatches stopped. No client-identity spoofing, restriction bypass, credential transfer, or automatic model fallback was attempted. **At that stage, successful OpenCode tool, continuation, correction and cost coverage were not live-qualified.** A separately permitted provider/model route and explicit provisioning into the owned private server were needed.

The generic terminal error initially obscured the provider message when content tracing was off. The adapter now retains its bounded message in the mandatory receipt, with an offline denial regression test.

## Startup findings and allowance audit

The approved initial allowance was 20 ASF dispatch reservations and a $10 estimated-spend soft threshold. Seven reservations were consumed:

- 1 Codex local configuration failure, before model dispatch;
- 5 successful Codex model turns;
- 1 OpenCode provider-auth denial.

The first Codex attempt exposed an unsupported override of the built-in `openai` provider. It was removed; a real no-model initialization regression test reproduces the original failure as a negative control. Source inspection places that config validation before model dispatch. The original incomplete ledger entry remains immutable. For continuing the qualification, an explicit operator audit counted its reservation and limited a second segment in the **same database** to the remaining 19 reservations, without granting another allowance or modifying any receipt. The conservative aggregate known subtotal remains $0.196624 with **two incomplete ledger records**; those are not silently converted to zero by ASF.

An OpenCode executable-version prefix mismatch was also caught and fixed before a model reservation; the real preflight now has no-model coverage. Its failed action was preserved rather than silently retried.

Thirteen reservation slots remain numerically unused, but **testing is stopped**, not authorized to evade the unresolved-accounting gate. The OpenCode route/allowance must be reviewed before any further live work.

## Evidence

[Sanitized machine-readable report](evidence/qualification-20260919.json) contains per-turn usage/rate provenance, synthetic outputs, hashed native-session correlation, event-before-receipt counts, the allowance audit, and post-qualification source hashes. It was captured before independent review and after local diagnostic fixes; it is not an assertion that every source file was frozen at dispatch. Later fixes must retain this provenance rather than relabel old runs as newly tested.

The authoritative private database remains at `.asf/qualification.db` with owned native state and synthetic workdirs under `.asf/qualification/`; these are ignored, not published. No credentials or unrelated native session history are included in committed evidence.

Rates: [OpenAI](https://developers.openai.com/api/docs/pricing), [OpenCode Zen](https://opencode.ai/docs/zen/#pricing). OpenCode's free rates were explicitly identified, but no usable inference usage arrived; its failed record remains unknown, not a successful $0 estimate.

## 2026-09-22 MR follow-up — offline

All six reproduced review defects received regression coverage: post-reservation setup failures become uncertain; incomplete reports remain unresolved through terminal reconciliation; OpenCode retains cost-only failed-step estimates without aggregate double-counting; adapters snapshot caller pricing/options; missing new native baselines fail after receipt/accounting persistence; and long UTF-8 report keys deduplicate without clipping collisions. Read-only inspection also flags contradictory historical evidence without rewriting immutable ledgers.

The existing execution-map UI changes were verified together with these fixes. `npm ci --ignore-scripts` and `npm run check` passed on Node 22.22.3: **67 passed, 0 failed, 2 explicitly opt-in tests skipped**, plus typecheck, lint, formatting and build. Separately, both installed-CLI no-model paths were enabled and passed (3 tests, no skips), with `codex-cli 0.154.0` and `opencode2 v0.0.0-beta-18684`. The expanded Chromium regression passed scope/session mapping, keyboard/card/turn selection, polling focus, mobile layout, asset parity, bounded inspection and literal rendering. `npm audit --omit=dev` reported no vulnerabilities. ESLint now excludes ignored `.asf/` artifacts, like the formatter, rather than linting private research copies or reproductions.

A delegated post-fix review was interrupted by a provider connection failure before a final verdict; local second-pass review and the checks above completed, but independent post-fix acceptance is not claimed. No new live model qualification was run, no outstanding liability was reset, and the historical live evidence above is unchanged. At that point OpenCode still required a permitted provider/model route and an explicit allowance/accounting review. Expanded adapter identity fields can reject pre-fix action/session bindings on resume; retained records remain inspectable, with no automatic migration or resend.

## 2026-09-22 OpenCode Go: passed for the tested scope

With separate user approval, a narrowly scoped helper read the configured Go API-key entry and handed it to **new ASF-owned private native databases** through the pinned official `integration.connect.key` endpoint. The model was explicitly `opencode-go/gpt-5.6-luna`; metadata first confirmed that it was enabled and tool-capable. Global auth was not modified, credentials were not sent in prompts/argv/inline config, and the qualification used an allowlisted per-process environment. No global native DB or unrelated native session was imported. Native directories retain the credential and remain sensitive/ignored.

The first Go read action succeeded with a local `glob` and `read`, positive usage, and **$0.0005416 estimated**. Its qualification observer then stopped before dispatch two: it incorrectly treated `Tool.Success.executed` as a general execution flag. The pinned publisher source proves it means **providerExecuted**; successful local tools correctly emit `false`. A source-linked regression now covers that distinction. The first run/source/receipt were retained unchanged. After explicit user confirmation of five **additional** reservations, a fresh source-bound run was used rather than bypassing identity validation or resending the old prompt in its old session.

`qualify-opencode-go-20260922-v2` passed:

1. Real local tools read the synthetic marker; final text matched.
2. A second action continued the same native session and recalled it.
3. A fresh write-mode session wrote `result.txt`; a local command verified exact fixture bytes and the workdir contained only the expected files.
4. The format fixture retained the native `NOT_JSON` response before validation; one same-native-session correction returned `{"ok":true}`.
5. Five ASF model dispatches (ten observed native inference steps), plus one non-model command, had complete **declared-scope** accounting with no new unresolved records or auxiliary estimates. No native retry event was observed; this was not an extra live failure/cancellation experiment.
6. Account-free replay did not load a credential or dispatch a model. Paid reservations remained 15 overall, and hashes of every invocation, report, ledger and session row were unchanged.

Successful-run estimate: **$0.00216455**. Both Go runs together: **6 paid ASF reservations, $0.00270615 estimated**. The independently retrieved [Go rate card](https://opencode.ai/docs/go/#usage-limits) used USD/1M tokens of input **0.20**, cache read **0.02**, cache write **0.25**, inclusive output **1.20** for the published <=272K tier, with a conservative 200K observed-input ceiling. The older bundled native catalog has different rates; its cost is reconciliation evidence, not a second amount added to ASF's explicit estimate. These are Go usage-rate estimates, **not subscription invoices** or proof of invisible vendor-work completeness.

The allowance audit began with 9 paid reservations/$1.184426 known and ended at **15 paid reservations/$1.18713215 known**, with the **same two old unresolved records**. Every pre-existing qualification row was hash-checked across the new runs. Both separately authorized Go segments are now closed; numerically unused original slots are not permission for more live tasks.

`npm run check` passed: **72 passed, 0 failed, 2 explicit opt-in skips**, plus typecheck/lint/format/build. The installed-CLI no-model test additionally passed synthetic-key provisioning, private credential persistence across restart, absence from argv/environment, policy readiness and cleanup. An independent static review accepted the credential handoff before live work; the later observer correction was source-checked and regression-tested.

[Bounded machine-readable Go evidence](evidence/qualification-opencode-go-20260922.json) records the exact versions/model, per-turn usage, native-session correlations, source hashes, replay and allowance audit. Private operator scripts, original logs and the authoritative DB remain under `.asf/`. Historical evidence above is not relabelled as this newer qualification.

## 2026-09-22 mixed Codex GPT + OpenCode GLM: passed

`mixed-codex-glm-20260922-v2` ran **one workflow** using Codex `gpt-6-astra` and OpenCode Go `glm-5.2` through their pinned official adapters. The public Go catalog included GLM-5.3-Flash, but the exact native beta did not expose it. Metadata-only inspection found GLM-5.2 enabled with tools, and the user explicitly approved that model change before any prompt.

The [shared workflow](../scripts/mixed-qualification-workflow.ts) uses ordinary reusable agents and `Promise.all`:

- `codex/read` used a native read-only command to read `left.json`: **49**.
- `opencode/read` used the native `read` tool on `right.json`: **39**.
- `codex/combine` received both typed JSON values explicitly, continued only its own Codex native session, and returned **88**.

Both initial reservations preceded either terminal receipt, proving overlapping ASF dispatch lifetimes—not simultaneous vendor computation or inferred event causality. Native tool calls and fixture bytes were checked before the combine reservation. All three successful-run ledger entries have complete **declared-scope estimates**, with no new unresolved records. Codex attribution remains requested-model; OpenCode GLM attribution is observed. No format correction, model fallback or ASF retry occurred.

| Action             |  Estimated USD |
| ------------------ | -------------: |
| Codex read         |       0.054818 |
| GLM read           |     0.00213668 |
| Codex combine      |       0.045998 |
| **Successful run** | **0.10295268** |

Account-free replay loaded no Go credential and added no dispatch. Every invocation, report, ledger and session row remained byte-for-byte equivalent under the before/after hashes; paid reservations stayed at 20.

### Retained first attempt and offline remediation

The first mixed attempt completed both model reads correctly, but the operator runner's overly restrictive **20K cumulative-input guard** rejected Codex's 24,840 reported input tokens, including 21,888 cache reads, before combination. It retained **$0.05681412** in known estimates and one newly incomplete record. This was a qualification guard failure, not evidence that the two providers could not operate together. It was never retried or relabelled complete.

That failure also exposed the exact Codex SDK's late-abort listener-disposal issue. After separate user approval, an offline real-SDK/synthetic-executable test reproduced the unhandled `AbortError`; an invocation-owned signal now forwards active cancellation and detaches after iterator disposal. The regression verifies known accounting survives and owned native cleanup completes. The revised runner uses a **200K cumulative-input ceiling**, below Astra's source-checked **272K per-request** pricing threshold. A separately authorized fresh three-dispatch run used new native sessions rather than bypassing the old run's identity or accounting gate.

Both mixed attempts used **5 paid reservations/$0.15976680 known estimates**. Overall qualification accounting is now **20 paid reservations/$1.34689895 known, with 3 unresolved records**: the original two plus the unchanged first mixed Codex record. All pre-existing rows were hash-verified unchanged. Every mixed segment is closed and the original hard reservation allowance is exhausted. No invoice or hidden vendor-cost completeness is claimed.

`npm run check` passed **76 tests, 0 failures, 2 explicit opt-in skips**, plus typecheck/lint/format/build. The mixed synthetic tests cover overlapping calls, provider-separated accounting, explicit JSON handoff, same-Codex-session continuation, marker-mismatch stop and account-free replay. The initial plan had independent static review; the later signal-lifetime fix has local second-pass inspection and the before/after offline transport regression, not a new independent review claim. A scoped credential-containment check found the approved Go key absent from project files, operator logs and both mixed runs' ASF records; owned native credential roots remain private. This is not a general redaction guarantee.

[Machine-readable mixed evidence](evidence/qualification-mixed-20260922.json) includes both attempts, scoped per-turn estimates, synthetic outputs, native-session correlations, source hashes, replay and allowance provenance. Raw private records/operator scripts remain under `.asf/`.
