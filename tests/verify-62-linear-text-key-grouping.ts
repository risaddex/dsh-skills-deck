// tests/verify-62-linear-text-key-grouping.ts: rows that have only a text key (Linear's ENG-101) must keep their own identity in the grouping (PR #62 review).
//
// The room's rows carry `key: 'ENG-101'` and no `number` (the contract's Issue has no such field, and `parseInt('ENG-101')` is NaN). Both copies of the
// grouping indexed and memoised by `t.number`, so every Linear child shared the one `undefined` entry: the blocker lookup never found a sibling and
// two children where ENG-102 is blocked by ENG-101 came out as ONE level holding two `undefined` numbers and `levelOf: { "undefined": 0 }`.
// This gate pushes such children through the REAL `wf.mapTickets` phone (over the fake Linear channel of tests/lib/linear-sub-issues-fake.ts) and
// through BOTH real copies of the grouping, and asserts:
//   A. ENG-102 blocked by an open ENG-101: two levels, ENG-101 in the frontier, ENG-102 blocked, levelOf keyed by the text keys, no `undefined` anywhere;
//   B. the same pair with ENG-101 closed: ENG-102 is ready, still two levels;
//   C. the snapshot path (`normalizeMapTickets`, which also leaves a text-key row without a number) gets the same stats from the shared grouping;
//   D. numeric rooms (GitHub #11, #12 and the plain number fixture) behave exactly as before: numbers stay numbers in `levels[].numbers`, and the
//      two copies of the grouping agree.
// 门禁归属: src/host/mapTickets.ts
// 门禁归属: src/host/ticketGrouping.ts
// 门禁归属: src/tracker/kernel/grouping.ts
// 门禁归属: src/host/tracker/snapshotAssemble.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-62-linear-text-key-grouping.ts
import { printGateResult } from './lib/gate-result.ts'
import { createMapTickets } from '../src/host/mapTickets.ts'
import { createSessionLifecycle } from '../src/host/sessionLifecycle.ts'
import { createTicketGrouping } from '../src/host/ticketGrouping.ts'
import { normalizeMapTickets } from '../src/host/tracker/snapshotAssemble.ts'
import { groupTickets as kernelGroupTickets } from '../src/tracker/kernel/grouping.ts'
import { PARENT, REPO, child, fake, trackerOf, list, show } from './lib/linear-sub-issues-fake.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const grouping = createTicketGrouping()
const life: any = createSessionLifecycle({})
const phoneOf = (backendId: string, tracker: any, linearFake?: any): any => createMapTickets({
  canonicalKey: async (c: any) => c || '/ws/fake', selectEarly: async () => ({ backendId }), isComposerSelection: life.isComposerSelection,
  getTrackerRegistry: async () => ({ get: () => tracker, describe: () => REPO }),
  getPlatform: async () => ({}), ctx: { get: () => undefined }, DEFAULT_CWD: '/ws/fake', logCtx: null,
  groupTickets: grouping.groupTickets, getMapBody: async () => null, detectionExec: () => {},
  ...(linearFake ? { openSession: async () => ({ ok: true, backendId: 'linear', call: async (fn: any) => fn(tracker, Object.assign({}, linearFake.ctx)) }) } : {}),
})
const relation = (ident: string, type: string): any => ({ id: 'r-' + ident, type: 'blocks', issue: { identifier: ident, title: 'Blocker ' + ident, state: { type } } })
// levelOf is an object keyed by identity; the order the rows came in must not matter, so compare it with sorted keys.
const sameMap = (actual: any, expected: Record<string, number>): boolean => show(Object.keys(actual || {}).sort().map((k) => [k, actual[k]])) === show(Object.keys(expected).sort().map((k) => [k, expected[k]]))
const layerSummary = (stats: any): string => show((stats.levels || []).map((l: any) => ({ level: l.level, numbers: l.numbers, frontier: l.frontier, blocked: l.blocked, closed: l.closed })))

// A) + B) + C): ENG-102 is blocked by ENG-101, once with ENG-101 open and once with it closed.
for (const scenario of [{ name: 'A', blockerState: 'unstarted', blockerClosed: false }, { name: 'B', blockerState: 'completed', blockerClosed: true }]) {
  const first = child(1, { rels: [], state: { name: scenario.blockerClosed ? 'Done' : 'Todo', type: scenario.blockerState } })
  const pool = [first, child(2, { rels: [relation('ENG-101', scenario.blockerState)] })]
  const f = fake({ children: { [PARENT]: pool } })
  const got: any = await phoneOf('linear', trackerOf(f), f).handleMapTickets({ cwd: '/ws/fake', key: PARENT })
  const tag = scenario.name + ': ' + (scenario.blockerClosed ? 'ENG-101 closed' : 'ENG-101 open')
  check(got.ok === true && got.items.length === 2 && got.items.every((r: any) => r.number === undefined && /^ENG-10[12]$/.test(r.key)), tag + ': the real phone answers two rows that have a text key and no number (got ' + (got.ok ? show(got.items.map((r: any) => [r.key, r.number])) : show(got.error)) + ')')
  const stats = got.ok ? got.stats : null
  check(!!stats && stats.levels.length === 2, tag + ': the phone stats have TWO dependency levels, not one shared undefined entry (got ' + (stats ? layerSummary(stats) : 'no stats') + ')')
  check(!!stats && show(stats.levels.map((l: any) => l.numbers)) === show([['ENG-101'], ['ENG-102']]), tag + ': each level lists its own text key, ENG-101 first (got ' + (stats ? layerSummary(stats) : 'no stats') + ')')
  check(!!stats && sameMap(stats.levelOf, { 'ENG-101': 0, 'ENG-102': 1 }), tag + ': levelOf is keyed by the text keys with depths 0 and 1 (got ' + (stats ? show(stats.levelOf) : 'no stats') + ')')
  check(!!stats && !show(stats).includes('undefined'), tag + ': the word undefined appears nowhere in the stats')
  if (scenario.blockerClosed) {
    check(!!stats && stats.open === 1 && stats.closed === 1 && stats.frontier === 1 && stats.blocked === 0 && stats.levels[1]?.frontier === 1, tag + ': ENG-102 is ready, the only open child and in the frontier (got ' + show(stats && { o: stats.open, c: stats.closed, f: stats.frontier, b: stats.blocked }) + ')')
    check(!!stats && stats.levels[0]?.closed === 1 && stats.levels[0]?.frontier === 0, tag + ': level 0 holds the closed ENG-101 and no frontier')
  } else {
    check(!!stats && stats.open === 2 && stats.frontier === 1 && stats.blocked === 1 && stats.levels[0]?.frontier === 1 && stats.levels[1]?.blocked === 1 && stats.levels[1]?.frontier === 0, tag + ': ENG-101 (level 0) is the frontier and ENG-102 (level 1) is blocked (got ' + show(stats && { f: stats.frontier, b: stats.blocked }) + ')')
  }
  const kernel: any = got.ok ? kernelGroupTickets(got.items) : null
  check(!!kernel && show(kernel) === show(stats), tag + ': the other copy of the grouping (tracker kernel) gives byte-for-byte the same stats for the same rows')
  if (scenario.name === 'A') {
    // C) the snapshot path: the rows of the room go through normalizeMapTickets, which also leaves a text-key row without a number.
    const raw: any = await list(fake({ children: { [PARENT]: pool } }))
    // The room answers lower-case states and the host upper-cases them (upcaseSnapStates) before the grouping counts open and closed, so do the same here.
    const snap: any = raw.ok ? normalizeMapTickets(raw.data.items.map((r: any) => Object.assign({}, r, { state: String(r.state).toUpperCase() }))) : null
    check(!!snap && snap.tickets.every((t: any) => t.number === undefined), 'C: the snapshot normalisation gives a Linear row no number either, so it depends on the same grouping identity (got ' + show(snap && snap.tickets.map((t: any) => [t.key, t.number])) + ')')
    check(!!snap && snap.stats.levels.length === 2 && sameMap(snap.stats.levelOf, { 'ENG-101': 0, 'ENG-102': 1 }) && snap.stats.frontier === 1 && snap.stats.blocked === 1, 'C: and the snapshot stats get two levels, one ready and one blocked child (got ' + show(snap && { l: layerSummary(snap.stats), o: snap.stats.levelOf }) + ')')
  }
}

// D) numeric rooms: nothing moves.
{
  const gh: any = { listSubIssues: async () => ({ ok: true, data: { items: [
    { key: '11', title: 'Eleven', state: 'open', blockedBy: [] },
    { key: '12', title: 'Twelve', state: 'open', blockedBy: ['11'] },
  ], total: 2, fetched: 2, capped: false, missing: 0, dropped: 0 } }) }
  const got: any = await phoneOf('github', gh).handleMapTickets({ cwd: '/ws/fake', key: '7' })
  const stats = got.ok ? got.stats : null
  check(got.ok === true && got.items.every((r: any) => typeof r.number === 'number'), 'D: a GitHub-style room still gets real numbers on its rows (got ' + (got.ok ? show(got.items.map((r: any) => r.number)) : show(got.error)) + ')')
  check(!!stats && show(stats.levelOf) === show({ '11': 0, '12': 1 }) && show(stats.levels.map((l: any) => l.numbers)) === show([[11], [12]]) && stats.levels.every((l: any) => l.numbers.every((n: any) => typeof n === 'number')), 'D: levelOf keys and level numbers are the same numbers as before, still of type number (got ' + (stats ? layerSummary(stats) + show(stats.levelOf) : 'no stats') + ')')
  check(!!stats && stats.frontier === 1 && stats.blocked === 1 && stats.levels[0]?.frontier === 1 && stats.levels[1]?.blocked === 1, 'D: and the same frontier and blocked counts (got ' + show(stats && { f: stats.frontier, b: stats.blocked }) + ')')
  const fixture: any[] = [
    { number: 1, state: 'OPEN', claimedBy: '', blockedBy: [] },
    { number: 2, state: 'OPEN', claimedBy: 'A', blockedBy: [1] },
    { number: 3, state: 'OPEN', claimedBy: '', blockedBy: [2] },
    { number: 4, state: 'OPEN', claimedBy: '', blockedBy: [1] },
    { number: 5, state: 'CLOSED', claimedBy: '', blockedBy: [3] },
  ]
  const host = grouping.groupTickets(fixture)
  const kernel = kernelGroupTickets(fixture)
  check(show(host.levelOf) === show({ '1': 0, '2': 1, '3': 2, '4': 1, '5': 3 }) && show(host.levels.map((l: any) => l.numbers)) === show([[1], [2, 4], [3], [5]]), 'D: the plain number fixture keeps its exact levelOf and number lists (got ' + show({ o: host.levelOf, n: host.levels.map((l: any) => l.numbers) }) + ')')
  check(host.total === 5 && host.open === 4 && host.closed === 1 && host.frontier === 1 && host.claimed === 1 && host.blocked === 2, 'D: and the same five counts')
  check(show(host) === show(kernel), 'D: the two copies of the grouping agree on the number fixture')
}

printGateResult('verify-62-linear-text-key-grouping', assertions, failed)
if (failed) process.exit(1)
