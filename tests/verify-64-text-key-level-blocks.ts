// tests/verify-64-text-key-level-blocks.ts: a Linear child has a text key and no number, so the snapshot code must still give it its per-row
// `level` and fill the `blocks` side of its blocker (#64, follow-up of the grouping fix in PR #62).
//
// Before the fix the snapshot code read the identity of a row from `number` only: `normalizeMapTickets` (src/host/tracker/snapshotAssemble.ts)
// looked blockers up in a table keyed by `String(t.number)` and read `stats.levelOf[String(t.number)]`, and the two phone files
// (src/refresh/rooms/host/session-snapshot-cache.ts and session-refresh-schedule.ts) read `lvInfo.byNumber[t.number]` with a `byKey` fallback
// that no grouping produces. So ENG-101 and ENG-102 (ENG-102 blocked by ENG-101) came out with no `level` and no `blocks`.
// This gate sends such rows through the REAL snapshot composer (real Linear room rows over the fake Linear channel), and through the real
// `wf.snapshot` and `wf.refresh` rooms, and asserts:
//   A. the composer: ENG-101 is level 0 and its `blocks` lists ENG-102, ENG-102 is level 1 and blocks nobody; `blockedBy` is unchanged;
//   B. the snapshot rooms (snapshot, refresh, and the snapshot fallback branch) take the per-row level from the grouping result keyed by the
//      row identity: the grouping is replaced by a stub that answers distinct depths so a room that never reads the text key shows as red;
//   C. numeric rooms behave exactly as before: numbers stay numbers in `blocks`, levels are the same, the real grouping gives the same answer;
//   D. the identity rule is written once (exported by the tracker kernel grouping) and both copies of the grouping answer with the same key,
//      and the three snapshot files use that one rule instead of reading `number` themselves.
// 门禁归属: src/host/tracker/snapshotAssemble.ts
// 门禁归属: src/refresh/rooms/host/session-snapshot-cache.ts
// 门禁归属: src/refresh/rooms/host/session-refresh-schedule.ts
// 门禁归属: src/tracker/kernel/grouping.ts
// 门禁归属: src/host/ticketGrouping.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-64-text-key-level-blocks.ts
import fs from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { printGateResult } from './lib/gate-result.ts'
import { createSnapshotComposer } from '../src/host/tracker/snapshot.ts'
import { normalizeMapTickets } from '../src/host/tracker/snapshotAssemble.ts'
import { createTicketGrouping } from '../src/host/ticketGrouping.ts'
import { createSnapshotEnvelope } from '../src/host/snapshotEnvelope.ts'
import { createSessionSnapshot } from '../src/refresh/rooms/host/session-snapshot-cache.ts'
import { createSessionRefresh } from '../src/refresh/rooms/host/session-refresh-schedule.ts'
import * as kernelGrouping from '../src/tracker/kernel/grouping.ts'
import { PARENT, REPO, child, fake, trackerOf, show } from './lib/linear-sub-issues-fake.ts'

const ROOT = nodePath.resolve(import.meta.dirname, '..')
let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const relation = (ident: string): any => ({ id: 'r-' + ident, type: 'blocks', issue: { identifier: ident, title: 'Blocker ' + ident, state: { type: 'unstarted' } } })
const mapRow = (key: string, extra: any = {}): any => Object.assign({ key, effortId: '', type: 'map', title: 'Map ' + key, state: 'open', body: '', parentKey: null, labels: [], assignees: [] }, extra)

// A Linear map whose children are the REAL rows of the real Linear room: ENG-101, and ENG-102 blocked by ENG-101.
function linearTracker(): any {
  const f = fake({ children: { [PARENT]: [child(1, { rels: [] }), child(2, { rels: [relation('ENG-101')] })] } })
  const room: any = trackerOf(f)
  return {
    list: async () => ({ ok: true, data: [mapRow(PARENT)] }),
    counts: async () => ({ ok: false, error: { kind: 'unsupported' } }),
    listSubIssues: (ref: any, key: any, o: any, c: any) => room.listSubIssues(ref, key, o, f.ctx),
  }
}
const byKeyOf = (rows: any[], key: string): any => (rows || []).find((r: any) => r && String(r.key) === key)

// ───────── A. the real composer ─────────
{
  const tracker = linearTracker()
  const reg: any = { get: () => tracker, describe: () => REPO, modules: () => [] }
  const res: any = await createSnapshotComposer(reg).composeSnapshot('linear', REPO, {}, { force: true })
  const m: any = res.ok ? (res.snapshot.maps || [])[0] : null
  const tickets: any[] = m ? m.tickets : []
  const a = byKeyOf(tickets, 'ENG-101')
  const b = byKeyOf(tickets, 'ENG-102')
  check(res.ok === true && !!m && tickets.length === 2 && tickets.every((t: any) => t.number === undefined), 'A: the real composer answers the Linear map with two children that have a text key and no number (got ' + show(res.ok ? tickets.map((t: any) => [t.key, t.number]) : res.error) + ')')
  check(!!a && a.level === 0, 'A: ENG-101 (blocker) is at level 0 (got ' + show(a && a.level) + ')')
  check(!!b && b.level === 1, 'A: ENG-102 (blocked by ENG-101) is at level 1 (got ' + show(b && b.level) + ')')
  check(!!a && show(a.blocks) === show(['ENG-102']), 'A: ENG-101 lists ENG-102 in its blocks (got ' + show(a && a.blocks) + ')')
  check(!!b && show(b.blocks) === show([]), 'A: ENG-102 blocks nobody (got ' + show(b && b.blocks) + ')')
  check(!!b && show(b.blockedBy) === show(['ENG-101']), 'A: the blockedBy of ENG-102 is untouched (got ' + show(b && b.blockedBy) + ')')
  check(!!m && show(m.stats.levels.map((l: any) => l.numbers)) === show([['ENG-101'], ['ENG-102']]) && show(Object.keys(m.stats.levelOf).sort().map((k: string) => [k, m.stats.levelOf[k]])) === show([['ENG-101', 0], ['ENG-102', 1]]), 'A: the stats of the map (already right since PR #62) still list both levels by text key (got ' + (m ? show(m.stats.levelOf) : 'no map') + ')')
  // A blocker that is not in the batch must not invent a blocks entry on any row.
  const odd: any = normalizeMapTickets([{ key: 'ENG-1', blockedBy: ['ENG-9'] }, { key: 'ENG-2', blockedBy: [] }])
  check(odd.tickets.every((t: any) => show(t.blocks) === show([])), 'A: a blocker outside the batch adds nothing to any blocks list (got ' + show(odd.tickets.map((t: any) => [t.key, t.blocks])) + ')')
}

// ───────── C. numeric rooms stay exactly as before ─────────
{
  const rows: any[] = [
    { key: '11', title: 'Eleven', state: 'OPEN', blockedBy: [] },
    { key: '12', title: 'Twelve', state: 'OPEN', blockedBy: [11] },
    { key: '13', title: 'Thirteen', state: 'OPEN', blockedBy: [{ key: '11' }, '12'] },
  ]
  const got: any = normalizeMapTickets(rows)
  const t11 = byKeyOf(got.tickets, '11')
  const t12 = byKeyOf(got.tickets, '12')
  const t13 = byKeyOf(got.tickets, '13')
  check(got.tickets.every((t: any) => typeof t.number === 'number'), 'C: numeric rows still get a real number')
  check(show(t11.blocks) === show([12, 13]) && t11.blocks.every((n: any) => typeof n === 'number'), 'C: the blocks of a numeric row are numbers in the order the rows came (got ' + show(t11.blocks) + ')')
  check(show(t12.blocks) === show([13]) && show(t13.blocks) === show([]), 'C: 12 blocks 13 and 13 blocks nobody (got ' + show([t12.blocks, t13.blocks]) + ')')
  check(t11.level === 0 && t12.level === 1 && t13.level === 2, 'C: levels are 0, 1, 2 as before (got ' + show([t11.level, t12.level, t13.level]) + ')')
}

// ───────── B. the snapshot rooms: wf.snapshot, wf.refresh and the snapshot fallback ─────────
// The grouping is a stub that answers fixed depths keyed the way the real grouping keys them (the row identity), so the room's own lookup is what is tested.
const STUB_LEVELS: Record<string, number> = { 'ENG-101': 7, 'ENG-102': 9, '11': 5, '12': 6 }
const stubGrouping = {
  computeLevels: (): any => ({ byNumber: Object.assign({}, STUB_LEVELS), levels: [] }),
  groupTickets: (tickets: any[]): any => ({ total: tickets.length, open: 0, closed: 0, frontier: 0, claimed: 0, blocked: 0, levels: [], levelOf: {} }),
}
const quiet = { fire: () => {}, isEnabled: () => false }
const makeTable = (): any => {
  const m = new Map<string, any>()
  return { getCache: (cwd: string) => m.get(String(cwd)) || { ts: 0, snapshot: null, error: null, cwd: String(cwd) }, setCache: (v: any) => { if (v && v.cwd) m.set(String(v.cwd), v) } }
}
// The shape follows tests/verify-1774-carry-wiring.ts (roomDeps and refreshDeps); a gate file cannot import those builders because they are scripts.
function roomDeps(table: any, tracker: any, grouping: any, backendId: string): any {
  const adopt = (s: unknown, c: string): unknown => { table.setCache({ ts: Date.now(), snapshot: s, error: null, cwd: c }); return s }
  const library = { readSnapshotReplay: async (input: any) => { const e = table.getCache(input && input.workspaceRoot); return (e && e.snapshot) ? { snapshot: e.snapshot, lastKnownAtMs: e.ts } : null }, recordIssueRows: async () => ({ ok: true, rows: 0, mergeVersion: null }), readSnapshotDiagnostics: async () => [] }
  // The real host upper-cases the states of a composed snapshot (upcaseSnapStates in src/host/index.ts); do the same so open and closed are counted.
  const upcase = (s: any): any => { const up = (r: any): any => (r && typeof r.state === 'string') ? Object.assign({}, r, { state: r.state.toUpperCase() }) : r; return Object.assign({}, s, { maps: (s.maps || []).map((m: any) => Object.assign({}, up(m), { tickets: (m.tickets || []).map(up) })), issues: (s.issues || []).map(up) }) }
  return {
    canonicalKey: async () => 'K64', selectEarly: async () => ({ backendId, source: 'auto', rev: 0 }),
    // The production predicate (src/host/sessionLifecycle.ts): every backend but github and `other` goes through the composer.
    isComposerSelection: (sel: any) => !!(sel && sel.backendId && sel.backendId !== 'github' && sel.backendId !== 'other'),
    getTrackerRegistry: async () => ({ modules: () => [], describe: () => REPO, get: () => tracker }),
    getPlatform: async () => ({ os: 'linux', path: nodePath, async getHome() { return nodeOs.homedir() } }), ctx: { get: () => undefined },
    getCache: table.getCache, setCache: table.setCache, CACHE_MS: 60000, getSnapshotLibrary: async () => library, cacheSnapshotIsCurrent: async () => null,
    upcaseSnapStates: upcase, computeLevels: grouping.computeLevels, groupTickets: grouping.groupTickets,
    getRepoRoot: async (c: string) => c, getRepoKey: async () => ({ owner: 'a', name: 'b' }), readDiskCache: async () => null, writeDiskCache: async () => {},
    adoptSnapshot: adopt, detectionExec: async () => ({ ok: false }), getGhPath: () => '', getGhLastError: () => '', errText: (e: any) => String((e && e.message) || e),
    DEFAULT_CWD: 'K64', logCtx: quiet,
    resetGhCache: () => {}, envelope: createSnapshotEnvelope({ getGhPath: () => '', getGhLastError: () => '', adoptSnapshot: adopt, logCtx: quiet } as any),
  }
}
const numericRows = (): any[] => [mapRow('7'), { key: '11', effortId: '', type: 'issue', title: 'Eleven', state: 'open', body: '', parentKey: '7', labels: [], assignees: [], blockedBy: [] }, { key: '12', effortId: '', type: 'issue', title: 'Twelve', state: 'open', body: '', parentKey: '7', labels: [], assignees: [], blockedBy: [11] }]
const numericTracker = (): any => ({ list: async () => ({ ok: true, data: numericRows() }), counts: async () => ({ ok: false, error: { kind: 'unsupported' } }) })
const levelsIn = (reply: any, keys: string[]): string => show(keys.map((k) => { const t = byKeyOf(reply && reply.issues, k); return t ? t.level : 'missing' }))

for (const phone of ['snapshot', 'refresh']) {
  const run = async (tracker: any, backendId: string): Promise<any> => {
    const deps = roomDeps(makeTable(), tracker, stubGrouping, backendId)
    return phone === 'snapshot' ? createSessionSnapshot(deps).handleSnapshot({ cwd: 'K64', force: true }) : createSessionRefresh(deps).handleRefresh({ cwd: 'K64' })
  }
  const linear = await run(linearTracker(), 'linear')
  check(levelsIn(linear, ['ENG-101', 'ENG-102']) === show([7, 9]), 'B ' + phone + ': a text-key row takes its level from the grouping result keyed by its text key (got ' + levelsIn(linear, ['ENG-101', 'ENG-102']) + ', expected [7,9])')
  const numeric = await run(numericTracker(), 'markdown')
  check(levelsIn(numeric, ['11', '12']) === show([5, 6]), 'B ' + phone + ': a numeric row still takes its level from the result keyed by its number (got ' + levelsIn(numeric, ['11', '12']) + ', expected [5,6])')
}
// The snapshot room's fallback branch (the selection is not a composer one, which is what `github` looks like in production) has its own copy of the same
// level lines; force the predicate to say no so the room takes that branch, over the same composer and the same rows.
{
  const asFallback = (tracker: any, backendId: string): any => Object.assign(roomDeps(makeTable(), tracker, stubGrouping, backendId), { isComposerSelection: () => false })
  const linearFb = await createSessionSnapshot(asFallback(linearTracker(), 'linear')).handleSnapshot({ cwd: 'K64', force: true })
  check(levelsIn(linearFb, ['ENG-101', 'ENG-102']) === show([7, 9]), 'B snapshot fallback: a text-key row takes its level from the grouping result keyed by its text key (got ' + levelsIn(linearFb, ['ENG-101', 'ENG-102']) + ', expected [7,9])')
  const numericFb = await createSessionSnapshot(asFallback(numericTracker(), 'markdown')).handleSnapshot({ cwd: 'K64', force: true })
  check(levelsIn(numericFb, ['11', '12']) === show([5, 6]), 'B snapshot fallback: a numeric row still takes its level from the result keyed by its number (got ' + levelsIn(numericFb, ['11', '12']) + ', expected [5,6])')
}

// ───────── D. one identity rule ─────────
{
  const identityOf: any = (kernelGrouping as any).ticketIdentityOf
  check(typeof identityOf === 'function', 'D: the tracker kernel grouping exports the one identity rule (ticketIdentityOf)')
  if (typeof identityOf === 'function') {
    const host = createTicketGrouping()
    const samples: any[] = [{ number: 5 }, { number: 0 }, { number: 12, key: 'ENG-12' }, { key: 'ENG-101' }, { key: ' ENG-102 ' }, { key: '007' }, { number: null, key: 'ENG-7' }]
    for (const s of samples) {
      const row = Object.assign({ state: 'OPEN', blockedBy: [] }, s)
      const id = String(identityOf(row))
      const kernelKeys = Object.keys(kernelGrouping.computeLevels([row]).byNumber)
      const hostKeys = Object.keys(host.computeLevels([row]).byNumber)
      check(show(kernelKeys) === show([id]) && show(hostKeys) === show([id]), 'D: ' + show(s) + ' has the identity ' + show(id) + ' in the rule and in both copies of the grouping (kernel ' + show(kernelKeys) + ', host ' + show(hostKeys) + ')')
    }
    check(identityOf({ number: 5, key: 'ENG-5' }) === 5 && identityOf({ key: 'ENG-101' }) === 'ENG-101', 'D: the number wins when there is one and the text key is the fallback, and a number stays a number')
  }
  const read = (rel: string): string => fs.readFileSync(nodePath.join(ROOT, rel), 'utf8')
  for (const rel of ['src/host/tracker/snapshotAssemble.ts', 'src/refresh/rooms/host/session-snapshot-cache.ts', 'src/refresh/rooms/host/session-refresh-schedule.ts']) {
    const src = read(rel)
    check(/ticketIdentityOf/.test(src), 'D: ' + rel + ' takes the row identity from the shared rule')
    check(!/byKey\[|\.byKey\b/.test(src), 'D: ' + rel + ' no longer reads the byKey table that no grouping produces')
  }
}

printGateResult('verify-64-text-key-level-blocks', assertions, failed)
if (failed) process.exit(1)
