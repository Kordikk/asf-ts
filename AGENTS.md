# Agent Guidance

## Repository boundaries

- Work in the independent checkout at `/root/asf-ts`.
- Treat `/root/asf` as read-only reference material and preserve it unchanged.
- Do not overwrite the user's untracked `/root/asf/typescript` work or import it wholesale.
- When adapting behavior, read the current implementation and relevant tests and documentation first.

## Engineering constraints

- Keep ordinary async workflows and the SDK-first approach simple.
- Prefer compatible first-party SDKs where practical.
- Validate exact OpenCode V2 SDK compatibility; do not assume it.
- Validate live cost coverage; TypeScript does not repair provider omissions in cost data.
- Keep model cost estimates distinct from billed spend.
- Represent unknown or pending costs explicitly, never as zero.
- Do not redo model work solely to obtain accounting data.
- Do not run live model tasks, incur charges, or use file-writing agent probes without explicit approval.
- Do not expand into frameworks, replay systems, live UI, or brokers by default.

## Current scope

This is a documentation-only bootstrap. It makes no promise of complete accounting and currently has no implementation, dependencies, tests, or CI. Do not add `package.json`, CI configuration, `.gitignore` boilerplate, copied implementation, a license choice, or unrelated files unless the scope is explicitly changed.
