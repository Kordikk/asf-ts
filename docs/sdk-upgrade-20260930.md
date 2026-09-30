# Offline SDK upgrade — 2026-09-30

## Supported pins and installation

- `@openai/codex-sdk@0.159.2`, with exact transitive `@openai/codex@0.159.2`; expected `codex-cli 0.159.2`.
- `@opencode-ai/client@0.0.0-beta-19271`, with matching protocol/schema packages; expected `opencode2 v0.0.0-beta-19271` from **`@opencode-ai/cli@0.0.0-beta-19271`**. Its platform optional packages carry the same version. The client's `latest` tag (`0.0.0`) is a placeholder; the timestamped `opencode-ai` beta is a different release line. No stable 1.x or embedded-SDK migration was performed.
- Ajv and development-tool pins are unchanged. The unrelated transitive fast-check version was retained.

Use Node 22.22.3 / npm 10.9.8 and `npm ci --ignore-scripts`. Codex is available at `node_modules/.bin/codex`; npm scripts include that directory in PATH. Programmatic callers outside npm scripts should supply its absolute path as `executable` rather than rely on a global CLI.

OpenCode is not a runtime dependency/executable installed by ASF. Install the exact native package in a project-local tools prefix, never globally or into a global service. For an ignored tools installation:

```sh
npm install --prefix .asf/sdk-upgrade/tools --save-exact --ignore-scripts \
  @opencode-ai/cli@0.0.0-beta-19271
```

With install scripts disabled, the CLI wrapper is intentionally inert. On Linux x64 with AVX2/glibc, supply the absolute path to `.asf/sdk-upgrade/tools/node_modules/@opencode-ai/cli-linux-x64/bin/opencode2` as the adapter's `executable`; other platforms must select the matching platform/baseline/musl package. Do not silently use a different version if unavailable. This upgrade's native test used the exact Linux-x64 npm tarball extracted under ignored `.asf/sdk-upgrade/`, without executing postinstall.

## Exact protocol source basis

Public package tarballs, declarations, implementation comparisons and metadata were inspected under ignored `.asf/sdk-upgrade/`; no credentials, existing native sessions or qualification ledgers were read.

**Codex:** [official rust-v0.159.2 release](https://github.com/openai/codex/releases/tag/rust-v0.159.2) and source at that tag:

- `sdk/typescript` / npm `dist/index.{js,d.ts}`: the published SDK implementation/declarations are byte-identical to 0.154.0. Exec argv remains `exec --experimental-json`, dotted TOML overrides, model/sandbox/cwd flags and `resume <thread-id>`. Final text remains `agent_message`; the SDK forwards AbortSignal and still removes child listeners during disposal. Invocation-owned cancellation and the lifecycle shim remain necessary.
- `codex-rs/exec/src/event_processor_with_jsonl_output.rs`, `exec_events.rs`: terminal usage comes from `ThreadTokenUsage.total`, **not per-turn usage**, despite the SDK comment. Final messages and failed/interrupted turn behavior remain compatible. `ModelRerouted` becomes an error item beginning `model rerouted:`; `ModelVerification` is not surfaced as structured actual-model attribution. Requested-model estimates and fail-closed reroute handling are unchanged.
- `codex-rs/codex-api/src/sse/responses.rs`, `protocol/src/protocol.rs`: input/cache categories and inclusive output/separate reasoning retain their convention and cumulative addition. ASF still differences each category against its owned baseline and never charges reasoning twice.
- `codex-rs/config/src/config_toml.rs`: built-in OpenAI provider override rejection remains. Request/stream retries remain vendor-controlled; ASF does not add retries or fallback.

**OpenCode:** [official beta-19271 release](https://github.com/anomalyco/opencode-beta/releases/tag/v0.0.0-beta-19271), [successful publishing run 19271](https://github.com/anomalyco/opencode/actions/runs/34161100416), and exact npm `@opencode-ai/{client,protocol,schema,core,server,plugin,cli,cli-linux-x64}@0.0.0-beta-19271` artifacts. The run identifies upstream head `013ded3743eb9c198d8f544afdfd60fdad1e68a4`; its upstream raw/archive endpoints were unavailable during this check. The release repository's source archive contains only a README, so neither it nor the historical beta-18684 commit is claimed as current implementation proof. Exact published npm implementations are the protocol evidence; installed native metadata tests independently validate startup interfaces.

Affected package paths (core bundles retain `src/...` comments):

- Client `promise/generated/{client.js,types.d.ts}`: HTTP endpoints, one-request transport, AbortSignal, step model/token fields, sequence envelopes, watermark, assistant messages, interrupt/wait and `integration.connect.key` remain compatible. New optional activity callbacks/RPC APIs are unused. Public auxiliary usage is still absent from the event union; gaps/aggregate discrepancies still fail closed.
- Core `config/plugin/source.ts`, `plugin/{module,supervisor}.ts`; plugin `dist/host.js`: configured local plugin **files are now skipped**; directories resolve `server`/`index` entrypoints and require containment. ASF's unchanged hook moved to `scripts/opencode-policy/index.mjs`, the private config selects its directory, and build copies that directory. Plugin status moved to **`state.status`** with `features`, so readiness/failure checks and fixtures use that exact shape. No readiness gate was removed or deadline enlarged.
- Core `bus.ts`, `session/{usage,projector}.ts`, `session/runner/{step,publish-llm-event,retry}.ts`; server `event-feed.js`, `handlers/session.js`: persistence still defaults false, public feed capacity is 4,096 with overflow failure, sequence/commit-watermark semantics remain. Step-ended lacks a model; started-step pairing remains required. Visible output plus reasoning, aggregate usage addition, missing-component normalization to zero and missing native price fallback to zero are unchanged. Local tool success `executed:false` still means not provider-executed.
- Core `credential.ts`, `integration.ts`, `database/migration.ts`; server `handlers/integration.js`: explicit keys still enter only the owned native SQLite DB via the official client. Fresh DB bootstrap marks migrations complete rather than running legacy credential import; new-version identities reject old sessions before native migration/continuation. No global auth import or reprovisioning on continuation was added.
- CLI package metadata/postinstall establishes the official native executable/package mapping. Isolated native tests verify exact CLI version, authenticated stdio URL handshake, policy activation, disabled title/compaction agents, private DB, subscription/watermark APIs, interrupt/wait, synthetic-key persistence and cleanup without model sends.

**Source-check limitation requiring review before live use:** `SessionStep.attempt` has a `RecoverFull` branch for Transport recovery `retry-full` / `rotate-and-retry-full` before calling `input.retry`; `SessionRunner.runStep` can loop once through that branch without `session.retry.scheduled`. This exists in **both** inspected beta-18684 and beta-19271 core packages, not a new compatibility regression. The plugin declines retry-policy decisions, but cannot establish blanket native transport no-resend guarantees. No transport patch, extra probe, policy weakening or broader remediation was added. Offline lifecycle success does not qualify that failure path.

## Checks and qualification limits

The relevant injected adapter/process/accounting/signal tests pass. The actual pinned Codex app-server config metadata test and actual pinned OpenCode private-server lifecycle test pass in allowlisted environments with empty temporary HOME/XDG roots. No installed-native test was skipped in that explicit opt-in run. No thread/turn was created for Codex; OpenCode created only a metadata fixture session and sent no prompt. The initial OpenCode lifecycle attempt correctly refused the old file-plugin configuration; after the directory compatibility change, it passed.

`npm ci --ignore-scripts && npm run check` passed on Node 22.22.3 / npm 10.9.8: typecheck, lint, repository-wide formatting, **82 tests passed / 0 failed / 2 opt-in native tests skipped**, and build. The two native paths were then explicitly enabled with absolute project-local executables in an allowlisted environment: **3 tests passed / 0 failed / 0 skipped**. The built policy module matches its source bytes. Untracked Pi review logs added later may affect repository-wide Prettier checking; no ignore rules were changed.

These are **offline compatibility checks**, not live model/tool/correction/failure qualification, actual-model billing evidence, full-provider cost coverage or invoice completeness. The immutable SQLite schema, reservation/receipt order, accounting semantics, owned session CAS and public Harness API are unchanged. Unknown cost remains null/incomplete, and no failed/uncertain work is resent. New SDK/CLI identity pins reject historical session/action bindings. Committed historical evidence and verification history are untouched; old live successes do not validate these versions. The unresolved failed coder allowance authorizes no new send. No live runner or model probe was executed.
