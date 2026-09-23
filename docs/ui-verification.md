# Real UI workflow verification

[Download the committed real-workflow recording](evidence/ui-real-codex-workflow.webm).

This is an actual Playwright `recordVideo` capture of run `ui-real-codex-review-v1`, not synthetic footage or a replay. The 159.88-second recording follows a real Codex `gpt-6-astra` source review, an actual `npm run check` through an ASF command, and a same-native-session follow-up: two model turns with a requested-rate estimate of **$0.987802** and no new unresolved accounting.

The recorded check **failed** two existing process tests (40 passed, 2 failed, 2 skipped): missing startup PID/partial stdout under 150 ms cancellation. The root cause is unproven. Standalone checks before capture and after capture passed (42 passed, 2 skipped), including typecheck, lint, formatting and build. Those later passes do not erase the failures visible in the video; this is not an entirely green recorded workflow.

Browser verification selected the run before the first send and observed native model/tool events before the terminal receipt, retained responses, command/session/cost displays, and no browser errors or external requests. All 122 old rows matched their prior hashes. The original seven reservations were preserved; the resulting nine-reservation aggregate had $1.184426 known estimates and two old incomplete records. Estimates are not invoice totals, and incomplete costs are not zero.

## Archive and privacy

The user explicitly approved committing the visible source/model conversation. This video contains run/native-session identifiers and is **not redacted**. It is a bounded visual record, not a complete event, accounting, or reproducibility archive.

Only this deliberately promoted copy is tracked. The original `.asf/ui-verification/real-codex-workflow.webm` remains intact and ignored, along with raw reports, screenshots, databases, native state, authorization files, source workspaces and browser profiles. Those private artifacts are not included. The separate synthetic `workflow-ui.webm` is not this evidence. Do not rerun live model work to improve the footage.

- Tracked file: `docs/evidence/ui-real-codex-workflow.webm`
- Size: **14,332,852 bytes**
- SHA-256: `96e037c8a69667778d537d5345a6e2bad1cf5640cd1a7051d8acd1f868f77c4c`
