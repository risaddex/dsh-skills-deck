// tests/verify-92-patch-label-step.ts — deck_issue_patch says which step failed when a label cannot be created (#92)
//
// Why this gate exists: #85 made the room mark a refused label creation with the stage `label-create` and
// write the still-missing names into its message, and pinned that at room level (verify-85-linear-label-resolution)
// and at the create receipt (verify-85-label-step-receipt). Nothing pinned the same failure coming out of
// deck_issue_patch, which is the call that replaces the labels of an existing ticket — and there the receipt
// summarized the leading failure with a flat 160-character cut, which lands in the middle of the list of names.
// This gate runs the real tool against a stub tracker that refuses the label write the way the Linear room does
// when the token may not create labels, and pins four things on that receipt:
//   P1  the receipt names the step ("labels") and keeps the stage marker `label-create` next to the error kind;
//   P2  every missing name survives — in `items[].reason` and in the one line `text` gives to the reader;
//   P3  the reason code stays `backend-unsupported` (the next step is to stop and create the labels), and the
//       vocabulary is still the eight codes;
//   P4  nothing is written: the ticket keeps exactly the labels it had, and no other step ran.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-92-patch-label-step.ts
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeDecideStub, chooseWorkspace } from './lib/deck-decide-stub.ts'

const ROOT = path.resolve(process.cwd())
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 600) : '')))
  if (!ok) failed = true
}

// Ten names: more than a 300-character cut can hold, and exactly the case that happened in the `guedder`
// workspace (the whole wayfinder set plus `bug`). The message below is the shape the room writes.
const NAMES = ['bug', 'wayfinder:map', 'wayfinder:research', 'wayfinder:prototype', 'wayfinder:grilling', 'wayfinder:task', 'ready-for-agent', 'ready-for-human', 'needs-triage', 'needs-info']
const LABEL_MESSAGE = 'The step of creating a label failed: the label "bug" was not created (Linear said: not allowed to take action). '
  + 'Missing labels that could not be created: ' + NAMES.map((n) => '"' + n + '"').join(', ') + '. '
  + 'No ticket was created or changed. Create them once in Linear (Settings, Labels, team GUE) and retry.'

/** The ticket the stub tracker holds: one existing label, and the labels call replaces the whole list. */
function stubTicket(): any {
  return { key: '7', title: 'A ticket that needs labels', state: 'open', type: 'issue', labels: [{ name: 'existing', color: '#4EA7FC' }], assignees: [], updatedAt: '2026-11-24T10:00:00Z', closedAt: '', url: '', body: '# A ticket that needs labels\n' }
}

/**
 * A tracker that refuses the label write with the room's label-step failure and remembers every call.
 * `writes` counts the operations that would change the ticket, so "nothing was written" is checkable.
 */
function refusingTracker(): { tracker: any; calls: string[]; ticket: any } {
  const calls: string[] = []
  const ticket = stubTicket()
  const tracker = {
    preflight: async () => ({ ok: true }),
    list: async () => ({ ok: true, data: [] }),
    get: async () => { calls.push('get'); return { ok: true, data: Object.assign({}, ticket, { labels: ticket.labels.slice() }) } },
    getDependencies: async () => ({ ok: true, data: { blockedBy: [], blocking: [] } }),
    create: async () => ({ ok: true, data: ticket }),
    update: async () => { calls.push('update'); return { ok: true, data: ticket } },
    comment: async () => { calls.push('comment'); return { ok: true, data: { key: '7' } } },
    close: async () => { calls.push('close'); return { ok: true, data: ticket } },
    reopen: async () => { calls.push('reopen'); return { ok: true, data: ticket } },
    setLabels: async () => { calls.push('setLabels'); return { ok: false, error: { kind: 'auth', message: LABEL_MESSAGE, raw: 'not allowed to take action', stage: 'label-create' } } },
    setAssignees: async () => { calls.push('setAssignees'); return { ok: true, data: ticket } },
    setParent: async () => { calls.push('setParent'); return { ok: true, data: ticket } },
    setBlockedBy: async () => { calls.push('setBlockedBy'); return { ok: true, data: ticket } },
  }
  return { tracker, calls, ticket }
}

function stubRegistry(tracker: unknown): any {
  return {
    select: async () => ({ backendId: 'stub', source: 'explicit', ref: { backend: 'stub', refId: 'o/n', name: 'o/n', url: '' }, pending: false }),
    get: () => tracker,
    has: () => true,
    modules: () => [{ id: 'stub', budget: { kind: 'off-network', countsRequests: false, countsPoints: false, independentBuckets: false } }],
    describe: () => ({ backend: 'stub', refId: 'o/n', name: 'o/n', url: '' }),
  }
}

async function main(): Promise<void> {
  console.log('deck_issue_patch receipt for a refused label creation (#92)')
  const budget = await imp('src/refresh/kernel/host-budget.js')
  const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
  const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
  const clock = { now: 1700000000000 }
  const ledger = ledgerMod.createLedger({ now: () => clock.now })
  const gate = gateMod.createGate({ ledger: ledger, now: () => clock.now })
  ledger.ensureBackend('github', { kind: 'two-buckets' })
  ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock.now + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock.now + 3600000 } }, clock.now)

  const { tracker, calls, ticket } = refusingTracker()
  const registry = stubRegistry(tracker)
  chooseWorkspace('D:/demo', 'stub')
  const deps = {
    estimate: () => ({ points: 1, requests: 1, tickets: 0, withinCallCap: true, shards: 1, perShard: 60, text: '' }),
    costInputFrom: () => ({ tool: 't' }),
    backendCtx: {},
    handleFor: () => ({ cwd: 'D:/demo' }),
    log: null,
    now: () => clock.now,
    gate: gate,
    registry: registry,
    budget: budget,
    decideBackend: makeDecideStub(registry),
    toolTimeoutMs: 5000,
    toolMarginMs: 500,
  }
  const tool = (await imp('src/deck/tools/issue-patch.ts')).createDeckIssuePatch(deps)
  const exec = { agent: { session: { id: 's-92-patch-label-step', cwd: 'D:/demo' } } }

  // The call a person or an agent makes: put these labels on an existing ticket.
  const r: any = await tool.run(exec, { key: '7', addLabels: ['bug', 'ready-for-agent'] })
  const text = String((r && r.text) || '')
  const labelItem: any = ((r && r.items) || []).filter((i: any) => i && i.step === 'labels')[0] || {}

  console.log('P1 the receipt names the step and keeps the stage marker')
  {
    check(!!r && r.status === 'unsupported', 'the call did not go through (status ' + (r && r.status) + ')', r && r.status)
    check(!!labelItem && labelItem.status === 'failed' && labelItem.step === 'labels', 'the failed step is named "labels"', JSON.stringify(labelItem))
    check(labelItem.stage === 'label-create', 'the failure evidence keeps the label-create marker', JSON.stringify(labelItem))
    check(labelItem.errorKind === 'auth', 'and the room kind is still auth', JSON.stringify(labelItem))
    check(String(labelItem.code) === 'backend-unsupported' && r.reason === 'backend-unsupported', 'the reason code is backend-unsupported (the next step is to stop)', JSON.stringify({ code: labelItem.code, reason: r.reason }))
    check(text.indexOf('"labels"') >= 0, 'the one line given to the reader names the step too', text)
  }

  console.log('P2 every missing name survives in the receipt')
  {
    check(LABEL_MESSAGE.length > 300, 'the probe message is longer than a 300-character cut', String(LABEL_MESSAGE.length))
    check(NAMES.every((n) => String(labelItem.reason || '').indexOf('"' + n + '"') >= 0), 'the item reason keeps every missing name', labelItem.reason)
    check(NAMES.every((n) => text.indexOf('"' + n + '"') >= 0), 'the text line keeps every missing name as well', text)
    check(text.indexOf('not allowed to take action') >= 0, "Linear's own words are in it", text)
    check(text.indexOf('Settings, Labels') >= 0, 'and the place to create the labels is in it', text)
  }

  console.log('P3 the step marker and the error table are unchanged')
  {
    const { REFUSAL_REASONS } = await imp('src/deck/shell/call-shell.ts')
    const { reasonForFailure } = await imp('src/deck/shell/receipt-reason.ts')
    check(Object.keys(REFUSAL_REASONS).length === 8, 'the reason vocabulary still has eight codes', String(Object.keys(REFUSAL_REASONS).length))
    for (const kind of ['env', 'auth', 'rate-limit', 'conflict', 'unsupported', 'not-found', 'network', 'parse', 'timeout', 'aborted', 'over-budget', 'backend-threw']) {
      check(reasonForFailure({ phase: 'write', kind, stage: 'label-create' }) === reasonForFailure({ phase: 'write', kind }), 'write phase, kind ' + kind + ': the same code with and without the marker')
    }
  }

  console.log('P4 nothing was written to the ticket')
  {
    check(calls.filter((c) => c === 'setLabels').length === 1, 'the label write was attempted exactly once', JSON.stringify(calls))
    check(calls.indexOf('update') < 0 && calls.indexOf('comment') < 0 && calls.indexOf('close') < 0, 'no other write ran', JSON.stringify(calls))
    check(calls.indexOf('setAssignees') < 0 && calls.indexOf('setParent') < 0 && calls.indexOf('setBlockedBy') < 0, 'no other step of the tool ran', JSON.stringify(calls))
    check(ticket.labels.length === 1 && ticket.labels[0].name === 'existing', 'the ticket still carries exactly the label it had', JSON.stringify(ticket.labels))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('gate threw: ' + ((e && e.stack) || e)); process.exit(1) })
