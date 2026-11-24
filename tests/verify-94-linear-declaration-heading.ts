// tests/verify-94-linear-declaration-heading.ts — the decision layer must read the Linear declaration heading (#94)
//
// Why this gate exists: a workspace that declares Linear writes the same heading shape every other backend
// writes (a level-1 "Issue tracker: linear" line in docs/agents/issue-tracker.md). parseIssueTracker, the one
// parser the decision layer reads, had no rule for it, so that text could only reach the body-keyword fallback,
// which answered "github, low confidence". Per ADR 20261027 a low-confidence body mention is evidence, never a
// verdict: the declaration layer said nothing, autodetection ran, and two rooms claimed the same workspace —
// GitHub from the git remote, Linear from the same heading read by the Linear room. openTracker refuses to pick
// a winner there (multi-match), so the whole workspace could not be read at all. One file, two readers, two
// different answers.
//
// What this gate pins:
//   A  the heading the Linear room writes is a high-confidence declaration, with or without an alias line and
//      in any case — and it keeps the parser reason "title-linear", so the log can say why;
//   B  a heading beats any GitHub or GitLab word in the body: the real document names GitHub only to say that
//      GitHub Issues are not the tracker there;
//   C  the unified decision takes Linear from that declaration and never asks the rooms to claim at all — the
//      skipped claim step is what removes the multi-match, not a change to openTracker;
//   D  the same document with the heading line removed still falls to the low-confidence body mention, and then
//      autodetection really does produce the two claims. The fixture therefore reproduces #94, so C is not a
//      tautology: the only difference between the broken run and the fixed run is the heading rule;
//   E  the claim rules themselves are untouched: the Linear room still needs the alias line before it claims (a
//      heading without one is a declaration the setup hint fills in, not a workspace sent silently to GitHub),
//      and the GitLab and Markdown rooms do not claim a Linear document;
//   F  this repository's own declaration file still resolves to GitHub. It demonstrates the Linear section
//      further down the same page; that example must never flip the deck's own workspace to Linear, which is why
//      the linear rule sits after the GitHub rule in the parser.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-94-linear-declaration-heading.ts
//
// 门禁归属: src/tracker/kernel/issue-tracker-declaration.ts
// 门禁归属: src/tracker/rooms/linear
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseIssueTracker, normalizeTrackerText } from '../src/tracker/kernel/issue-tracker-declaration.ts'
import { decideBackend } from '../src/tracker/detection/backendDecision.ts'
import { BINDING_HEADING, renderBindingSection } from '../src/tracker/rooms/linear/binding-write.ts'
import { linearModule } from '../src/tracker/rooms/linear/index.ts'
import { gitlabBackend } from '../src/tracker/rooms/gitlab/index.ts'
import { markdownModule } from '../src/tracker/rooms/markdown/index.ts'
import { planGates } from '../scripts/lib/discover-gates.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function check(ok: unknown, msg: string, evidence?: unknown): void {
  if (ok) { console.log('  PASS ' + msg); passed++ }
  else {
    failed++
    console.log('  FAIL ' + msg + (evidence === undefined ? '' : '  --- got: ' + String(evidence)))
  }
}
function title(t: string): void { console.log('\n== ' + t + ' ==') }

/** The declaration the decision layer reads, and nothing else: no workspace file, no other path has content. */
function fakeFs(files: Record<string, string>): { reads: string[]; fs: { resolve(rel: string, opts?: { cwd?: string }): Promise<unknown>; readText(target: unknown): Promise<string> } } {
  const reads: string[] = []
  return {
    reads,
    fs: {
      async resolve(rel: string, opts?: { cwd?: string }) { return { rel: String(rel), cwd: String((opts && opts.cwd) || '') } },
      async readText(target: unknown) {
        const t = (target || {}) as { rel?: string }
        const rel = String(t.rel || '')
        reads.push(rel)
        const text = files[rel]
        if (text == null) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        return text
      },
    },
  }
}

/** A registry that knows which rooms are installed and answers the claim step with the claims it was given. */
function fakeRegistry(ids: string[], claims?: string[]) {
  let selects = 0
  return {
    get selects() { return selects },
    registry: {
      has: (id: string) => ids.indexOf(String(id)) >= 0,
      select: async () => {
        selects += 1
        const list = claims || []
        return { backendId: list[0] || null, source: 'matches', multiHit: list.length > 1 ? list.slice() : undefined }
      },
    },
  }
}

/** Context for a room's matches: the same file service shape, keyed by the repository-relative path. */
function roomContext(ws: string, files: Record<string, string>) {
  const f = fakeFs(files)
  return { cwd: ws, fs: f.fs, platform: { fs: f.fs }, exec: async () => ({ stdout: '', stderr: '', code: 0 }) }
}

// The shape of the document that produced #94, copied as a fixture so the gate does not depend on that machine's
// checkout: the Linear heading is line one, and the body names GitHub only to say it is not the tracker.
const RAG_DECLARATION = [
  BINDING_HEADING,
  '',
  'alias: guedder',
  'team: GUE',
  '',
  'Issues and specs for this repo live in Linear, workspace "guedder", team "GUE"',
  '(ticket keys "GUE-###"). GitHub Issues on "guedder/guedder-rag" are not the',
  'tracker: never create or edit work there.',
  '',
].join('\n')
/** The same document with the heading line removed: the state of that workspace before #94 was fixed. */
const RAG_DECLARATION_WITHOUT_HEADING = RAG_DECLARATION.split('\n').slice(1).join('\n')
/** A heading with no alias line: still a Linear declaration, and the setup hint is what fills the alias in. */
const LINEAR_HEADING_WITHOUT_ALIAS = [BINDING_HEADING, '', 'Issues for this repo live in Linear.', ''].join('\n')

const WS = '/repo/guedder-rag'

async function main(): Promise<void> {
  console.log('the Linear declaration heading, read by the parser the decision layer uses (#94)')

  // ======================================================================
  title('A  the heading the Linear room writes is a high-confidence declaration')

  {
    const p = parseIssueTracker(normalizeTrackerText(BINDING_HEADING))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear',
      'the bare heading the room writes (' + BINDING_HEADING + ') reads as a high-confidence Linear declaration',
      JSON.stringify(p))
    check(p.reason === 'title-linear', 'the parser reason stays title-linear, so the log can say why the workspace was taken as Linear', p.reason)
    check(p.rawHint === 'linear', 'the raw hint keeps the backend name', p.rawHint)
  }
  {
    // The setup path hands an agent exactly this text (#65); what it writes must be what the decision layer reads.
    const written = renderBindingSection({ alias: 'guedder', team: 'GUE' })
    const p = parseIssueTracker(normalizeTrackerText(written))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear',
      'the section the Linear setup path writes reads back as a high-confidence declaration',
      JSON.stringify({ written: written, parsed: p }))
  }
  {
    const p = parseIssueTracker(normalizeTrackerText(LINEAR_HEADING_WITHOUT_ALIAS))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear',
      'a heading without an alias line is still a Linear declaration: the room asks for the alias instead of the workspace going silently to GitHub',
      JSON.stringify(p))
  }
  {
    const p = parseIssueTracker(normalizeTrackerText('# ISSUE TRACKER: Linear\n\nalias: home\n'))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear', 'the heading is read ignoring case', JSON.stringify(p))
  }

  // ======================================================================
  title('B  the heading beats a GitHub or GitLab word in the body')

  {
    const p = parseIssueTracker(normalizeTrackerText(RAG_DECLARATION))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear' && p.reason === 'title-linear',
      'the #94 document (heading first, body says GitHub Issues are not the tracker) is a Linear declaration',
      JSON.stringify(p))
  }
  {
    const doc = [BINDING_HEADING, '', 'Previously this repo used GitLab; it does not any more.', ''].join('\n')
    const p = parseIssueTracker(normalizeTrackerText(doc))
    check(p.confidence === 'high' && p.explicitBackendId === 'linear',
      'a GitLab sentence in the body does not outrank the Linear heading',
      JSON.stringify(p))
  }

  // ======================================================================
  title('C  the unified decision takes Linear and never asks the rooms to claim')

  {
    const f = fakeFs({ 'docs/agents/issue-tracker.md': RAG_DECLARATION })
    const reg = fakeRegistry(['github', 'linear'], ['github', 'linear'])
    const r = await decideBackend(WS, { fs: f.fs, registry: reg.registry, logCtx: null })
    check(r.backendId === 'linear', 'the workspace is decided as Linear', JSON.stringify({ backendId: r.backendId, state: r.state }))
    check(r.source === 'explicit' && r.origin === 'declaration',
      'the verdict comes from the declaration layer (source explicit, origin declaration)',
      JSON.stringify({ source: r.source, origin: r.origin }))
    check(!r.multiHit, 'no multi-match is reported: one layer gave a verdict, so nothing had to be arbitrated', JSON.stringify(r.multiHit))
    check(reg.selects === 0,
      'the claim step was never asked, which is the rule that removes the multi-match (openTracker still refuses to pick a winner when two rooms really do claim)',
      'select calls: ' + reg.selects)
  }

  // ======================================================================
  title('D  the same document without the heading still reproduces #94')

  {
    const p = parseIssueTracker(normalizeTrackerText(RAG_DECLARATION_WITHOUT_HEADING))
    // The reason is the body-fallback one, and it may carry the "github-template" word because that body says
    // "GitHub Issues": both words mean the same thing here, a low-confidence body mention and not a declaration.
    check(p.confidence === 'low' && p.explicitBackendId === 'github' && /^(keyword-github|github-template)$/.test(p.reason),
      'without the heading only the body keyword is left: github, low confidence (the state before the fix)',
      JSON.stringify(p))
  }
  {
    const f = fakeFs({ 'docs/agents/issue-tracker.md': RAG_DECLARATION_WITHOUT_HEADING })
    const reg = fakeRegistry(['github', 'linear'], ['github', 'linear'])
    const r = await decideBackend(WS, { fs: f.fs, registry: reg.registry, logCtx: null })
    const hits = (r.multiHit || []) as string[]
    check(reg.selects === 1, 'a low-confidence mention produces no verdict, so the claim step does run', 'select calls: ' + reg.selects)
    check(hits.indexOf('github') >= 0 && hits.indexOf('linear') >= 0 && hits.length >= 2,
      'both rooms claim that workspace (GitHub from the remote, Linear from the heading): the multi-match of #94',
      JSON.stringify({ backendId: r.backendId, multiHit: r.multiHit, state: r.state }))
  }

  // ======================================================================
  title('E  the rooms own claim rules are untouched')

  {
    const hit = await linearModule.matches({ cwd: WS } as never, roomContext(WS, { 'docs/agents/issue-tracker.md': RAG_DECLARATION }) as never)
    check(hit === true, 'the Linear room claims a document that carries the heading and an alias line')
  }
  {
    const hit = await linearModule.matches({ cwd: WS } as never, roomContext(WS, { 'docs/agents/issue-tracker.md': LINEAR_HEADING_WITHOUT_ALIAS }) as never)
    check(hit === false,
      'the Linear room still refuses a heading with no alias line (the setup hint asks for one; the parser alone does not invent an account)')
  }
  {
    const ctx = roomContext(WS, { 'docs/agents/issue-tracker.md': RAG_DECLARATION })
    const gitlab = await gitlabBackend.matches({ cwd: WS } as never, ctx as never)
    check(gitlab === false, 'the GitLab room does not claim a Linear document')
    const markdown = await markdownModule.matches({ cwd: WS } as never, ctx as never)
    check(markdown === false, 'the Markdown room does not claim a Linear document')
  }

  // ======================================================================
  title('F  the repository own declaration file still resolves to GitHub')

  {
    const own = fs.readFileSync(path.join(ROOT, 'docs/agents/issue-tracker.md'), 'utf8')
    const p = parseIssueTracker(normalizeTrackerText(own))
    check(/\n#\s*issue\s*tracker\s*:\s*linear/im.test(own),
      'the file really does carry a Linear example section, otherwise this section proves nothing')
    check(p.confidence === 'high' && p.explicitBackendId === 'github',
      'a GitHub declaration followed by a Linear example section is still GitHub: the first, real heading wins',
      JSON.stringify(p))
  }

  // This gate has to be planned into the chain; a gate nobody runs is not a gate (#1125 asks the planner).
  {
    const mine = planGates(ROOT).filter((s: { file: string }) => s.file.indexOf('verify-94-linear-declaration-heading') >= 0)
    check(mine.length === 1, 'this gate is planned into the verify chain exactly once (got ' + mine.length + ')')
  }

  console.log('\nverify-94-linear-declaration-heading: ' + passed + ' passed, ' + failed + ' failed')
  if (failed) process.exit(1)
  console.log('LINEAR DECLARATION HEADING OK')
}

main().catch((e: unknown) => {
  console.log('  FAIL the gate threw: ' + String((e && (e as Error).message) || e))
  process.exit(1)
})
