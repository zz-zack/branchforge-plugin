<div align="center">

# BranchForge

**Run an AI engineering team in parallel git worktrees — one goal in, a verified merged branch out.**

A Claude Code plugin. To the outside it looks like one developer; inside, it's a team.

English · [简体中文](#简体中文) · [日本語](#日本語)

</div>

---

## What it is

Today's AI coding is **one agent ≈ one developer**: serial, single workspace, single branch. Even opening several Claude sessions doesn't help — they share a working directory and overwrite each other.

BranchForge is a **harness**: you give it a goal, and it spawns a *team* of Claude agents that work **in parallel, each in its own isolated `git worktree`**, verify their work with tests, and merge into a single clean branch. It's not multi-agent chit-chat — it's the **environment** (git isolation + verification + review) that lets agents work reliably. Think Kubernetes for agents, not AutoGPT.

Everything runs **locally on your machine, on your own Claude** — the plugin spawns headless Claude Code instances (via the Agent SDK), one per worktree. No servers, no extra cost beyond your normal Claude usage.

## Install

In Claude Code:

```
/plugin marketplace add zz-zack/branchforge-plugin
/plugin install branchforge@branchforge
```

Requires `node` and `git` on your `PATH`, and a logged-in Claude Code.

## Usage

From inside any project repo, in your Claude Code session:

```
/branchforge:orchestrate add SAML login to the user module, frontend and backend
```

or just describe a large task and let Claude invoke it. What happens:

1. **Plan** — `forge_plan` decomposes the goal into independent parts. You review/adjust before anything runs (the cheapest checkpoint).
2. **Run** — `forge_run` creates one worktree per part, runs each with its own parallel Claude agent, tests each, and merges the passing parts into `forge/integration`.
3. **Review & land** — you get a report; review with `git diff <base>..forge/integration` and merge when satisfied. You stay the commander.

## How it works

```
your Claude Code session  =  Lead
        │  calls the forge_run tool
        ▼
  BranchForge MCP server (local)
        │  git worktree add  ×N
        ▼
  N headless Claude agents, one per worktree, in parallel
        │  code → test (gate) → commit
        ▼
  merge passing parts → forge/integration  →  you review & merge to main
```

Three load-bearing ideas: **contracts** (parts depend on a shared spec, not each other), a **verification inner loop** ("done" is decided by tests), and **integration self-heal** (the merged whole must pass too).

## Principles

- **Git First** — models change; `git` (branch / merge / worktree) doesn't. The agent is replaceable; git is not.
- **Human-in-the-loop** — AI proposes, you decide. You review the integration branch before it touches `main`.
- **Local & yours** — your machine, your repo, your Claude credentials. Nothing leaves except normal Claude API calls.

## Status

`v0.3.0` — the three harness pillars are in place:

- **Contract layer** — pass a `contract` (a `node:test` file). Every part is told to build against it, and it gates the *merged* whole — catching the semantic mismatches that `git merge` accepts but that break the integrated result.
- **Verification inner loop** — a **smart gate** (detects the `package.json` test script, or test files anywhere run via `node --experimental-strip-types --test` for TypeScript; auto-`npm install`s in fresh worktrees) plus **self-heal**: on failure the output is fed back to the same agent to fix, up to `heal` rounds (default 2), per part *and* for the integration. "Done" is proven by tests, not claimed.
- **Integration self-heal** — passing parts merge into `forge/integration` (conflicts kept via `-X ours` instead of dropping a part); the merged whole must pass too.

`forge_run` args: `goal`, `targetRepo?` (build in any repo), `budget?`, `heal?`, `contract?`.

Roadmap: plan-approval as a first-class two-step, async/resumable long runs, and an optional visual companion app (live worktree office + IDE diff view).

## License

Apache-2.0

---

<a name="简体中文"></a>
## 简体中文

**在并行的 git worktree 里跑一支 AI 工程团队 —— 输入一个目标,产出一个测试通过的合并分支。** 一个 Claude Code 插件。对外是一个开发者,对内是一个团队。

今天的 AI 编码是「一个 agent ≈ 一个开发者」:串行、单工作区、单分支。开多个会话也没用 —— 它们共享工作目录、互相覆盖。

BranchForge 是一个 **harness**:你给一个目标,它 spawn 一支 Claude 团队,**并行、每个在自己隔离的 `git worktree` 里**干活,用测试验证,合并成一个干净分支。这不是多 agent 闲聊,而是提供让 agent 可靠工作的**环境**(git 隔离 + 验证 + 评审)。是 agent 版的 Kubernetes,不是 AutoGPT。

**全程在你本机、用你自己的 Claude** —— 插件通过 Agent SDK spawn headless Claude Code,一个 worktree 一个。没有服务器,除正常 Claude 用量外没有额外成本。

**安装**(在 Claude Code 里):
```
/plugin marketplace add zz-zack/branchforge-plugin
/plugin install branchforge@branchforge
```

**使用**(在任意项目仓库里):
```
/branchforge:orchestrate 给用户模块加 SAML 登录,前后端都要
```
→ Lead 拆解计划(你先审)→ 每个 part 在独立 worktree 并行干 + 测试 → 通过的合进 `forge/integration` → 你 `git diff` 审完再合主干。**你始终是指挥官。**

许可:Apache-2.0

---

<a name="日本語"></a>
## 日本語

**並列の git worktree で AI エンジニアチームを動かす — ゴールを1つ入れると、テスト済みのマージ済みブランチが出てくる。** Claude Code プラグイン。外から見れば一人の開発者、中身はチーム。

今日の AI コーディングは「1 エージェント ≈ 1 開発者」:直列・単一ワークスペース・単一ブランチ。複数セッションを開いても作業ディレクトリを共有して上書きし合うだけです。

BranchForge は **ハーネス**です:ゴールを渡すと、Claude エージェントのチームを起動し、**並列で、それぞれ独立した `git worktree`** で作業させ、テストで検証し、1 つのクリーンなブランチにマージします。マルチエージェントの雑談ではなく、エージェントが確実に働くための**環境**(git 分離 + 検証 + レビュー)です。

**すべてローカル、あなた自身の Claude で動作**します。Agent SDK 経由でヘッドレスの Claude Code を worktree ごとに起動します。サーバー不要、通常の Claude 利用以外の追加コストなし。

**インストール**(Claude Code 内):
```
/plugin marketplace add zz-zack/branchforge-plugin
/plugin install branchforge@branchforge
```

**使い方**(任意のプロジェクトリポジトリ内):
```
/branchforge:orchestrate ユーザーモジュールに SAML ログインを追加(フロント+バック)
```
→ Lead が計画を分解(先にレビュー)→ 各パートを独立 worktree で並列実行+テスト → 合格分を `forge/integration` にマージ → `git diff` で確認後に main へ。**指揮官は常にあなた。**

ライセンス:Apache-2.0
