# Changelog

## 0.3.1
- `budget` now defaults to **no limit** (runs to completion); the kill-switch only engages when you pass an explicit budget. The old $2 default could cut a real run off mid-way. (On a Claude subscription the reported cost is notional, not a bill.)

## 0.3.0
- **Contract layer**: new `contract` arg to `forge_run` — a `node:test` file injected as the spec for every part and enforced (with self-heal) as a gate on the merged integration. Completes the three harness pillars (contract · verification loop · integration self-heal).

## 0.2.3
- Planner splits by **feature/module, not layer** — each code part owns its own tests (a separate test-only part can't see the source, which made the integration gate pass vacuously).

## 0.2.2
- Gate best-effort `npm install`s in a fresh worktree before running an npm-test gate (no `node_modules` otherwise → false failure).

## 0.2.1
- Robust integration: on merge conflict, retry with `-X ours` so a part keeps its non-conflicting files instead of being dropped whole; part agents are told not to touch repo-root files.

## 0.2.0
- **Verification inner loop**: smart, TS-aware, recursive gate (`package.json` test script or `node --experimental-strip-types --test`) + **self-heal** — gate failures are fed back to the same agent to fix, per part and for the integration.

## 0.1.x
- Initial plugin: `forge_plan` / `forge_run`, parallel git-worktree agents merged into `forge/integration`. Single-file bundled MCP server using the user's installed `claude` binary. `targetRepo` arg.
