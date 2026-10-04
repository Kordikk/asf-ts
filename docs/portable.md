# Portable workflows

The visual editor authors and validates YAML/JSON. The CLI/library performs all file generation and execution. Both use `asf-ts-workflow/v1`; Python ASF files need an explicit adaptation.

```sh
npm ci --ignore-scripts
npm run asf -- validate --file examples/portable/review.yaml
npm run asf -- compile --file examples/portable/review.yaml --output /tmp/review.mts
npm run asf -- render --file examples/portable/review.yaml --output /tmp/review.svg
npm run asf -- bundle --file examples/portable/review.yaml --output /tmp/review.asfb
npm run asf -- verify-bundle --file /tmp/review.asfb
npm run asf -- run-file --file examples/portable/review.yaml --run portable-demo --input '{"ok":true}'
npm run asf -- resume-file --file examples/portable/review.yaml --run portable-demo --input '{"ok":true}'
npm run asf -- run --workflow /tmp/review.mts --run generated-demo --input '{"ok":true}'
npm run asf -- serve --port 8080
```

Artifacts never overwrite files. `serve` creates an empty store if needed, then opens it read-only. Open `/studio` for authoring and `/` for recorded execution. The browser has no compile/run/resume/retry/file-path operation.

## Recipient configuration

Legacy JSON `--config` supports the current Codex/OpenCode constructors. Profiles select those named agents with conservative capabilities. Strict tools or native instructions need a preconfigured trusted binding. Use `--targets local-targets.ts` for bindings, including ADK; the module exports `bindings: Record<string, ProfileBinding>`. Import the optional ADK adapter explicitly from `src/adapters/adk.ts`; the core does not initialize it.

Custom nodes require `--registration local-components.ts`, exporting `components: Record<string, Component>`. Each component declares schemas, code/dependency identity and whether it is safe for concurrent read-only execution. These are trusted local modules and may execute host code when imported. Parsing, rendering, bundling, and UI validation never import them. Compiler flags freeze entry hashes; recipients provide their own reviewed local bindings. Bundles omit targets, prices, credentials and private native sessions.

```ts
await runtime.run((r) =>
  executeDocument(r, document, input, { bindings, components }),
);
```

Profiles resolve before any node dispatch. Workflow defaults belong to that workflow; child instructions are not inherited implicitly. Node selection and explicit caller overrides are recorded in execution identity. Agent nodes start fresh native sessions; compatible session policy permits use through the direct Runtime API with `checkContinuation`, but v1 files do not declare native session continuation edges.

## Semantics and limits

Schemas default to draft-07; explicit 2020-12 is supported. References select guaranteed input or earlier node data on every incoming path. Structural comparisons reject known contradictions and unsupported schema transformations; identical advanced schemas still validate their actual boundary values. Branch/end records are durable. Native failure, uncertain sends, cancelled commands and malformed typed values stop execution. Successful domain rejection remains data.

Repeat is finite. Its input is selected from the parent context for every iteration; stateful repair code must capture the new candidate explicitly. All/any parallel joins wait for all started children; failure cancels and drains siblings. Concurrent commands/writers/effectful components require isolation and are rejected in v1.

Source/closed document: 1 MiB; closure loader: 64 local files/4 MiB total; definitions: 64; nodes/definition: 128; schema: 16 KiB; repeats: 100; parallel branches: 16. Runtime inputs, prompts, raw receipts and outputs also have their documented core bounds. Child dispatch limits count ASF sends/corrections; native internal inference/tool loops require their own adapter bounds. Deadlines and quotas persist across resume.

Layout-only edits preserve semantic file execution identity. Generated drivers embed the source and use the same executor; the ordinary module CLI still binds the complete generated entry bytes and path. Regenerating that module with changed presentation bytes requires a new module run. Native full-workflow export is unsupported; a driver retains ASF durability and accounting.

Candidate approvals need `requireCurrent` after the outer workflow returns, including cached parent replay, and again at the consuming publication boundary. A historical receipt does not prove current Git bytes. No atomic merge or publication authorization is implied.

See [port design](designs/ts-port.md), [portable design](designs/portable-files.md), and [runtime design](designs/child-workflows.md).
