#!/usr/bin/env node
// BranchForge MCP server — spawn a parallel AI engineering team in isolated git worktrees.
// Each part runs as its own headless Claude agent (Agent SDK) in its own worktree, in parallel;
// tests gate each part; passing parts merge into a forge/integration branch. All local.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { readdirSync, mkdtempSync } from 'node:fs'
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

async function runAgent(prompt, cwd, abort) {
  let text = '', cost = 0
  const res = query({ prompt, options: { cwd, permissionMode: 'bypassPermissions', abortController: abort, pathToClaudeCodeExecutable: CLAUDE } })
  for await (const m of res) {
    if (m.type === 'assistant') { for (const b of m.message.content) if (b.type === 'text') text += b.text }
    else if (m.type === 'result') cost = m.total_cost_usd || 0
  }
  return { text, cost }
}

function gate(cwd) {
  let files = []
  try { files = readdirSync(cwd) } catch { return null }
  if (!files.some((f) => /\.test\.(c|m)?js$/.test(f))) return null
  try { execFileSync('node', ['--test'], { cwd, encoding: 'utf8', stdio: 'pipe' }); return 'PASS' } catch { return 'FAIL' }
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

const server = new McpServer({ name: 'branchforge', version: '0.1.0' })

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
  },
  async ({ goal, budget, targetRepo }) => {
    const repo = targetRepo || REPO
    const cap = budget || 2.0
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
      const r = await runAgent(part.task + '\n\nWork only inside this worktree; keep changes focused on your part.', wt, abort)
      charge(r.cost)
      git(wt, ['add', '-A'])
      try { git(wt, ['commit', '-q', '-m', 'forge: ' + (part.title || part.id)]) } catch {}
      return { ...part, branch, gate: gate(wt), cost: r.cost }
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
      catch { try { git(intWt, ['merge', '--abort']) } catch {} }
    }
    const intGate = gate(intWt)

    for (const r of results) {
      if (!r) continue
      out.push('  [' + r.id + '] ' + (r.title || '') + (r.skipped ? ' — skipped (budget)' : '   gate=' + (r.gate || 'none') + '   $' + (r.cost || 0).toFixed(4)))
    }
    out.push('')
    out.push('Integration branch: ' + intBranch + '   merged: ' + (merged.join(', ') || 'none') + '   gate=' + (intGate || 'none'))
    out.push('Total cost: $' + spent.toFixed(4) + (abort.signal.aborted ? '   (budget kill-switch hit)' : ''))
    out.push('')
    out.push('Review:  git -C ' + repo + ' diff ' + base + '..' + intBranch)
    out.push('Land:    git -C ' + repo + ' checkout ' + base + ' && git merge ' + intBranch)
    return { content: [{ type: 'text', text: out.join('\n') }] }
  }
)

await server.connect(new StdioServerTransport())
