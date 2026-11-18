// tests/verify-50-linear-list-sub-issues-callers.ts: the callers of `listSubIssues` and the log of the Linear read (#50).
//
// The room itself is asserted in tests/verify-50-linear-list-sub-issues.ts. This gate asserts what the room's answer must work with:
//   E. the real `assembleWorkingSet` (snapshot) and the real `wf.mapTickets` phone stop answering "unsupported" for Linear, and still
//      report a capped list as incomplete. The phone builds a context with only `exec`, which the Linear room cannot use (no HTTP channel,
//      the defect #45 fixed for the probe and the paging phone), so for Linear it must read through the read session; every other room
//      keeps the direct call, and a room that has no such operation still gets the same "unsupported" stub answer;
//   G. unknown blockers stay unknown (PR #60 review): a child with 11 open inverse relations (a page of 10) comes back from the room
//      WITHOUT blockedBy; the phone must not turn that into [] ("confirmed: nobody blocks it") and the grouping must not count it as ready;
//   F. the log: a capped read leaves one `read.degraded` line with op `subIssues`, a failing page leaves one with `subIssues:page-fail`,
//      and no line carries the credential or the ticket key.
// 门禁归属: src/host/mapTickets.ts
// 门禁归属: src/tracker/session/linear-sub-issues-via-session.ts
// 门禁归属: src/host/tracker/snapshotWorkingSet.ts
// 门禁归属: src/tracker/rooms/linear/sub-issues.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-50-linear-list-sub-issues-callers.ts
import { printGateResult } from './lib/gate-result.ts'
import { wrapTracker } from '../src/tracker/registry/shape.ts'
import { assembleWorkingSet } from '../src/host/tracker/snapshotWorkingSet.ts'
import { createMapTickets } from '../src/host/mapTickets.ts'
import { createSessionLifecycle } from '../src/host/sessionLifecycle.ts'
import { createTicketGrouping } from '../src/host/ticketGrouping.ts'
import { groupTickets as kernelGroupTickets } from '../src/tracker/kernel/grouping.ts'
import { ACCOUNT, REPO, PARENT, MAX, child, kids, fake, trackerOf, list, show } from './lib/linear-sub-issues-fake.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

// E) the callers
{
  const f = fake({ children: { [PARENT]: kids(120) } })
  const tracker = trackerOf(f)
  const mapRow = { key: PARENT, type: 'map', state: 'OPEN', title: 'The map', body: '', parentKey: null }
  const ws: any = await assembleWorkingSet({ tracker, ref: REPO, ctx: f.ctx, pool: [mapRow], openContainers: [mapRow] })
  check(ws.openContainers === 1 && ws.subIssues === 120 && ws.subIssuesFailed === 0 && ws.subIssuesIncomplete === 0, 'E: the snapshot working set gets the 120 children of the open map, with no failure and nothing incomplete (got ' + show({ c: ws.openContainers, s: ws.subIssues, f: ws.subIssuesFailed, i: ws.subIssuesIncomplete }) + ')')
  check(ws.rows.filter((r: any) => r.parentKey === PARENT).length === 120, 'E: and the rows are in the set under their parent (got ' + ws.rows.filter((r: any) => r.parentKey === PARENT).length + ')')
  const capped = fake({ children: { [PARENT]: kids(1200) } })
  const ws2: any = await assembleWorkingSet({ tracker: trackerOf(capped), ref: REPO, ctx: capped.ctx, pool: [mapRow], openContainers: [mapRow] })
  check(ws2.subIssues === MAX && ws2.subIssuesIncomplete === 1 && ws2.subIssuesFailed === 0, 'E: a capped list is counted as incomplete by the snapshot, not as a whole one (got ' + show({ s: ws2.subIssues, i: ws2.subIssuesIncomplete }) + ')')

  // The phone builds its own operation context (only `exec`, made for rooms that run commands), and the Linear room reads its HTTP channel from
  // the context it is given. So for a Linear workspace the phone must read through the read session, whose context carries the channel and the
  // account: the same rule the probe and the paging phone follow (#45). `sessionOf` is that session, over the fake channel `f`.
  const life: any = createSessionLifecycle({})
  const sessions: any[] = []
  const phoneOf = (t: any, f: any, backendId: string = 'linear', withSession: boolean = true): any => createMapTickets({
    canonicalKey: async (c: any) => c || '/ws/fake', selectEarly: async () => ({ backendId }), isComposerSelection: life.isComposerSelection,
    getTrackerRegistry: async () => ({ get: () => t, describe: () => REPO }),
    getPlatform: async () => ({}), ctx: { get: () => undefined }, DEFAULT_CWD: '/ws/fake', logCtx: null,
    groupTickets: () => ({ total: 0, open: 0, closed: 0, frontier: 0, claimed: 0, blocked: 0, levels: [], levelOf: {} }), getMapBody: async () => null, detectionExec: () => {},
    ...(withSession ? { openSession: async (cwd: string) => { sessions.push(cwd); return { ok: true, backendId: 'linear', call: async (fn: any) => fn(t, Object.assign({}, f.ctx)) } } } : {}),
  })
  const fOk = fake({ children: { [PARENT]: kids(120) } })
  const phoneOk: any = await phoneOf(trackerOf(fOk), fOk).handleMapTickets({ cwd: '/ws/fake', key: PARENT })
  check(phoneOk.ok === true && phoneOk.items.length === 120 && phoneOk.total === 120 && phoneOk.capped === false && phoneOk.missing === 0, 'E: wf.mapTickets answers the 120 children of a Linear map instead of "unsupported" (got ' + show(phoneOk.ok ? { n: phoneOk.items.length, t: phoneOk.total, c: phoneOk.capped } : phoneOk.error) + ')')
  check(phoneOk.ok === true && phoneOk.items.every((r: any) => r.state === 'OPEN' && r.key.startsWith('ENG-')), 'E: and the rows are the ones the panel draws, with the text key kept (got ' + show(phoneOk.ok && phoneOk.items[0] && phoneOk.items[0].key) + ')')
  check(sessions.length === 1 && sessions[0] === '/ws/fake' && fOk.calls.every((c: any) => c.headers && c.headers.Authorization === ACCOUNT.authorization), 'E: it read through the read session of the workspace, and every request carried the account header (sessions opened ' + sessions.length + ')')
  const fCap = fake({ children: { [PARENT]: kids(1200) } })
  const phoneCapped: any = await phoneOf(trackerOf(fCap), fCap).handleMapTickets({ cwd: '/ws/fake', key: PARENT })
  check(phoneCapped.ok === true && phoneCapped.items.length === MAX && phoneCapped.capped === true, 'E: a capped Linear map reaches the panel as capped (got ' + show(phoneCapped.ok ? { n: phoneCapped.items.length, c: phoneCapped.capped } : phoneCapped.error) + ')')
  const hostOp = String(phoneCapped.logged && phoneCapped.logged.opId)
  const roomLine = fCap.events.find((e: any) => e.event === 'read.degraded')
  check(!!roomLine && hostOp !== '' && roomLine.fields.opId === hostOp, 'E: the room line of that read carries the operation id the host phone logged, so the two layers can be tied together (host ' + hostOp + ', room ' + show(roomLine && roomLine.fields.opId) + ')')
  const fNo = fake({ children: { [PARENT]: kids(3) } })
  const noSession: any = await phoneOf(trackerOf(fNo), fNo, 'linear', false).handleMapTickets({ cwd: '/ws/fake', key: PARENT })
  check(noSession.ok === false && noSession.error && noSession.error.kind === 'env' && fNo.calls.length === 0, 'E: with no read session wired the phone says so, as an environment failure, and sends nothing (got ' + show(noSession.ok ? 'ok' : noSession.error) + ')')
  // other rooms keep the direct path: the tracker is asked straight, with the phone\'s own context, and no session is opened
  const before = sessions.length
  let direct: any = null
  const gitlabLike: any = { listSubIssues: async (_r: any, key: string, _o: any, c: any) => { direct = { key, hasHttp: !!(c && c.http) }; return { ok: true, data: { items: [], total: 0, fetched: 0, capped: false, missing: 0, dropped: 0 } } } }
  const other: any = await phoneOf(gitlabLike, fNo, 'gitlab').handleMapTickets({ cwd: '/ws/fake', key: '7' })
  check(other.ok === true && !!direct && direct.key === '7' && direct.hasHttp === false && sessions.length === before, 'E: a room that is not Linear is asked directly with the phone context and no session is opened: nothing moved for GitLab or Markdown (got ' + show(direct) + ')')
  // a room that has no such operation keeps today's answer, which the callers already know how to read
  const bare: any = wrapTracker({ id: 'bare', label: 'Bare', create: () => ({}), matches: async () => false, budget: { kind: 'unknown', countsRequests: false, countsPoints: false, independentBuckets: false } } as any, { id: 'bare' } as any, {})
  const stub: any = await bare.listSubIssues(REPO, PARENT, {}, {})
  check(stub.ok === false && stub.error.kind === 'unsupported', 'E: a room without the operation still gets the registry stub "unsupported": the stub path itself is unchanged')
}

// G) unknown blockers stay unknown, through the real phone and the real grouping (both copies of it)
{
  const open = (ident: string, title: string): any => ({ type: 'blocks', issue: { identifier: ident, title, state: { type: 'unstarted' } } })
  const eleven = Array.from({ length: 11 }, (_, i) => Object.assign({ id: 'x' + i }, open('ENG-' + (300 + i), 'Blocker ' + i)))
  // 101: known empty (an empty relation list was read). 102: 11 open relations, more than the page of 10, so the room leaves blockedBy out.
  // 103: one open blocker, ENG-101.
  const pool = [child(1, { rels: [] }), child(2, { rels: eleven }), child(3, { rels: [Object.assign({ id: 'r1' }, open('ENG-101', 'Child 1'))] })]
  const f = fake({ children: { [PARENT]: pool } })
  const grouping = createTicketGrouping()
  const life2: any = createSessionLifecycle({})
  const phone: any = createMapTickets({
    canonicalKey: async (c: any) => c || '/ws/fake', selectEarly: async () => ({ backendId: 'linear' }), isComposerSelection: life2.isComposerSelection,
    getTrackerRegistry: async () => ({ get: () => trackerOf(f), describe: () => REPO }),
    getPlatform: async () => ({}), ctx: { get: () => undefined }, DEFAULT_CWD: '/ws/fake', logCtx: null,
    groupTickets: grouping.groupTickets, getMapBody: async () => null, detectionExec: () => {},
    openSession: async () => ({ ok: true, backendId: 'linear', call: async (fn: any) => fn(trackerOf(f), Object.assign({}, f.ctx)) }),
  })
  const got: any = await phone.handleMapTickets({ cwd: '/ws/fake', key: PARENT })
  const row = (k: string): any => (got.ok ? got.items : []).find((r: any) => r.key === k)
  check(got.ok === true && got.items.length === 3, 'G: the phone answers the three children (got ' + (got.ok ? got.items.length : show(got.error)) + ')')
  check(!!row('ENG-102') && row('ENG-102').blockedBy === undefined, 'G: the child with 11 open relations keeps blockedBy ABSENT through row preparation: unknown is not "nobody blocks it" (got ' + show(row('ENG-102') && row('ENG-102').blockedBy) + ')')
  check(!!row('ENG-101') && Array.isArray(row('ENG-101').blockedBy) && row('ENG-101').blockedBy.length === 0, 'G: a child whose empty relation list was read keeps its confirmed [] (got ' + show(row('ENG-101') && row('ENG-101').blockedBy) + ')')
  check(got.ok === true && got.stats.frontier === 1 && got.stats.blocked === 2, 'G: the real grouping counts one ready child (ENG-101) and two blocked: the unknown one is treated as blocked, the conservative bucket the grouping already has for unknown blockers (got ' + show(got.ok && { f: got.stats.frontier, b: got.stats.blocked }) + ')')
  const kernel: any = got.ok ? kernelGroupTickets(got.items) : null
  check(!!kernel && kernel.frontier === 1 && kernel.blocked === 2, 'G: the other copy of the grouping (tracker kernel) gives the same answer for the same rows, as the two must (got ' + show(kernel && { f: kernel.frontier, b: kernel.blocked }) + ')')
}

// F) the log
{
  const f = fake({ children: { [PARENT]: kids(1200) } })
  await list(f)
  const degraded = f.events.filter((e: any) => e.event === 'read.degraded')
  check(degraded.length === 1 && degraded[0].level === 'warn' && degraded[0].fields.op === 'subIssues' && degraded[0].fields.reason === 'subIssues:truncated', 'F: a capped read leaves exactly one warning, read.degraded op subIssues reason subIssues:truncated (got ' + show(degraded.map((e: any) => e.fields)) + ')')
  check(degraded.length === 1 && Number.isInteger(degraded[0].fields.latencyMs) && degraded[0].fields.opId === 'op-1', 'F: with the duration and the operation id, so the line can be tied to the host line of the same call')
  const full = fake({ children: { [PARENT]: kids(120) } })
  await list(full)
  check(full.events.filter((e: any) => e.event === 'read.degraded').length === 0, 'F: a complete read leaves no degraded line (the line is for what did not come out whole)')
  check(full.events.filter((e: any) => e.event === 'linear.request').length === 3, 'F: and the boundary line of the channel, one per page, is there for each request (got ' + full.events.filter((e: any) => e.event === 'linear.request').length + ')')
  const failing = fake({ children: { [PARENT]: kids(120) }, failOnCall: 2 })
  await list(failing)
  const failLines = failing.events.filter((e: any) => e.event === 'read.degraded')
  check(failLines.length === 1 && failLines[0].fields.op === 'subIssues' && failLines[0].fields.reason === 'subIssues:page-fail', 'F: a page that fails leaves one read.degraded line with reason subIssues:page-fail, so a missing child list can be explained from the log (got ' + show(failLines.map((e: any) => e.fields)) + ')')
  const everything = show([...f.events, ...failing.events])
  check(f.events.length > 0 && failing.events.length > 0 && !everything.includes('SECRET') && !everything.includes('lin_api_key') && !everything.includes(PARENT) && !/Authorization/i.test(everything), 'F: no log line carries the credential, the ticket key or a header')
}

printGateResult('verify-50-linear-list-sub-issues-callers', assertions, failed)
if (failed) process.exit(1)
