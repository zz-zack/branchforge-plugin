#!/usr/bin/env node
// BranchForge MCP server — spawn a parallel AI engineering team in isolated git worktrees.
// Each part runs as its own headless Claude agent (Agent SDK) in its own worktree, in parallel;
// tests gate each part; passing parts merge into a forge/integration branch. All local.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { readdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const REPO = process.env.BF_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

// Use the user's installed Claude Code binary (this is a Claude Code plugin — they have it),
// instead of the heavy cli.js the SDK vendors (which the single-file bundle can't locate).
function findClaude() {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH
  try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() } catch (e) {}
  return 'claude'
}
const CLAUDE = findClaude()

async function runAgent(prompt, cwd, abort, resume) {
  let text = '', cost = 0, sessionId = null
  const options = { cwd, permissionMode: 'bypassPermissions', abortController: abort, pathToClaudeCodeExecutable: CLAUDE }
  if (resume) options.resume = resume
  const res = query({ prompt, options })
  for await (const m of res) {
    if (m.type === 'assistant') { for (const b of m.message.content) if (b.type === 'text') text += b.text }
    else if (m.type === 'result') { cost = m.total_cost_usd || 0; sessionId = m.session_id }
  }
  return { text, cost, sessionId }
}

// Recursively detect test files (js/ts/mjs/mts/cjs/cts) so tests in subdirs count.
function hasTestFiles(dir, depth = 0) {
  if (depth > 6) return false
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.forge') continue
    if (e.isFile() && /\.test\.(c|m)?[tj]s$/.test(e.name)) return true
    if (e.isDirectory() && hasTestFiles(join(dir, e.name), depth + 1)) return true
  }
  return false
}
function detectGate(cwd) {
  // Prefer the project's own test script (handles TS toolchains and custom runners).
  try {
    const pkgPath = join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.scripts && pkg.scripts.test && !/no test specified/i.test(pkg.scripts.test)) {
        return { cmd: 'npm', args: ['test', '--silent'] }
      }
    }
  } catch {}
  // Else: run Node's test runner with TS type-stripping (Node >= 22.6) if any tests exist.
  if (hasTestFiles(cwd)) return { cmd: 'node', args: ['--experimental-strip-types', '--test'] }
  return null
}
// Returns { status: 'PASS'|'FAIL'|null, output } — output (on FAIL) feeds the self-heal loop.
function gate(cwd) {
  const g = detectGate(cwd)
  if (!g) return { status: null, output: '' }
  // A fresh worktree has no node_modules; an npm-test gate needs deps — best-effort install first.
  if (g.cmd === 'npm' && !existsSync(join(cwd, 'node_modules')) && existsSync(join(cwd, 'package.json'))) {
    try { execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd, stdio: 'pipe', timeout: 240000 }) } catch (e) {}
  }
  try {
    execFileSync(g.cmd, g.args, { cwd, encoding: 'utf8', stdio: 'pipe' })
    return { status: 'PASS', output: '' }
  } catch (e) {
    return { status: 'FAIL', output: ((e.stdout || '') + (e.stderr || '')).slice(-2500) }
  }
}

async function plan(goal, abort) {
  const tmp = mkdtempSync(join(tmpdir(), 'bf-lead-'))
  const prompt =
    'You are a tech lead. Goal: ' + goal + '\n\n' +
    'Decompose into INDEPENDENT parts that separate agents can build in parallel without talking to each other, each owning DISJOINT files. ' +
    'Prefer 2-4 parts; if the goal is small, return a single part. ' +
    'Output ONLY JSON: {"parts":[{"id":"a","title":"short","task":"what this agent does, incl. the files it owns"}]}'
  const r = await runAgent(prompt, tmp, abort)
  let parsed
  try { parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)[0]) } catch { parsed = { parts: [{ id: 'a', title: goal.slice(0, 30), task: goal }] } }
  parsed.cost = r.cost || 0
  return parsed
}

const server = new McpServer({ name: 'branchforge', version: '0.2.2' })

server.tool(
  'forge_plan',
  'Decompose a goal into independent parallel parts for the user to review BEFORE running. Returns a JSON plan; does not modify the repo.',
  { goal: z.string().describe('The high-level goal to decompose.') },
  async ({ goal }) => {
    const p = await plan(goal)
    return { content: [{ type: 'text', text: 'BranchForge plan — ' + p.parts.length + ' part(s), planning cost $' + (p.cost || 0).toFixed(4) + ':\n\n' + JSON.stringify(p.parts, null, 2) + '\n\nShow this to the user; on approval call forge_run with the same goal.' }] }
  }
)

server.tool(
  'forge_run',
  'Spawn a parallel AI engineering team in the current repo: decompose the goal, create one isolated git worktree per part, run each with its own Claude agent in parallel, verify with tests, and merge passing parts into a forge/integration branch. Returns a report; the user reviews and merges to their main branch.',
  {
    goal: z.string().describe('The goal to build.'),
    targetRepo: z.string().optional().describe('Absolute path to the git repo to build in. Defaults to the current project (CLAUDE_PROJECT_DIR).'),
    budget: z.number().optional().describe('Max total USD spend before the kill-switch trips (default 2.0).'),
    heal: z.number().optional().describe('Max self-heal rounds per part and for integration when tests fail (default 2).'),
  },
  async ({ goal, budget, targetRepo, heal }) => {
    const repo = targetRepo || REPO
    const cap = budget || 2.0
    const healMax = heal == null ? 2 : heal
    const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const abort = new AbortController()
    let spent = 0
    const charge = (c) => { spent += c || 0; if (spent > cap && !abort.signal.aborted) abort.abort() }

    const p = await plan(goal, abort); charge(p.cost)
    const parts = p.parts
    const out = ['BranchForge run — goal: ' + goal, 'repo: ' + repo, 'base: ' + base + '   parts: ' + parts.length, '']

    async function runPart(part) {
      if (abort.signal.aborted) return { ...part, skipped: true }
      const branch = 'forge/p-' + part.id
      const wt = join(repo, '.forge', 'wt-' + part.id)
      try { git(repo, ['worktree', 'remove', '--force', wt]) } catch {}
      try { git(repo, ['branch', '-D', branch]) } catch {}
      git(repo, ['worktree', 'add', '-b', branch, wt, base])
      let r = await runAgent(part.task + '\n\nWork only inside this worktree; keep changes focused on your part. Do NOT create or edit repo-root files (README, package.json, tsconfig, .gitignore) unless your part explicitly owns them — it avoids merge conflicts with the other agents. Include unit tests and a working test setup so `node --test` (or the package.json test script) passes.', wt, abort)
      let cost = r.cost; charge(r.cost)
      git(wt, ['add', '-A'])
      try { git(wt, ['commit', '-q', '-m', 'forge: ' + (part.title || part.id)]) } catch {}
      // Verification inner loop: if the gate fails, feed the failure back and let the SAME agent fix it.
      let g = gate(wt), heals = 0
      while (g.status === 'FAIL' && heals < healMax && !abort.signal.aborted) {
        heals++
        const fix = await runAgent('Your tests are failing. Fix the code AND the test setup/scripts so they pass — do not weaken or delete tests just to make them pass. Failure output:\n' + g.output, wt, abort, r.sessionId)
        cost += fix.cost; charge(fix.cost); r = fix
        git(wt, ['add', '-A'])
        try { git(wt, ['commit', '-q', '-m', 'forge: heal ' + heals + ' (' + part.id + ')']) } catch {}
        g = gate(wt)
      }
      return { ...part, branch, gate: g.status, heals, cost }
    }

    const concurrency = Math.min(3, parts.length)
    let i = 0
    const results = []
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (i < parts.length) { const idx = i++; results[idx] = await runPart(parts[idx]) }
    }))

    const intBranch = 'forge/integration'
    const intWt = join(repo, '.forge', 'wt-integration')
    try { git(repo, ['worktree', 'remove', '--force', intWt]) } catch {}
    try { git(repo, ['branch', '-D', intBranch]) } catch {}
    git(repo, ['worktree', 'add', '-b', intBranch, intWt, base])
    const merged = []
    for (const r of results) {
      if (!r || r.skipped || !r.branch) continue
      try { git(intWt, ['merge', '--no-edit', r.branch]); merged.push(r.id) }
      catch {
        // On conflict, keep the part's non-conflicting files (prefer integration's side for the
        // conflicting ones) instead of dropping the whole part. '*' marks a soft-resolved merge.
        try { git(intWt, ['merge', '--abort']) } catch {}
        try { git(intWt, ['merge', '--no-edit', '-X', 'ours', r.branch]); merged.push(r.id + '*') }
        catch { try { git(intWt, ['merge', '--abort']) } catch {} }
      }
    }
    let intGate = gate(intWt), intHeals = 0
    while (intGate.status === 'FAIL' && intHeals < healMax && !abort.signal.aborted) {
      intHeals++
      const fix = await runAgent('The merged integration fails its tests. Fix the integrated code (do NOT delete tests) so they pass. Failure output:\n' + intGate.output, intWt, abort)
      charge(fix.cost)
      git(intWt, ['add', '-A'])
      try { git(intWt, ['commit', '-q', '-m', 'forge: integration heal ' + intHeals]) } catch {}
      intGate = gate(intWt)
    }

    for (const r of results) {
      if (!r) continue
      out.push('  [' + r.id + '] ' + (r.title || '') + (r.skipped ? ' — skipped (budget)' : '   gate=' + (r.gate || 'none') + (r.heals ? '   heals=' + r.heals : '') + '   $' + (r.cost || 0).toFixed(4)))
    }
    out.push('')
    out.push('Integration branch: ' + intBranch + '   merged: ' + (merged.join(', ') || 'none') + '   gate=' + (intGate.status || 'none') + (intHeals ? '   heals=' + intHeals : ''))
    out.push('Total cost: $' + spent.toFixed(4) + (abort.signal.aborted ? '   (budget kill-switch hit)' : ''))
    out.push('')
    out.push('Review:  git -C ' + repo + ' diff ' + base + '..' + intBranch)
    out.push('Land:    git -C ' + repo + ' checkout ' + base + ' && git merge ' + intBranch)
    return { content: [{ type: 'text', text: out.join('\n') }] }
  }
)

await server.connect(new StdioServerTransport())
