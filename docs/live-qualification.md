# Separately authorized live qualification

**Never run in CI.** `--help` is safe; other runner use requires `--live`. Acknowledgement is not authorization to exceed an approved allowance. See [verification results](verification.md) for completed Codex and authenticated OpenCode Go qualification, including the preserved earlier free-route denial. The original **20-reservation allowance is now exhausted**, including the separately approved mixed-provider checks. Do not run these examples without a new explicit allowance/accounting review.

## Configuration and exact commands

The supported pins changed on 2026-09-30; see [offline upgrade qualification](sdk-upgrade-20260930.md). Existing live evidence and allowances are historical, not validation or authorization for the new versions. Do not resume old live actions/sessions with new adapter identities. The later failed coder allowance remains unresolved and authorizes no more sends.

Copy `examples/agents.template.json` to an untracked file under `.asf/`. Fill in:

- `codex.model`: an explicitly approved available Codex **OpenAI** model ID; `pricing.model` must match exactly. No automatic/default model.
- `opencode.model`: an explicitly approved available `provider/model` ID from the exact beta; same exact rate key. The private server checks that it is enabled before prompting.
- All four numeric rates: USD per million **uncached input**, **cache read**, **cache write**, and **inclusive output**. Zero is allowed only when explicitly supported by the chosen price source, not as a placeholder for unknown.
- Nonempty pricing `source` (rate-card/document reference) and `version` (effective date/revision). Verify rates/tiers independently; there is no maintained default price table. Null placeholders fail before model dispatch.
- Optional absolute `executable`, instructions, timeout. Credentials must be available to the owned server; an ordinary native OpenCode login is not automatically shared (see below). The JSON-config CLI never changes global auth.

For a newly authorized qualification allowance, after choosing permitted models/rates:

```sh
npm run qualify -- --live --config .asf/qualification-agents.json \
  --agent codex --run qualify-codex-1 \
  --db .asf/qualification.db --budget parent-qualification-v1 \
  --max-dispatches 20 --soft-usd 10

# Only after inspecting the first run, and within the SAME remaining allowance:
npm run qualify -- --live --config .asf/qualification-agents.json \
  --agent opencode --run qualify-opencode-1 \
  --db .asf/qualification.db --budget parent-qualification-v1 \
  --max-dispatches 20 --soft-usd 10

npm run asf -- inspect --db .asf/qualification.db --run qualify-codex-1
npm run asf -- events --db .asf/qualification.db --run qualify-opencode-1 --follow
npm run asf -- serve --db .asf/qualification.db --port 8080
```

**Both runs and any subsequent probes must share the same database and budget ID.** Run them serially. Limits are immutable once the budget exists; the runner will not accept more than 20 dispatches/$10. If other ASF-dispatched tasks have already used part of the approved allowance outside this database, do not run these commands as if the full allowance remained: establish the remaining allowance first. A fresh DB or changed budget ID is not an allowance reset. The 2026-09-19 verification retained a proven local pre-send configuration failure, counted its reservation, and explicitly reduced the remaining segment to 19; the ledger was not edited. The later OpenCode provider denial remains incomplete. On 2026-09-22, separately approved, capped Go segments in that same database retained every old row and used six further reservations (including one successful read followed by a verifier stop); five fresh turns then passed. Those Go segments are now closed. A new segment always requires an explicit aggregate allowance/accounting audit and permission, never a silent budget reset.

## OpenCode credentials in an owned server

This beta stores native credentials in its SQLite database. ASF deliberately selects a fresh private native DB and private config for each initial session, so ordinary OpenCode logins and project/global provider config are not imported. With no explicitly supplied credential, Zen can expose only its public/free routes; their availability is not evidence that SDK access is permitted.

A trusted programmatic caller can opt into `new OpenCodeHarness({ pricing, directory, apiKey: { integrationID: "opencode-go", key } })`, where `key` comes from a **separately authorized** secret source. ASF validates the matching provider before reservation, then provisions the key through the pinned official client's `integration.connect.key` endpoint before model readiness. Continuations reuse the credential in their owned native DB. The key is not placed in ASF identity, CLI arguments or inline config; credential-handoff errors withhold native request details. It is retained by native credential storage, so keep the native directory private and out of commits. ASF never automatically reads another application's credentials, and this is not a general redaction guarantee or an OS sandbox.

The JSON agent file has no literal-key field. Programmatic qualification can call the same ordinary `qualificationWorkflow(runtime, agent)` function from `scripts/qualification-workflow.ts`, inside a separately budgeted `Runtime`. The original CLI uses that function too. Do not bypass the allowance audit by creating an unreviewed budget or database. Inherited provider environment variables are also recognized by native OpenCode, but can reach shell tools; prefer a key held in the caller's memory and an isolated/allowlisted environment for sensitive verification. Do not point ASF at a global native credential/session DB.

## Mixed-provider workflow

`scripts/mixed-qualification-workflow.ts` is another ordinary async function, not a new scheduler. It accepts reusable `{codex, opencode}` agent configs. Two scoped read-only actions run with `Promise.all`, reading separate synthetic JSON fixtures. A third action continues only the Codex session and receives both typed results as explicit JSON context. There are no automatic format corrections, fallback models or ASF retries. Failure cancels/drains any already-reserved sibling; concurrency can therefore still incur both initial charges.

The authorized `gpt-6-astra` + `opencode-go/glm-5.2` live check passed three actions and account-free replay. The exact beta did not expose the publicly listed GLM-5.3-Flash, so the operator obtained explicit approval for GLM-5.2 **before** prompts. Its private runner separately audited the original allowance, protected every old row, checked actual tool calls/fixture bytes before combination, and preserved the earlier stopped attempt. See [verification](verification.md) and [bounded evidence](evidence/qualification-mixed-20260922.json); these are historical results, not reusable live authorization.

For Astra, [the model rate card](https://developers.openai.com/api/docs/models/gpt-6-astra) changes pricing above **272K input tokens per request**. The corrected check conservatively bounds cumulative input (including cache reads/writes) per ASF invocation at 200K, which also bounds each constituent request. An arbitrary 20K cumulative guard was too restrictive for the native tool/system context and stopped the first mixed attempt. Neither that incomplete receipt nor its estimate was retroactively rewritten. Go GLM has no separately priced cache-write category in the public table and a zero native catalog rate; qualification rejects any positive reported cache-write quantity rather than treating it as free.

## What it exercises

The runner creates a disposable workdir at `.asf/qualification/RUN/work`, a known text fixture, and bounded ASF evidence in the shared DB. It performs read-with-tool, native continuation recalling the marker, write-with-tool plus argv command verification, then a typed format-correction fixture. That fixture deliberately changes only its initial native prompt to request literal `NOT_JSON`; it does **not** forge the returned text or usage. The next turn requests schema-correct JSON in the same session. Its distinct wrapper policy is part of the durable adapter identity. Normally five model dispatches are reserved per adapter (at most five in the runner workflow); ASF does not retry native errors. Codex request/stream retries remain vendor-controlled; the adapter does not suppress them. Each action/correction reservation consumes its count **before** send. A failed pre-send setup may conservatively consume a reserved slot too.

Each SDK action has a two-minute timeout; the runner has a twelve-minute abort bound plus bounded cleanup grace. The hard dispatch count is ASF turns, **not** inference steps/tool loops/hidden title/compaction/vendor requests. The $10 threshold is a soft gate on already-recorded estimates, not a maximum bill. In-flight work and provider omissions can overshoot. Missing accounting halts later paid dispatches, rather than spending again to obtain usage.

## Retained evidence and acceptance

On success, `summary.json` is written alongside the workdir; the database remains authoritative even on failure. `inspect` includes receipts, model/protocol/rate provenance, known amounts, classification and unresolved counts. `events` includes bounded opt-in sensitive tool/message/reasoning observations and mandatory usage. Inspect tool events to confirm actual tool use; a marker match alone does not prove tool use. For this exact OpenCode beta, a local `session.tool.success` has `executed:false`: the flag means provider-hosted execution, not whether the local tool ran. Correlate its call ID with the tool name/input and use the source-checked `isOpenCodeLocalToolSuccess` predicate in `scripts/qualification-evidence.ts`. Verify the format action has two invocation rows, same native session, and a valid final object. If it did not correct, do not claim correction qualified. Replay the same run only with identical config/code; completed actions must consume no new dispatches.

ASF raw outputs/events/reports are bounded per action and dispatch. Native session storage is vendor-managed and not subject to the same retention cap; keep it private and inspect only this runner's owned sessions with authorization. Do not copy private native history into evidence. There are no redaction guarantees.

Stop on any uncertain send, incomplete ledger, unobserved/rerouted model, auxiliary accounting gap, failed OpenCode no-retry policy, or unexpected writes. Preserve the DB/WAL and known reports. Do not silently reset the budget, auto-retry, or inspect unrelated user sessions. Further remediation/qualification needs parent review and explicit remaining allowance.
