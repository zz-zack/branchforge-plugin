---
description: Orchestrate a parallel AI engineering team. Decomposes a goal into independent parts, spawns one isolated git worktree per part each run by its own Claude agent, verifies with tests, and merges the passing parts into a single integration branch. Use when a task is large or parallelizable, or when the user says "orchestrate", "in parallel", "as a team", or invokes /branchforge.
---

# BranchForge — parallel worktree orchestration

The user's goal is in `$ARGUMENTS`. Treat the user's current Claude Code session as the **Lead**.

1. Call the **`forge_plan`** MCP tool with the goal. It returns a decomposition into independent parts (each owning disjoint files). **Show the plan to the user** and let them adjust or approve it — this is the cheapest place to correct course, before any agents run.

2. On approval, call the **`forge_run`** MCP tool with the goal. It will, entirely locally in the user's repo:
   - create one isolated `git worktree` per part,
   - run each part with its **own Claude agent in parallel** (separate process, separate context),
   - run verification (tests) inside each worktree,
   - merge the passing parts into a **`forge/integration`** branch.

3. Relay the report: what each part did, the gate (test) result per part, which parts merged, the integration branch, and total cost. Then tell the user how to review and land it:
   - review: `git diff <base>..forge/integration`
   - land: `git checkout <base> && git merge forge/integration`

Principles: everything runs on the user's machine with their own Claude credentials. The user stays the **commander** — they review the integration branch before it touches their main branch. To the outside it looks like one developer; inside, it was a team.
