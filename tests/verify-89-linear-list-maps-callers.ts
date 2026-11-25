// tests/verify-89-linear-list-maps-callers.ts: the acceptance of #89 end to end, over the REAL Linear room (every operation real; only the HTTP
// channel is the fake one, because the deck's budget shell does not carry one). Before the fix `deck_context` answered partial with `maps: []` and
// `deck_issue_list` for the maps answered unsupported, because both fell back to `list(repo, { type: 'map' })`, which this room refuses. Asserts:
//   F1. `deck_context` on a Linear workspace answers ok, lists the maps (closed one included, newest update first) and carries no partial marker;
//   F2. `deck_issue_list` for the maps (type=map with the map label, the filter the router sends down the thin path) returns the rows, and its
//       state filter works;
//   F3. a list cut by the page cap is reported in words, without claiming a total Linear never gave ("out of N" would say the same number twice).
//   F4. `deck_issue_list` with `type=map` and NO label filter (the router keeps that on the old full path on purpose) answers ok too, because the
//       room's `list` turns `type: 'map'` into the map label (the maintainer's decision on the ticket); `type=spec` is still refused.
// The room itself (request, walk, cap, failure classes) is in tests/verify-89-linear-list-maps.ts.
// 门禁归属: src/tracker/rooms/linear/read.ts
// 门禁归属: src/deck/tools/context.ts
// 门禁归属: src/deck/tools/issue-list.ts
// 门禁归属: src/tracker/rooms/linear/maps.ts
// 门禁归属: src/tracker/rooms/linear/index.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-89-linear-list-maps-callers.ts
import { printGateResult } from './lib/gate-result.ts'
import { createDeckIssueList } from '../src/deck/tools/issue-list.ts'
import { createDeckContext } from '../src/deck/tools/context.ts'
import { createRegistry } from '../src/tracker/registry/core.ts'
import { createGate } from '../src/refresh/rooms/host/refresh-gate.ts'
import { createLedger } from '../src/refresh/rooms/host/quota-ledger.ts'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.ts'
import { buildIssuesFilter } from '../src/tracker/rooms/linear/read.ts'
import { chooseWorkspace, makeDecideStub } from './lib/deck-decide-stub.ts'
import { ACCOUNT, CAP_ROWS, node, maps, fake, show } from './lib/linear-maps-fake.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

// F) the acceptance of the ticket: the two tools an agent uses, over the REAL Linear room (every operation real; only the HTTP channel is the fake one,
// because the deck's budget shell does not carry one). Before the fix `deck_context` answered partial with `maps: []` and `deck_issue_list type=map`
// answered unsupported, because both fell back to `list(repo, { type: 'map' })`, which this room refuses.
{
  const f = fake({ tickets: [node(1), node(2, { closed: true }), node(3), node(900, { isMap: false })] })
  const backendId = 'linear-89-probe'
  const cwd = '/virtual/linear-89-maps'
  const registry = createRegistry({} as never)
  registry.register({
    id: backendId, label: 'Linear (#89 probe)', matches: () => false,
    budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
    describe: () => ({ backend: backendId, refId: 'fixture', name: 'fixture', url: '' }),
    create: () => {
      const real: any = createLinearBackend(f.ctx, ACCOUNT)
      const withHttp: any = { ...real, id: backendId }
      // every real operation, called with the fake channel in place of the deck's own context
      for (const op of Object.keys(real)) if (typeof real[op] === 'function' && op !== 'id') withHttp[op] = (...args: any[]) => real[op](...args.slice(0, -1), f.ctx)
      withHttp.preflight = async () => ({ ok: true })
      withHttp.getRepoPermissions = async () => ({ ok: true, data: { push: true, triage: true } })
      return withHttp
    },
  } as never)
  chooseWorkspace(cwd, backendId)
  const clock = 1700000000000
  const ledger = createLedger({ now: () => clock })
  const model = { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false }
  const gate = createGate({ ledger, now: () => clock, budgetModelOf: () => model } as never)
  const deps: any = {
    registry, gate, now: () => clock, backendCtx: {}, handleFor: () => ({ cwd }),
    decideBackend: makeDecideStub(registry), log: { fire: () => {} },
    getCachedReading: async () => ({ known: false, reason: 'not-measured' }),
    admit: async () => ({ allowed: true, reason: 'test-read' }), accountPort: async () => {},
  }
  const exec = { agent: { session: { id: 'maps-89', cwd } } }
  const context: any = await createDeckContext(deps).run(exec, {})
  check(context.status === 'ok', 'F: deck_context on a Linear workspace answers ok, no longer partial (got status ' + show(context.status) + ', reason ' + show(context.reason) + ', text ' + show(String(context.text || '').slice(0, 160)) + ')')
  check(Array.isArray(context.data && context.data.maps) && show(context.data.maps.map((m: any) => m.key)) === show(['ENG-3', 'ENG-2', 'ENG-1']), 'F: and it lists the maps, closed one included, newest update first (got ' + show(context.data && context.data.maps) + ')')
  check(!(context.data && (context.data.partial === true || context.data.incomplete)), 'F: and carries neither the partial flag nor an incomplete marker (got ' + show(context.data && { p: context.data.partial, i: context.data.incomplete }) + ')')
  // the map filter the router sends down the thin path: the map label (see shouldUseThinMapList; `type=map` alone is not a label filter)
  const MAP_FILTER = { type: 'map', labels: ['wayfinder:map'] }
  const listed: any = await createDeckIssueList(deps).run(exec, { ...MAP_FILTER, state: 'all' })
  check(listed.status === 'ok', 'F: deck_issue_list for the maps (type=map with the map label) on a Linear workspace answers ok instead of unsupported (got status ' + show(listed.status) + ', text ' + show(String(listed.text || '').slice(0, 160)) + ')')
  const rows: any[] = (listed.data && listed.data.issues) || []
  check(show(rows.map((r: any) => String(r.key)).sort()) === show(['ENG-1', 'ENG-2', 'ENG-3']), 'F: and returns the map rows, not an empty list (got ' + show(rows.map((r: any) => r.key)) + ')')
  // `type=map` WITHOUT the label: the router keeps it on the old full path (tests/verify-1604-pure-map-routing.ts pins that), so the room's own `list`
  // must express the type. The maintainer's decision on the ticket: it returns rows too.
  const before = f.bodies.length
  const typeOnly: any = await createDeckIssueList(deps).run(exec, { type: 'map', state: 'all' })
  check(typeOnly.status === 'ok', 'F: deck_issue_list with type=map and NO label filter answers ok too: the room turns the type into the map label (got status ' + show(typeOnly.status) + ', text ' + show(String(typeOnly.text || '').slice(0, 160)) + ')')
  check(show(((typeOnly.data && typeOnly.data.issues) || []).map((r: any) => String(r.key)).sort()) === show(['ENG-1', 'ENG-2', 'ENG-3']), 'F: and returns the maps only, not the ordinary ticket (got ' + show(((typeOnly.data && typeOnly.data.issues) || []).map((r: any) => r.key)) + ')')
  const sentFilter: any = f.bodies.length > before ? f.bodies[f.bodies.length - 1].variables.filter : null
  check(show(sentFilter && sentFilter.labels) === show({ some: { name: { eqIgnoreCase: 'wayfinder:map' } } }), 'F: what leaves for Linear is the label condition on wayfinder:map, once (got ' + show(sentFilter) + ')')
  check(show(buildIssuesFilter({ type: 'map', labels: ['WayFinder:Map'] })) === show(buildIssuesFilter({ labels: ['WayFinder:Map'] })), 'F: asking for the type and the label together is one condition, not two (the same name in another spelling is not added twice)')
  check(show(buildIssuesFilter({ type: 'map', labels: ['bug'], state: 'closed' })) === show({ state: { type: { in: ['completed', 'canceled', 'duplicate'] } }, labels: { and: [{ some: { name: { eqIgnoreCase: 'bug' } } }, { some: { name: { eqIgnoreCase: 'wayfinder:map' } } }] } }), 'F: next to other labels and a state the map label is one more AND condition')
  const specRefused: any = await createDeckIssueList(deps).run(exec, { type: 'spec', state: 'all' })
  check(specRefused.status === 'unsupported', 'F: type=spec is still refused here: only the map type is a label, a spec is told apart by a marker in its body (got status ' + show(specRefused.status) + ')')
  const openOnly: any = await createDeckIssueList(deps).run(exec, { ...MAP_FILTER, state: 'open' })
  check(show(((openOnly.data && openOnly.data.issues) || []).map((r: any) => String(r.key)).sort()) === show(['ENG-1', 'ENG-3']), 'F: and state=open keeps the open maps only (got ' + show(((openOnly.data && openOnly.data.issues) || []).map((r: any) => r.key)) + ')')
}
{
  // a list that hit the cap says so, in words, and without a self-contradicting total
  const f = fake({ tickets: maps(CAP_ROWS + 5) })
  const backendId = 'linear-89-probe-capped'
  const cwd = '/virtual/linear-89-maps-capped'
  const registry = createRegistry({} as never)
  registry.register({
    id: backendId, label: 'Linear (#89 capped probe)', matches: () => false,
    budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
    describe: () => ({ backend: backendId, refId: 'fixture', name: 'fixture', url: '' }),
    create: () => {
      const real: any = createLinearBackend(f.ctx, ACCOUNT)
      return { ...real, id: backendId, preflight: async () => ({ ok: true }), getRepoPermissions: async () => ({ ok: true, data: { push: true, triage: true } }), listMaps: (repo: any) => real.listMaps(repo, f.ctx) }
    },
  } as never)
  chooseWorkspace(cwd, backendId)
  const clock = 1700000000000
  const gate = createGate({ ledger: createLedger({ now: () => clock }), now: () => clock, budgetModelOf: () => ({ kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false }) } as never)
  const deps: any = {
    registry, gate, now: () => clock, backendCtx: {}, handleFor: () => ({ cwd }),
    decideBackend: makeDecideStub(registry), log: { fire: () => {} },
    getCachedReading: async () => ({ known: false, reason: 'not-measured' }),
    admit: async () => ({ allowed: true, reason: 'test-read' }), accountPort: async () => {},
  }
  const exec = { agent: { session: { id: 'maps-89-capped', cwd } } }
  const context: any = await createDeckContext(deps).run(exec, {})
  const note: string = ((context.notes || []) as string[]).find((n) => n.startsWith('Only the first')) || ''
  check(context.status === 'ok' && note.length > 0, 'F: a Linear workspace with more maps than the cap still answers ok, and a note says the list was cut (got status ' + show(context.status) + ', note ' + show(note) + ')')
  check(note.includes(String(CAP_ROWS)) && !/out of\s+\d+/.test(note), 'F: the note says how many came back and does not claim a total Linear never gave ("out of N" would be the same number twice) (got ' + show(note) + ')')
  const listed: any = await createDeckIssueList(deps).run(exec, { type: 'map', labels: ['wayfinder:map'], state: 'all', limit: 200 })
  const listNote: string = ((listed.notes || []) as string[]).find((n) => n.startsWith('Only the first') && n.includes('maps came back')) || ''
  check(listNote.length > 0 && !/out of\s+\d+/.test(listNote), 'F: deck_issue_list says the same without the self-contradicting total (got ' + show(listNote) + ')')
}

printGateResult('verify-89-linear-list-maps-callers', assertions, failed)
if (failed) process.exit(1)
