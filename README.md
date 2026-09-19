# ASF TypeScript Exploration

This is a new, independent exploration of an SDK-first TypeScript direction for ASF. The aim is to keep ordinary async workflows simple while making important operational signals observable.

## Direction

A harness should expose events for:

- messages;
- tool calls and results;
- reasoning when a provider exposes it;
- token and usage data;
- model cost estimates and related accounting data.

Durable accounting should be separate from optional transcript capture and from any future live UI. Simplicity is central: this repository is not a feature-parity port by default.

## Current status

This repository currently contains documentation only. It has no implementation, dependencies, test suite, or CI. The ideas above are intentions, not implemented features or promises of complete accounting.

## Reference material

- [Original Python ASF](https://gitea.adsm.ovh/adam/asf)
- [TypeScript prototype MR #42](https://gitea.adsm.ovh/adam/asf/pulls/42), commit `e120bbcf295add7eaff1ba2e6ed9377dd75bdd66`
- [Observability design MR #49](https://gitea.adsm.ovh/adam/asf/pulls/49)

These sources are reference material, not dependencies or final architecture requirements.
