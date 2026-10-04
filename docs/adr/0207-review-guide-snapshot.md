# ADR 0207: Keep the review guide as a separate snapshot

## Context

PR 12 contains portable workflows, runtime changes, personas, target integration and web interfaces. A reviewer needs a route through the code. The user wants the interactive guide in a separate PR targeting the integration branch, with no merge.

## Decision

Create a standalone HTML guide pinned to the product's exact base and head. Embed source and diffs as inert data. Use local reviewer status and notes; require the same revision pair when importing notes. Keep CI and recorded browser evidence separate from reviewer approval. Deliver the guide through an open draft PR to `integration/portable-workflows`.

## Why

The reviewer can inspect and share one file without starting ASF or loading remote dependencies. Exact pins preserve source and line references. Separate delivery keeps generated review material outside the product integration until the user decides otherwise.
