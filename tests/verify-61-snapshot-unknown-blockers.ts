// tests/verify-61-snapshot-unknown-blockers.ts: a missing `blockedBy` stays unknown through the snapshot assembly (#61).
//
// Why: a Linear child with more than ten inverse relations comes back from the room WITHOUT `blockedBy` on purpose (see `withBlockers`
// in src/tracker/rooms/linear/read.ts): the room did not read the whole list, so it does not know the blockers. The snapshot normaliser
// (`normalizeTicket` in snapshotAssemble.ts) used to turn that missing field into `[]`, which means "confirmed that nothing blocks it",
// and the grouping then counted the child as ready. CODING_STANDARDS.md ("Keep unknown relationships unknown") and PR #60 (which fixed
// the same conversion in prepareRow and in both copies of the grouping) say a missing field is unknown and must count as blocked.
//
//   A. the real working set (real Linear room over a fake channel) -> the real `assembleSnapshot` -> the real `carryOverMapTickets`:
//      the child with eleven open blockers keeps `blockedBy` absent and is NOT ready; a child whose empty relation list was really read
//      keeps its `[]` and IS ready; a child with one open blocker is blocked. The counts the panel shows come out as 1 ready, 2 blocked.
//   B. both copies of the grouping (host and tracker kernel) agree with that on the assembled rows, and an absent field does not throw.
//   C. the other entrances of the normaliser: `normalizeMapTickets` (the library view path) and the merge with the previous rows keep the
//      same distinction, for the numeric keys GitHub uses as well as the text keys of Linear.
// 门禁归属: src/host/tracker/snapshotAssemble.ts
// 门禁归属: src/host/ticketGrouping.ts
// 门禁归属: src/tracker/kernel/grouping.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-61-snapshot-unknown-blockers.ts
import { printGateResult } from './lib/gate-result.ts'
import { assembleWorkingSet } from '../src/host/tracker/snapshotWorkingSet.ts'
import { assembleSnapshot, carryOverMapTickets, normalizeMapTickets, mergeKnownTickets } from '../src/host/tracker/snapshotAssemble.ts'
import { createTicketGrouping } from '../src/host/ticketGrouping.ts'
import { groupTickets as kernelGroupTickets } from '../src/tracker/kernel/grouping.ts'
import { REPO, PARENT, child, fake, trackerOf, show } from './lib/linear-sub-issues-fake.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const open = (ident: string, title: string): any => ({ type: 'blocks', issue: { identifier: ident, title, state: { type: 'unstarted' } } })
// Eleven open relations: more than the page of ten the room reads for each child, so the room leaves blockedBy out.
const eleven = Array.from({ length: 11 }, (_, i) => Object.assign({ id: 'x' + i }, open('ENG-' + (300 + i), 'Blocker ' + i)))
// ENG-101: an empty relation list was read (known empty). ENG-102: eleven open relations (unknown). ENG-103: one open blocker, ENG-101.
const pool = [child(1, { rels: [] }), child(2, { rels: eleven }), child(3, { rels: [Object.assign({ id: 'r1' }, open('ENG-101', 'Child 1'))] })]

// A) real working set -> real assembly -> real first-frame normalisation
const f = fake({ children: { [PARENT]: pool } })
const mapRow = { key: PARENT, type: 'map', state: 'OPEN', title: 'The map', body: '', parentKey: null }
const ws: any = await assembleWorkingSet({ tracker: trackerOf(f), ref: REPO, ctx: f.ctx, pool: [mapRow], openContainers: [mapRow] })
// The rooms give states in lower case; the host upcases them (index.ts upcaseSnapStates) before the panel counts, so the rows are upcased here too.
const childRows: any[] = ws.rows.filter((r: any) => r.parentKey === PARENT).map((r: any) => Object.assign({}, r, { state: String(r.state).toUpperCase() }))
const roomRow = (k: string): any => childRows.find((r: any) => r.key === k)
check(childRows.length === 3 && roomRow('ENG-102') && roomRow('ENG-102').blockedBy === undefined && Array.isArray(roomRow('ENG-101').blockedBy), 'A: the premise holds: the room gives the child with eleven open relations NO blockedBy and the empty one a real [] (got ' + show(childRows.map((r: any) => [r.key, r.blockedBy])) + ')')
const assembled: any = assembleSnapshot(REPO, [mapRow].concat(childRows))
const framed: any = carryOverMapTickets(null, assembled, { sourceComplete: true })
const map: any = framed.maps.find((m: any) => m.key === PARENT)
const tickets: any[] = map ? map.tickets : []
const row = (k: string): any => tickets.find((t: any) => t.key === k)
check(!!map && tickets.length === 3, 'A: the first frame holds the three children under the map (got ' + tickets.length + ')')
check(!!row('ENG-102') && row('ENG-102').blockedBy === undefined, 'A: the child with eleven open blockers keeps blockedBy ABSENT through the assembly: unknown is not "nobody blocks it" (got ' + show(row('ENG-102') && row('ENG-102').blockedBy) + ')')
check(!!row('ENG-101') && Array.isArray(row('ENG-101').blockedBy) && row('ENG-101').blockedBy.length === 0, 'A: the child whose empty relation list was really read keeps its confirmed [] (got ' + show(row('ENG-101') && row('ENG-101').blockedBy) + ')')
check(!!row('ENG-103') && Array.isArray(row('ENG-103').blockedBy) && row('ENG-103').blockedBy.length === 1, 'A: the child with one open blocker keeps that blocker (got ' + show(row('ENG-103') && row('ENG-103').blockedBy) + ')')
check(!!map && map.stats.frontier === 1 && map.stats.blocked === 2, 'A: the snapshot counts one ready child (ENG-101) and two blocked, so the unknown one is not ready (got ' + show(map && { f: map.stats.frontier, b: map.stats.blocked }) + ')')
const levelFrontier = (map ? map.stats.levels : []).reduce((n: number, l: any) => n + l.frontier, 0)
const levelBlocked = (map ? map.stats.levels : []).reduce((n: number, l: any) => n + l.blocked, 0)
check(levelFrontier === 1 && levelBlocked === 2, 'A: the per-level counts of the funnel agree with the totals (got ' + show({ f: levelFrontier, b: levelBlocked }) + ')')

// B) both copies of the grouping, on the assembled rows. They return counts, so the unknown child is grouped on its own as well.
const copies: Array<[string, (rows: any[]) => any]> = [['host', createTicketGrouping().groupTickets], ['kernel', kernelGroupTickets]]
for (const [name, group] of copies) {
  const all = group(tickets)
  check(all.frontier === 1 && all.blocked === 2, 'B: the ' + name + ' grouping counts 1 ready and 2 blocked on the assembled rows (got ' + show({ f: all.frontier, b: all.blocked }) + ')')
  const unknownAlone = group([row('ENG-102')])
  const knownEmptyAlone = group([row('ENG-101')])
  check(unknownAlone.frontier === 0 && unknownAlone.blocked === 1 && knownEmptyAlone.frontier === 1 && knownEmptyAlone.blocked === 0, 'B: the ' + name + ' grouping puts the unknown child in blocked and the confirmed-empty one in ready (got ' + show({ unknown: [unknownAlone.frontier, unknownAlone.blocked], empty: [knownEmptyAlone.frontier, knownEmptyAlone.blocked] }) + ')')
}

// C) the other entrances of the normaliser, with the numeric keys GitHub uses and with the text keys of Linear
const numeric = normalizeMapTickets([
  { key: '1', number: 1, state: 'OPEN', blockedBy: [] },
  { key: '2', number: 2, state: 'OPEN' },
  { key: '3', number: 3, state: 'OPEN', blockedBy: ['1'] },
])
const num = (n: number): any => numeric.tickets.find((t: any) => t.number === n)
check(num(2) && num(2).blockedBy === undefined && num(2).blockedByRefs === undefined, 'C: normalizeMapTickets keeps a missing blockedBy (and the reference table) missing for a numeric key (got ' + show(num(2) && [num(2).blockedBy, num(2).blockedByRefs]) + ')')
check(num(1) && Array.isArray(num(1).blockedBy) && num(1).blockedBy.length === 0, 'C: and a really read [] stays [] (got ' + show(num(1) && num(1).blockedBy) + ')')
check(numeric.stats.frontier === 1 && numeric.stats.blocked === 2, 'C: the counts of that path are 1 ready and 2 blocked (got ' + show({ f: numeric.stats.frontier, b: numeric.stats.blocked }) + ')')
const nullish = normalizeMapTickets([{ key: '4', number: 4, state: 'OPEN', blockedBy: null }, { key: '5', number: 5, state: 'OPEN', blockedBy: 'oops' }])
check(nullish.tickets.every((t: any) => !Array.isArray(t.blockedBy)) && nullish.stats.frontier === 0 && nullish.stats.blocked === 2, 'C: a blockedBy that is not an array (null, a string) is unknown as well: not ready and no throw (got ' + show(nullish.stats && { f: nullish.stats.frontier, b: nullish.stats.blocked }) + ')')
// The merge with the previous rows (partial source) must not invent the field either: nothing known before, nothing known now.
const merged = mergeKnownTickets([{ key: '6', number: 6, state: 'OPEN' }], [{ key: '6', number: 6, state: 'OPEN' }])
check(merged.tickets.length === 1 && merged.tickets[0].blockedBy === undefined, 'C: merging two rows that both lack blockedBy leaves it absent (got ' + show(merged.tickets[0] && merged.tickets[0].blockedBy) + ')')
const carried = carryOverMapTickets(null, { maps: [{ key: '9', number: 9, type: 'map', state: 'OPEN', tickets: [{ key: '7', number: 7, state: 'OPEN' }] }], issues: [], thinTickets: [] }, { sourceComplete: true })
check(carried.maps[0].tickets[0].blockedBy === undefined && carried.maps[0].stats.frontier === 0 && carried.maps[0].stats.blocked === 1, 'C: a map child with no blockedBy is blocked, not ready, in the carried-over snapshot (got ' + show(carried.maps[0].stats && { f: carried.maps[0].stats.frontier, b: carried.maps[0].stats.blocked }) + ')')

printGateResult('verify-61-snapshot-unknown-blockers', assertions, failed)
if (failed) process.exit(1)
