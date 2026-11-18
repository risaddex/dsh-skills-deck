// tests/verify-50-linear-list-sub-issues.ts: the Linear room answers `listSubIssues` for one parent ticket, honestly about completeness (#50).
//
// Why this gate exists: the Linear room had no `listSubIssues`, so the registry answered its stub ("backend linear does not implement op
// listSubIssues"). The two callers that ask for the children of ONE ticket, the map phone (`wf.mapTickets`) and the snapshot working set, both
// treat that answer as "unsupported", so a Linear map only showed the children that happened to be inside the list page the snapshot had
// fetched, and showed nothing when they were not (host log of 2026-11-18: `quota.op` for `listSubIssues`, `backendId: linear`, `ok:false`,
// `requests:0`). This gate runs the REAL room, reached the way the registry reaches it (the module wrapped by `wrapTracker`, so a missing
// operation still shows up as the stub), over a fake HTTP channel that behaves like a Relay connection (tests/lib/linear-sub-issues-fake.ts), and asserts:
//   A. the request names the parent (as text, `ENG-12`, never a number), asks for an explicit page size and a named order, and stays under
//      Linear's 10,000 point query limit by the published rule;
//   B. a list longer than one page is walked page by page with the cursor Linear gave, and every child comes back, in Linear's order
//      (B2: the blockers travel with the children);
//   C. the 1000 hard cap, the page bound and the exact boundary: a capped list is flagged capped and its provenance says "truncated", and a
//      list that fits exactly 1000 is NOT flagged;
//   D. a list read only in part is never returned as complete: a failing page, a missing cursor, a missing pageInfo and rows that cannot be
//      read all end in a failure or in a flag, never in a quiet success (D2: failures keep their own class).
// The callers (snapshot working set, map phone) and the log are in tests/verify-50-linear-list-sub-issues-callers.ts.
// 门禁归属: src/tracker/rooms/linear/sub-issues.ts
// 门禁归属: src/tracker/rooms/linear/queries.ts
// 门禁归属: src/tracker/rooms/linear/index.ts
// 门禁归属: src/tracker/contract/pagination.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-50-linear-list-sub-issues.ts
import { printGateResult } from './lib/gate-result.ts'
import { complexityOf } from './lib/linear-complexity.ts'
import { PAGINATION } from '../src/tracker/contract/pagination.ts'
import * as Q from '../src/tracker/rooms/linear/queries.ts'
import { ACCOUNT, PARENT, PAGE, MAX, child, kids, keysOf, fake, list, show } from './lib/linear-sub-issues-fake.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

// A) the request that goes out
{
  const f = fake({ children: { [PARENT]: kids(3) } })
  const got: any = await list(f)
  check(got.ok === true, 'A: the room answers listSubIssues instead of the registry stub (got ' + (got.ok ? 'ok' : String(got.error && got.error.kind) + ': ' + String(got.error && got.error.message)) + ')')
  const sent = f.bodies[0] || null
  const req = f.calls[0] || null
  check(f.calls.length === 1, 'A: a list that fits one page costs one request (got ' + f.calls.length + ')')
  check(!!sent && sent.variables.id === PARENT && typeof sent.variables.id === 'string', 'A: the parent goes as the text key Linear knows, ENG-12, never as a number (got ' + show(sent && sent.variables) + ')')
  check(!!sent && /issue\s*\(\s*id:\s*\$id\s*\)/.test(sent.query) && /children\s*\(/.test(sent.query), 'A: the query asks for the children of that one issue')
  check(!!sent && /children\s*\(\s*first:\s*\$first\s*,\s*after:\s*\$after/.test(sent.query), 'A: the children connection takes first and after as variables, so the page size and the cursor are explicit')
  check(!!sent && sent.variables.first === PAGE && PAGINATION.linear.subIssuesPageSize === PAGE, 'A: the page bound is explicit and is the documented ' + PAGE + ' (got ' + show(sent && sent.variables.first) + ', table ' + String((PAGINATION.linear as any).subIssuesPageSize) + ')')
  check(!!sent && sent.variables.after === null, 'A: the first page has no cursor')
  check(!!sent && /orderBy:\s*createdAt/.test(sent.query), 'A: the order is named in the query, createdAt (a creation date does not move while the walk is going on, an update date does)')
  check(!!sent && /hasNextPage/.test(sent.query) && /endCursor/.test(sent.query), 'A: the query asks Linear whether there is a next page and for its cursor')
  check(!!sent && /inverseRelations\(first:\s*\d+\)/.test(sent.query) && !/inverseRelations(?!\(first:)/.test(sent.query), 'A: the children come with their blockers, and the relations page is explicit, never left to the default of 50')
  check(!!sent && /fragment\s+LinearIssueCore/.test(sent.query) && /parent\s*\{\s*identifier/.test(sent.query), 'A: the children carry the ticket fields and their parent, the way every other read of this room does')
  check(!!req && req.method === 'POST' && req.url === ACCOUNT.endpoint && req.bucket === 'read' && req.service === 'linear', 'A: it goes through the room channel as a read of the linear service (got ' + show(req && { m: req.method, u: req.url, b: req.bucket, s: req.service }) + ')')
  const cost = sent ? complexityOf(String(sent.query), { first: PAGE }) : 99999
  check(cost < 7000, 'A: a page costs ' + cost + ' of the 10,000 points Linear allows by its published rule, with room to spare (a page of 100 would be rejected as a whole)')
  const tooMany = sent ? complexityOf(String(sent.query), { first: 100 }) : 0
  check(tooMany > 10000, 'A: the same query for 100 children a page would cost ' + tooMany + ' and be rejected: this is why the page is ' + PAGE)
  const named: any = Q
  check(named.SUB_ISSUES_ORDER_BY === 'createdAt' && named.SUB_ISSUES_ORDER === 'newest-first', 'A: the order has a name in the code, the way the comments read names its own: createdAt, newest first (got ' + show([named.SUB_ISSUES_ORDER_BY, named.SUB_ISSUES_ORDER]) + ')')
}

// B) a multi-page walk
{
  const f = fake({ children: { [PARENT]: kids(120) } })
  const got: any = await list(f)
  const cursors = f.bodies.map((b: any) => b.variables.after)
  check(f.calls.length === 3, 'B: 120 children are three pages, three requests (got ' + f.calls.length + ')')
  check(show(cursors) === show([null, 'c:50', 'c:100']), 'B: each page asks with the cursor Linear gave for the page before, not one the room made up (got ' + show(cursors) + ')')
  check(got.ok === true && got.data.items.length === 120 && new Set(keysOf(got)).size === 120, 'B: all 120 children come back, none twice (got ' + (got.ok ? got.data.items.length : show(got.error)) + ')')
  check(got.ok === true && show(keysOf(got).slice(0, 3)) === show(['ENG-220', 'ENG-219', 'ENG-218']), 'B: the rows keep the order Linear sent, newest first for the order the room asked (got ' + show(keysOf(got).slice(0, 3)) + ')')
  check(got.ok === true && got.data.total === 120 && got.data.fetched === 120 && got.data.capped === false && got.data.missing === 0 && got.data.dropped === 0, 'B: total 120, fetched 120, not capped, nothing missing, nothing dropped (got ' + show(got.ok ? { t: got.data.total, f: got.data.fetched, c: got.data.capped, m: got.data.missing, d: got.data.dropped } : got.error) + ')')
  const prov: any = got.provenance
  check(!!prov && prov.operation === 'listSubIssues' && prov.completeness === 'complete' && prov.fieldGroups.subIssues === 'complete' && prov.fieldGroups.row === 'complete' && prov.missingFieldGroups.length === 0, 'B: a list read to its end says so: provenance complete for the subIssues and row groups (got ' + show(prov && { c: prov.completeness, g: prov.fieldGroups }) + ')')
  check(!!prov && typeof prov.source === 'string' && prov.source.length > 0 && /^read-v1-\d+-\d{6}$/.test(String(prov.startVersion)) && Number.isInteger(prov.durationMs) && prov.durationMs >= 0, 'B: the provenance names the channel, a start version and a duration (got ' + show(prov && { s: prov.source, v: prov.startVersion, d: prov.durationMs }) + ')')
  const parents = got.ok ? got.data.items.map((i: any) => i.parentKey) : []
  check(parents.length === 120 && parents.every((p: any) => p === PARENT), 'B: every child carries its parent key, so the caller can place it under the map (got ' + show(parents.slice(0, 2)) + ')')
}

// B2) blockers travel with the children, and a row with more relations than the page is returned without blockedBy (never a partial list read as complete)
{
  const blockedChildren = [child(1), child(2, { rels: [{ id: 'r1', type: 'blocks', issue: { identifier: 'ENG-101', title: 'Child 1', state: { type: 'unstarted' } } }, { id: 'r2', type: 'related', issue: { identifier: 'ENG-900', title: 'Other', state: { type: 'unstarted' } } }] }), child(3, { rels: Array.from({ length: 11 }, (_, i) => ({ id: 'x' + i, type: 'blocks', issue: { identifier: 'ENG-' + (300 + i), title: 'B' + i, state: { type: 'unstarted' } } })) })]
  const got: any = await list(fake({ children: { [PARENT]: blockedChildren } }))
  const by = (k: string): any => (got.ok ? got.data.items : []).find((i: any) => i.key === k)
  check(got.ok === true && !!by('ENG-102') && show((by('ENG-102').blockedBy || []).map((r: any) => r.key)) === show(['ENG-101']), 'B2: a child blocked by ENG-101 says so, and a related ticket is not a blocker (got ' + show(by('ENG-102') && by('ENG-102').blockedBy) + ')')
  check(got.ok === true && !!by('ENG-101') && by('ENG-101').blockedBy === undefined, 'B2: a child whose relations were not asked for in the data has no blockedBy: unknown, not "nobody"')
  check(got.ok === true && !!by('ENG-103') && by('ENG-103').blockedBy === undefined, 'B2: a child with 11 relations (page of 10) has NO blockedBy: unknown, never a partial list read as complete')
}

// C) the hard cap, the page bound and the exact boundary
{
  const f = fake({ children: { [PARENT]: kids(1200) } })
  const got: any = await list(f)
  check(f.calls.length === Math.ceil(MAX / PAGE), 'C: 1200 children stop at the cap after ' + Math.ceil(MAX / PAGE) + ' requests, not after all 24 (got ' + f.calls.length + ')')
  check(got.ok === true && got.data.items.length === MAX && got.data.fetched === MAX, 'C: exactly ' + MAX + ' rows come back (got ' + (got.ok ? got.data.items.length : show(got.error)) + ')')
  check(got.ok === true && got.data.capped === true, 'C: and the list is flagged capped: it is a part of the children, never returned as if it were all of them (got capped ' + show(got.ok && got.data.capped) + ')')
  check(got.ok === true && got.data.total >= got.data.fetched, 'C: the total is not smaller than what was fetched (Linear gives no total, so it is a lower bound that the capped flag explains)')
  const prov: any = got.provenance
  check(!!prov && prov.completeness === 'truncated' && prov.fieldGroups.subIssues === 'truncated' && prov.missingFieldGroups.includes('subIssues'), 'C: the provenance marks the subIssues group truncated and the whole read truncated, not complete (got ' + show(prov && { c: prov.completeness, g: prov.fieldGroups, m: prov.missingFieldGroups }) + ')')
  check(!!prov && prov.fieldGroups.row === 'complete', 'C: the rows that were read are whole: the row group stays complete')
}
{
  const exact: any = await list(fake({ children: { [PARENT]: kids(MAX) } }))
  check(exact.ok === true && exact.data.items.length === MAX && exact.data.capped === false && exact.provenance && exact.provenance.completeness === 'complete', 'C: a list of exactly ' + MAX + ' children that ends there is complete, and is not called capped')
  const over: any = await list(fake({ children: { [PARENT]: kids(MAX + 1) } }))
  check(over.ok === true && over.data.items.length === MAX && over.data.capped === true, 'C: one child more than ' + MAX + ' is capped (got fetched ' + show(over.ok && over.data.fetched) + ', capped ' + show(over.ok && over.data.capped) + ')')
  const f = fake({ children: { [PARENT]: kids(5) }, endless: true })
  const endless: any = await list(f)
  check(f.calls.length > 1 && f.calls.length <= 60, 'C: a server that never ends is stopped by an explicit page bound (made ' + f.calls.length + ' requests)')
  check(endless.ok === true && endless.data.capped === true && endless.provenance && endless.provenance.completeness === 'truncated', 'C: and what it read is flagged incomplete, not returned as the whole list')
}

// D) a list read in part is never returned as complete
{
  const fail2 = await list(fake({ children: { [PARENT]: kids(120) }, failOnCall: 2 }))
  check(fail2.ok === false && fail2.error && fail2.error.kind === 'network', 'D: a second page that fails fails the whole read, with the failure class of that page, instead of returning the first 50 as the list (got ' + show(fail2.ok ? 'ok with ' + fail2.data.items.length : fail2.error) + ')')
  const fail1 = await list(fake({ children: { [PARENT]: kids(3) }, failOnCall: 1 }))
  check(fail1.ok === false && fail1.error && fail1.error.kind === 'network', 'D: and so does a failing first page, with its own class (got ' + show(fail1.ok ? 'ok' : fail1.error) + ')')
  const noCursor: any = await list(fake({ children: { [PARENT]: kids(120) }, noCursor: true }))
  check(noCursor.ok === false && noCursor.error && noCursor.error.kind === 'parse', 'D: "there is a next page" without a cursor to read it is a failure, not a complete list (got ' + show(noCursor.ok ? 'ok with ' + noCursor.data.items.length : noCursor.error) + ')')
  const noInfo: any = await list(fake({ children: { [PARENT]: kids(3) }, noPageInfo: true }))
  check(noInfo.ok === false && noInfo.error && noInfo.error.kind === 'parse', 'D: a connection without pageInfo cannot say whether it ended: it is a failure, not a complete list (got ' + show(noInfo.ok ? 'ok' : noInfo.error) + ')')
  const junk: any = await list(fake({ children: { [PARENT]: kids(3) }, junk: [null, 42, { identifier: '', id: '' }] }))
  check(junk.ok === true && junk.data.items.length === 3 && junk.data.dropped === 3 && junk.data.fetched === 3, 'D: rows that cannot be read are counted as dropped and are not fetched (got ' + show(junk.ok ? { f: junk.data.fetched, d: junk.data.dropped } : junk.error) + ')')
  check(junk.ok === true && junk.data.total === junk.data.fetched + junk.data.dropped && junk.data.missing === 0, 'D: fetched plus dropped is what Linear sent, and nothing is missing on top of that (the contract keeps dropped apart from missing)')
  check(!!junk.provenance && junk.provenance.fieldGroups.row === 'truncated' && junk.provenance.completeness === 'truncated' && junk.provenance.fieldGroups.subIssues === 'complete', 'D: the provenance says the row group lost rows while the walk itself reached the end (got ' + show(junk.provenance && junk.provenance.fieldGroups) + ')')
}

// D2) failures that are not about paging stay failures with their own class
{
  const f = fake({ children: { [PARENT]: kids(3) } })
  const gone: any = await list(f, 'ENG-999')
  check(gone.ok === false && gone.error && gone.error.kind === 'not-found' && f.calls.length === 1, 'D2: a parent that does not exist is not-found (and is never read as "no children") (got ' + show(gone.ok ? 'ok' : gone.error) + ')')
  const blank = fake({ children: { [PARENT]: kids(3) } })
  const empty: any = await list(blank, '   ')
  check(empty.ok === false && empty.error && empty.error.kind === 'not-found' && blank.calls.length === 0, 'D2: a blank key is refused before anything is sent (got ' + show(empty.ok ? 'ok' : empty.error) + ', requests ' + blank.calls.length + ')')
  const spaced = fake({ children: { [PARENT]: kids(2) } })
  const trimmed: any = await list(spaced, '  ' + PARENT + ' ')
  check(trimmed.ok === true && spaced.bodies[0].variables.id === PARENT, 'D2: the key is trimmed, nothing else is done to it')
  const denied = { ctx: { http: { request: async () => ({ status: 401, headers: {}, body: '' }) } } }
  const bad: any = await list(denied)
  check(bad.ok === false && bad.error && bad.error.kind === 'auth', 'D2: a rejected credential is an auth failure, never an empty list (got ' + show(bad.ok ? 'ok' : bad.error) + ')')
  const noHttp: any = await list({ ctx: {} })
  check(noHttp.ok === false && noHttp.error && noHttp.error.kind === 'env', 'D2: a room wired without an HTTP channel is an environment failure, loud and not an empty list (got ' + show(noHttp.ok ? 'ok' : noHttp.error) + ')')
}

printGateResult('verify-50-linear-list-sub-issues', assertions, failed)
if (failed) process.exit(1)
