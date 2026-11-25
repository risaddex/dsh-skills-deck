// tests/verify-89-linear-list-maps.ts: the Linear room answers `listMaps` (the thin map list), so `deck_context` and `deck_issue_list type=map`
// work on a Linear workspace (#89).
//
// Why this gate exists: the Linear room did not implement `listMaps`, so the registry answered its stub ("backend linear does not implement op
// listMaps"). Both callers then fell back to `list(repo, { type: 'map' })`, and the Linear room refuses to filter by type. The result was
// `deck_context` returning `status: "partial"` with `maps: []` (a zero that reads like "no maps"), and `deck_issue_list type=map` returning nothing at all.
// This gate runs the REAL room, reached the way the registry reaches it (the module wrapped by `wrapTracker`, so a missing operation still
// shows up as the stub), over a fake HTTP channel that behaves like a Relay connection, and asserts:
//   A. the request: one query, only the maps (by label, case-insensitive), BOTH open and closed states, no time window, explicit page size
//      from the shared table, thin fields only, and a cost under Linear's 10,000 point query limit by the published rule;
//   B. a list longer than one page is walked with the cursor Linear gave; rows carry only key/title/state/url, closed maps are in the list,
//      newest update first, no ticket twice, and the order the caller sees does not depend on the order Linear sent;
//   C. the page cap: a list that does not fit is cut at the cap and flagged `truncated`; a list that fits exactly is not flagged;
//   D. a list read in part is never returned as complete: a failing page, a missing pageInfo, a missing cursor and an unreadable row all end
//      in a failure, never in a quiet success (failures keep their own class, a rejected credential is `auth`, never an empty list);
//   E. the two callers see the room as a real implementation: the contract prose no longer says it is a stub, the shared table carries the
//      page cap, and the rows convert into the shape `deck_issue_list` returns;
// 门禁归属: src/tracker/rooms/linear/maps.ts
// 门禁归属: src/tracker/rooms/linear/queries.ts
// 门禁归属: src/tracker/rooms/linear/index.ts
// 门禁归属: src/tracker/contract/pagination.ts
// 门禁归属: src/tracker/contract/index.ts
// The end to end part (F: the real deck_context and deck_issue_list over this room) is in tests/verify-89-linear-list-maps-callers.ts.
// Run: node --import ./scripts/ts-hook.mts tests/verify-89-linear-list-maps.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printGateResult } from './lib/gate-result.ts'
import { complexityOf } from './lib/linear-complexity.ts'
import { PAGINATION } from '../src/tracker/contract/pagination.ts'
import { thinMapRowsToIssues } from '../src/deck/tools/issue-list.ts'
import { ACCOUNT, PAGE, CAP_PAGES, CAP_ROWS, node, maps, fake, run, keysOf, why, show } from './lib/linear-maps-fake.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

// A) the request that goes out
{
  const f = fake({ tickets: [...maps(3), node(900, { isMap: false }), node(901, { isMap: false })] })
  const got = await run(f)
  check(got.ok === true, 'A: the room answers listMaps instead of the registry stub (got ' + why(got) + ')')
  const sent = f.bodies[0] || null
  const req = f.calls[0] || null
  check(f.calls.length === 1, 'A: a list that fits one page costs one request (got ' + f.calls.length + ')')
  check(!!sent && /issues\s*\(\s*first:\s*\$first\s*,\s*after:\s*\$after/.test(sent.query) && /filter:\s*\$filter/.test(sent.query), 'A: the query takes first, after and the filter as variables, so the page size, the cursor and the condition are explicit')
  check(!!sent && sent.variables.first === PAGE && sent.variables.after === null, 'A: the first page asks for the documented ' + PAGE + ' rows and has no cursor (got ' + show(sent && { f: sent.variables.first, a: sent.variables.after }) + ')')
  const f1: any = sent && sent.variables.filter
  check(!!f1 && show(f1.labels) === show({ some: { name: { eqIgnoreCase: 'wayfinder:map' } } }), 'A: only the maps are asked for, by the label wayfinder:map compared without case (got ' + show(f1 && f1.labels) + ')')
  check(!!f1 && f1.state === undefined, 'A: no state condition: open AND closed maps are wanted (a closed map is still a map the workspace has) (got ' + show(f1 && f1.state) + ')')
  check(!!f1 && f1.updatedAt === undefined, 'A: no time window: the whole list is wanted, not the changes since a moment (got ' + show(f1 && f1.updatedAt) + ')')
  check(!!sent && /orderBy:\s*createdAt/.test(sent.query), 'A: the walk order is named in the query, createdAt (a creation date does not move while the walk is going on, an update date does; the room reorders by update time afterwards)')
  check(!!sent && /hasNextPage/.test(sent.query) && /endCursor/.test(sent.query), 'A: the query asks Linear whether there is a next page and for its cursor')
  const selected = sent ? String((/nodes\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*pageInfo/.exec(sent.query) || [])[1] || '') : ''
  check(selected.length > 0 && !/description|inverseRelations|comments|assignee|parent|labels|createdAt/.test(selected), 'A: the rows are thin: no body, no blockers, no comments, no assignee, no parent, no label list (that is the whole point of the thin read) (selection: ' + show(selected.replace(/\s+/g, ' ').trim()) + ')')
  check(/identifier/.test(selected) && /title/.test(selected) && /\burl\b/.test(selected) && /updatedAt/.test(selected) && /state\s*\{\s*type/.test(selected), 'A: but the four cells of a map row (key, title, state, url) and the update time for the final order are asked for')
  check(!!req && req.method === 'POST' && req.url === ACCOUNT.endpoint && req.bucket === 'read' && req.service === 'linear', 'A: it goes through the room channel as a read of the linear service (got ' + show(req && { m: req.method, u: req.url, b: req.bucket, s: req.service }) + ')')
  const cost = sent ? complexityOf(String(sent.query), { first: PAGE }) : 99999
  check(cost < 7000, 'A: a page costs ' + cost + ' of the 10,000 points Linear allows by its published rule, with room to spare')
  check(got.ok === true && show(keysOf(got)) === show(['ENG-3', 'ENG-2', 'ENG-1']), 'A: the tickets without the map label are not in the list (got ' + show(keysOf(got)) + ')')
}

// B) a multi-page walk and the shape of the rows
{
  const tickets = [...maps(120), node(900, { isMap: false })]
  const f = fake({ tickets })
  const got = await run(f)
  const cursors = f.bodies.map((b: any) => b.variables.after)
  check(f.calls.length === 3, 'B: 120 maps are three pages of ' + PAGE + ', three requests (got ' + f.calls.length + ')')
  check(show(cursors) === show([null, 'c:' + PAGE, 'c:' + PAGE * 2]), 'B: each page asks with the cursor Linear gave for the page before, not one the room made up (got ' + show(cursors) + ')')
  check(got.ok === true && got.data.rows.length === 120 && new Set(keysOf(got)).size === 120, 'B: all 120 maps come back, none twice (got ' + why(got) + ')')
  check(got.ok === true && got.data.total === 120 && got.data.truncated === false, 'B: total 120, not truncated (got ' + show(got.ok ? { t: got.data.total, c: got.data.truncated } : got.error) + ')')
  const row: any = got.ok ? got.data.rows[0] : null
  check(!!row && show(Object.keys(row).sort()) === show(['key', 'state', 'title', 'url']), 'B: a row carries exactly key, title, state and url (got ' + show(row && Object.keys(row)) + ')')
  check(!!row && row.key === 'ENG-120' && row.title === 'Map 120' && row.state === 'open' && row.url === 'https://linear.app/x/issue/ENG-120', 'B: and the values are the ticket identifier as text, the title, open, and the Linear address (got ' + show(row) + ')')
}
{
  const f = fake({ tickets: [node(1), node(2, { closed: true }), node(3), node(4, { closed: true })] })
  const got = await run(f)
  const by = (k: string): any => (got.ok ? got.data.rows : []).find((r: any) => r.key === k)
  check(got.ok === true && got.data.rows.length === 4, 'B: closed maps are in the list next to the open ones (got ' + why(got) + ')')
  check(!!by('ENG-2') && by('ENG-2').state === 'closed' && !!by('ENG-4') && by('ENG-4').state === 'closed' && !!by('ENG-1') && by('ENG-1').state === 'open', 'B: a completed map is closed and an unstarted one is open, by the same table the rest of the room uses (got ' + show(got.ok ? got.data.rows.map((r: any) => [r.key, r.state]) : got.error) + ')')
}
{
  // the order the caller sees is the update time, newest first, even when Linear sent them the other way round
  // ENG-2 was created early but updated last: by update time it is first, by creation time it would be third
  const f = fake({ tickets: [node(5), node(2, { updated: 500 }), node(9), node(1)], scramble: true })
  const got = await run(f)
  check(got.ok === true && show(keysOf(got)) === show(['ENG-2', 'ENG-9', 'ENG-5', 'ENG-1']), 'B: rows are ordered by update time, newest first, whatever order Linear sent and whatever order the walk used (got ' + show(keysOf(got)) + ')')
  const moved = await run(fake({ tickets: maps(70), repeatAcrossPages: true }))
  check(moved.ok === true && moved.data.rows.length === 70 && new Set(keysOf(moved)).size === 70, 'B: a map that shows up on two pages (it was updated while the walk went on) is listed once (got ' + why(moved) + ')')
  const none = await run(fake({ tickets: [node(900, { isMap: false })] }))
  check(none.ok === true && none.data.rows.length === 0 && none.data.total === 0 && none.data.truncated === false, 'B: a workspace that has no maps answers an empty list, truthfully, not a failure (got ' + why(none) + ')')
}

// C) the page cap
{
  const f = fake({ tickets: maps(CAP_ROWS + 120) })
  const got = await run(f)
  check(f.calls.length === CAP_PAGES, 'C: a list longer than the cap stops after ' + CAP_PAGES + ' requests, not after all of them (got ' + f.calls.length + ')')
  check(got.ok === true && got.data.rows.length === CAP_ROWS, 'C: exactly ' + CAP_ROWS + ' rows come back (got ' + why(got) + ')')
  check(got.ok === true && got.data.truncated === true, 'C: and the list is flagged truncated: it is a part of the maps, never returned as if it were all of them (got truncated ' + show(got.ok && got.data.truncated) + ')')
  check(got.ok === true && got.data.total >= got.data.rows.length, 'C: the total is not smaller than the rows returned (Linear gives no total, so it is a lower bound that the truncated flag explains)')
  check(got.ok === true && keysOf(got)[0] === 'ENG-' + (CAP_ROWS + 120), 'C: what is kept when the list is cut is the newest part (got first ' + show(keysOf(got)[0]) + ')')
  const exact = await run(fake({ tickets: maps(CAP_ROWS) }))
  check(exact.ok === true && exact.data.rows.length === CAP_ROWS && exact.data.truncated === false, 'C: a list of exactly ' + CAP_ROWS + ' maps that ends there is complete, and is not called truncated (got ' + why(exact) + ')')
  const over = await run(fake({ tickets: maps(CAP_ROWS + 1) }))
  check(over.ok === true && over.data.rows.length === CAP_ROWS && over.data.truncated === true, 'C: one map more than ' + CAP_ROWS + ' is truncated (got ' + why(over) + ')')
  const endless = fake({ tickets: [], endless: true })
  const forever = await run(endless)
  check(endless.calls.length === CAP_PAGES, 'C: a server that never ends is stopped by the page cap (made ' + endless.calls.length + ' requests)')
  check(forever.ok === true && forever.data.truncated === true, 'C: and what it read is flagged truncated, not returned as the whole list (got ' + why(forever) + ')')
}

// D) a list read in part is never returned as complete
{
  const fail2 = await run(fake({ tickets: maps(120), failOnCall: 2 }))
  check(fail2.ok === false && fail2.error && fail2.error.kind === 'network', 'D: a second page that fails fails the whole read, with the failure class of that page, instead of returning the first ' + PAGE + ' as the list (got ' + why(fail2) + ')')
  const fail1 = await run(fake({ tickets: maps(3), failOnCall: 1 }))
  check(fail1.ok === false && fail1.error && fail1.error.kind === 'network', 'D: and so does a failing first page, with its own class (got ' + why(fail1) + ')')
  const noCursor = await run(fake({ tickets: maps(120), noCursor: true }))
  check(noCursor.ok === false && noCursor.error && noCursor.error.kind === 'parse', 'D: "there is a next page" without a cursor to read it is a failure, not a complete list (got ' + why(noCursor) + ')')
  const noInfo = await run(fake({ tickets: maps(3), noPageInfo: true }))
  check(noInfo.ok === false && noInfo.error && noInfo.error.kind === 'parse', 'D: a connection without pageInfo cannot say whether it ended: it is a failure, not a complete list (got ' + why(noInfo) + ')')
  const junk = await run(fake({ tickets: maps(3), junk: [null, { id: '', identifier: '' }] }))
  check(junk.ok === false && junk.error && junk.error.kind === 'parse', 'D: a row that cannot be read (no identifier) fails the read: the list has no field to say a row was lost, so it must not look whole (got ' + why(junk) + ')')
  const denied: any = { ctx: { http: { request: async () => ({ status: 401, headers: {}, body: '' }) } } }
  const bad = await run(denied)
  check(bad.ok === false && bad.error && bad.error.kind === 'auth', 'D: a rejected credential is an auth failure, never an empty list of maps (got ' + why(bad) + ')')
  const noHttp = await run({ ctx: {} })
  check(noHttp.ok === false && noHttp.error && noHttp.error.kind === 'env', 'D: a room wired without an HTTP channel is an environment failure, loud and not an empty list (got ' + why(noHttp) + ')')
  const mustNotBeStub = [fail2, fail1, noCursor, noInfo, junk, bad, noHttp].every((r) => !(r.error && r.error.kind === 'unsupported'))
  check(mustNotBeStub, 'D: no failure of a real read is dressed as "unsupported": that answer is what makes the callers fall back to a path that cannot work on this room')
}

// E) what the callers see
{
  check(CAP_PAGES === 10, 'E: the shared table carries the page cap for the linear room, 10 pages like the GitHub and GitLab rooms (got ' + show(CAP_PAGES) + ')')
  check(PAGINATION.github.mapListMaxPages === CAP_PAGES && PAGINATION.gitlab.mapListMaxPages === CAP_PAGES, 'E: and the three remote rooms cap the map list at the same number of pages, so the rooms do not behave differently')
  const f = fake({ tickets: [node(1), node(2, { closed: true })] })
  const got = await run(f)
  const issues: any[] = got.ok ? thinMapRowsToIssues(got.data.rows, { state: 'all' }) : []
  check(issues.length === 2, 'E: deck_issue_list turns the rows into the rows it returns, none lost (got ' + issues.length + ')')
  const open: any[] = got.ok ? thinMapRowsToIssues(got.data.rows, { state: 'open' }) : []
  check(open.length === 1 && String(open[0].key) === 'ENG-1', 'E: and its state filter works on them: asking for open maps gives the open one (got ' + show(open.map((r: any) => r.key)) + ')')
  const prose = fs.readFileSync(path.join(ROOT, 'src/tracker/contract/index.ts'), 'utf8').split('\n').find((l) => l.includes('} listMaps ')) || ''
  check(prose.length > 0 && !/暂由注册表补 unsupported 桩/.test(prose), 'E: the contract line for listMaps no longer says GitLab and local Markdown fall back to the stub')
  check(/GitHub/.test(prose) && /GitLab/.test(prose) && /Linear/.test(prose) && /Markdown/.test(prose), 'E: it names all four rooms as real implementations (got ' + show(prose.slice(prose.indexOf('GitHub 实现'))) + ')')
}

printGateResult('verify-89-linear-list-maps', assertions, failed)
if (failed) process.exit(1)
