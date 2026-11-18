// verify-deck-patch-receipt-slim.ts — gate: the deck_issue_patch receipt must stay small.
// Run from the plugin root: node --import ./scripts/ts-hook.mts tests/verify-deck-patch-receipt-slim.ts
//
// Why this gate exists: a 7-day audit showed that deck_issue_patch results were about 10 KB each
// (8.6 KB to 25.9 KB in the Tempo traces). The receipt carried the whole ticket in `data.ticket`
// (body, which already contains the comments, plus the comments array again), although the caller
// only needs to know what changed. The receipt now carries:
//   - `data.ticket`: the ticket key, plus title and effortId (the work route reads them), plus the
//     post-write value of only the fields this call changed (labels/status, assignees, state);
//   - `items`: one entry per step, and the `text` step already carries the stamped progress entry;
//   - `readBack`: { key, state, updatedAt } so the caller can confirm without reading again;
//   - `data.retry`: untouched (status-conflict refusals).
// The checks below run on a real Markdown workspace with a deliberately heavy ticket (large body,
// several comments, several progress entries) and fail if the body or the comments come back.
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.js')

const ROOT: string = path.resolve(__dirname, '..')
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
// Budget for what the model sees (text blocks of the rendered receipt) on a progress-only call.
const RENDERED_BUDGET_BYTES = 2048
const BODY_MARK = 'BODY-MARK-SENTINEL'
const COMMENT_MARK = 'COMMENT-MARK-SENTINEL'
let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

function makePlat() {
  return {
    path: path.posix,
    fs: {
      async resolve(p) { return String(p).replace(/\\/g, '/') },
      async readText(t) { return fs.readFileSync(t, 'utf8') },
      async writeText(t, c) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c, 'utf8') },
      async lstat(t) { try { return fs.statSync(t) } catch (e) { return null } },
      async listDir(t) { try { return fs.readdirSync(t) } catch (e) { return [] } },
      async stat(t) { try { return fs.statSync(t) } catch (e) { return null } },
    },
  }
}

async function main() {
  console.log('deck_issue_patch receipt stays small: no body, no comments, only what changed')
  const budget = await imp('src/refresh/kernel/host-budget.js')
  const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
  const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
  const registryMod = await imp('src/tracker/registry/core.ts')
  const markdownModule = (await imp('src/tracker/rooms/markdown/index.ts')).markdownModule
  const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
  const { deckAgentOutputSpec } = await imp('src/deck/registration/register-options.ts')
  const render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> = deckAgentOutputSpec().render
  const renderedBytes = (args: unknown, value: unknown): number => render(args, value).reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-receipt-slim-'))
  const rootPosix = root.replace(/\\/g, '/')
  fs.mkdirSync(path.join(root, '.scratch', 'demo', 'issues'), { recursive: true })
  fs.writeFileSync(path.join(root, '.scratch', 'demo', 'map.md'), '# Demo map\n\nStatus: ready-for-agent\n\n## Destination\n\nDemo\n\n## Notes\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n', 'utf8')
  const plat = makePlat()
  const ctx = { platform: plat, fs: plat.fs, cwd: rootPosix, get(n) { return n === 'fs' ? plat.fs : undefined } }
  let clock = 1700000000000
  const ledger = ledgerMod.createLedger({ now: () => clock })
  const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
  const registry = registryMod.createRegistry(Object.assign({ logEvent: () => {}, isEnabled: () => false }, ctx), { matchesTimeout: 200 })
  registry.register(markdownModule)
  const handle = { cwd: rootPosix, refId: '.scratch/demo' }
  chooseWorkspace(rootPosix, 'markdown')
  ledger.ensureBackend('github', { kind: 'two-buckets' })
  ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)
  const deps = {
    gate: gate, registry: registry, budget: budget,
    estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
    backendCtx: ctx, handleFor: () => handle,
    log: { fire: () => {} }, now: () => clock,
    invalidate: () => {},
    decideBackend: makeDecideStub(registry),
    planStore: (() => { const t = new Map(); return { durable: true, load(id) { return t.get(id) || null }, save(id, s) { t.set(id, s) } } })(),
  }
  const createTool = (await imp('src/deck/tools/issue-create.ts')).createDeckIssueCreate(deps)
  const patchTool = (await imp('src/deck/tools/issue-patch.ts')).createDeckIssuePatch(deps)
  const exec = { agent: { session: { id: 's-patch-receipt-slim', cwd: rootPosix } } }

  // A heavy ticket: about 5 KB of body, four comments, three earlier progress entries.
  const paragraph = BODY_MARK + ' The migration touches the importer, the scheduler and the retry policy; every step keeps the old path working until the new one is verified.\n\n'
  const heavyBody = '**What to build:** ' + paragraph.repeat(30)
  const created = await createTool.run(exec, { title: 'Heavy demo ticket', kind: 'issue', body: heavyBody })
  const key = String((created.data && created.data.ticket && created.data.ticket.key) || '')
  check(created.status === 'ok' && key !== '', 'fixture: heavy ticket created (key ' + key + ')')
  for (let i = 1; i <= 4; i += 1) {
    const c = await patchTool.run(exec, { key: key, comment: COMMENT_MARK + ' ' + i + ': ' + 'a long discussion paragraph about the rollout plan. '.repeat(6) })
    check(c.status === 'ok', 'fixture: comment ' + i + ' posted')
  }
  for (let i = 1; i <= 3; i += 1) {
    const p = await patchTool.run(exec, { key: key, progress: { percent: i * 20, note: 'earlier progress entry ' + i } })
    check(p.status === 'ok', 'fixture: earlier progress entry ' + i + ' written')
  }

  // ── 1. progress-only call on the heavy ticket ──
  const progressArgs = { key: key, progress: { percent: 80, note: 'importer migrated, scheduler next' } }
  const r = await patchTool.run(exec, progressArgs)
  const rawBytes = bytesOf(r)
  const seenBytes = renderedBytes(progressArgs, r)
  console.log('  INFO progress-only call: raw envelope ' + rawBytes + ' B, rendered for the model ' + seenBytes + ' B')
  check(r.status === 'ok', '1. progress-only call returns ok (got ' + r.status + ')')
  const rawText = JSON.stringify(r)
  check(rawText.indexOf(BODY_MARK) < 0, '1. the receipt does not echo the ticket body')
  check(rawText.indexOf(COMMENT_MARK) < 0, '1. the receipt does not echo the comments')
  check(!!r.data && !!r.data.ticket && !('body' in r.data.ticket) && !('comments' in r.data.ticket), '1. data.ticket has no body and no comments')
  check(!!r.data && !!r.data.ticket && Object.keys(r.data.ticket).sort().join(',') === 'effortId,key,title', '1. a progress-only call returns the key, title and effortId and nothing that did not change: ' + JSON.stringify(r.data && r.data.ticket))
  check(!!r.data && !!r.data.ticket && r.data.ticket.key === key && r.data.ticket.title === 'Heavy demo ticket' && r.data.ticket.effortId === 'demo', '1. key, title and effortId are intact for the work route')
  const textItem = ((r.items || []).find((i) => i.step === 'text') || {}) as any
  check(textItem.status === 'ok' && !!textItem.progress && textItem.progress.percent === 80 && textItem.progress.note === 'importer migrated, scheduler next' && ISO_MS.test(String(textItem.progress.updatedAt)), '1. the new progress entry (with the time the tool stamped) is in the text step: ' + JSON.stringify(textItem.progress))
  check(!!r.readBack && Object.keys(r.readBack).sort().join(',') === 'key,state,updatedAt', '1. readBack still carries key, state and updatedAt, so the caller does not need to read again: ' + JSON.stringify(r.readBack))
  check(Array.isArray(r.data && r.data.requested) && r.data.requested.join(',') === 'text', '1. data.requested still names the steps asked for')
  check(seenBytes <= RENDERED_BUDGET_BYTES, '1. what the model sees is at most ' + RENDERED_BUDGET_BYTES + ' B (got ' + seenBytes + ' B)')

  // ── 2. every changed field comes back with its post-write value, unchanged fields do not ──
  const labelArgs = { key: key, addLabels: ['wayfinder:research'] }
  const rl = await patchTool.run(exec, labelArgs)
  check(rl.status === 'ok', '2. adding a label returns ok (got ' + rl.status + ')')
  const labelNames = ((rl.data && rl.data.ticket && rl.data.ticket.labels) || []).map((l) => (l && l.name) || l)
  check(labelNames.indexOf('wayfinder:research') >= 0, '2. the new label list comes back: ' + JSON.stringify(labelNames))
  check(!!rl.data.ticket && !('body' in rl.data.ticket) && !('comments' in rl.data.ticket) && !('createdAt' in rl.data.ticket) && !('url' in rl.data.ticket), '2. a label change does not bring back body, comments or untouched fields')
  const rt = await patchTool.run(exec, { key: key, title: 'Heavy demo ticket, renamed' })
  check(rt.status === 'ok' && rt.data.ticket.title === 'Heavy demo ticket, renamed', '2. a title change comes back with the new title')
  const ra = await patchTool.run(exec, { key: key, assignees: ['someone'] })
  check(ra.status === 'ok' && JSON.stringify(((ra.data.ticket.assignees || []) as any[]).map((a) => (a && a.login) || a)) === '["someone"]', '2. an assignee change comes back with the new assignees: ' + JSON.stringify(ra.data.ticket.assignees))
  const rc = await patchTool.run(exec, { key: key, comment: 'closing remark', close: true })
  check(rc.status === 'ok' && rc.data.ticket.state === 'closed' && rc.readBack.state === 'closed', '2. a close comes back as state closed')
  check(JSON.stringify(rc).indexOf(COMMENT_MARK) < 0 && JSON.stringify(rc).indexOf(BODY_MARK) < 0, '2. the closing receipt carries neither the old comments nor the body')
  const comment = await patchTool.run(exec, { key: key, comment: 'a comment on a closed ticket' })
  check(comment.status === 'ok' && Object.keys(comment.data.ticket).sort().join(',') === 'effortId,key,title', '2. a comment-only call brings back only key, title and effortId: ' + JSON.stringify(comment.data.ticket))

  // ── 3. the pure builder keeps null as null (read-back missing) and never invents fields ──
  const { receiptTicketOf } = await imp('src/deck/tools/issue-patch-receipt.ts')
  const none = { labels: false, assignees: false, text: false, state: false, comment: false }
  check(receiptTicketOf(null, '7', { ...none, labels: true }) === null, '3. no read-back gives null, so the caller can still tell the read-back failed')
  const face = { key: '7', title: 'T', effortId: 'e', labels: ['a'], state: 'open', status: 'claimed', assignees: ['x'], body: 'B', comments: [{ body: 'C' }], url: 'u', createdAt: 'c' }
  check(JSON.stringify(receiptTicketOf(face, '7', none)) === JSON.stringify({ key: '7', title: 'T', effortId: 'e' }), '3. with nothing changed only the identity fields are returned')
  check(JSON.stringify(receiptTicketOf(face, '7', { ...none, labels: true })) === JSON.stringify({ key: '7', title: 'T', effortId: 'e', labels: ['a'], status: 'claimed' }), '3. labels bring labels and the status derived from them')
  check(JSON.stringify(receiptTicketOf(face, '7', { ...none, state: true })) === JSON.stringify({ key: '7', title: 'T', effortId: 'e', state: 'open', status: 'claimed' }), '3. a state change brings state and status')
  check(JSON.stringify(receiptTicketOf({ title: 'T' }, '9', none)) === JSON.stringify({ key: '9', title: 'T' }), '3. a missing key in the read-back falls back to the key of this call')

  // ── 4. data.retry of a status-conflict refusal is exactly as before ──
  const { conflictRefusal } = await imp('src/deck/tools/issue-patch-status.ts')
  const conflict = { field: 'status', visible: 'wontfix', hidden: ['ready-for-agent'], hiddenSource: 'DSH-LABELS', stateFromVisible: 'closed', stateFromHidden: 'open', resolution: { default: 'visible', rule: 'visible-status-wins', action: 'write-visible-status-on-next-write', history: 'DSH-STATUS-HISTORY' } }
  const conflictArgs = { key: '5', addLabels: ['front-end'], comment: 'hello', feature: 'f' }
  const refusal = conflictRefusal('5', conflict, conflictArgs, { requests: 4, points: 8 })
  check(JSON.stringify(refusal.value.data.retry) === JSON.stringify({ tool: 'deck_issue_patch', args: { ...conflictArgs, resolveStatus: 'visible' } }), '4. data.retry is { tool, args + resolveStatus: visible } as before')
  const refusalText = render(conflictArgs, refusal.value).map((b) => b.text).join('\n')
  check(refusalText.indexOf('"retry":{"tool":"deck_issue_patch","args":{"key":"5","addLabels":["front-end"],"comment":"hello","feature":"f","resolveStatus":"visible"}}') >= 0, '4. the rendered refusal still shows data.retry to the model')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) { /* temp dir cleanup is best effort */ }
  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' — ' + total + ' checks')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('FAIL (threw) ' + (e && e.stack || e)); process.exit(1) })
