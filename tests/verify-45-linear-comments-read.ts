// tests/verify-45-linear-comments-read.ts: the Linear room reads a ticket's comments, and the host shows and pages them (#45).
//
// Why this gate exists: after a comment on OMB-903 was accepted by Linear, the panel still said "Comments (0)". The room wrote comments but
// never read them (read.ts said the read path was not implemented), so the host built an empty connection and the page presented "no
// comments" as a fact. The host asks `get(repo, key, { comments: { first: N } })` from zero with N growing by 50 and slices off what the
// page already holds, and it uses `commentCount` to know the total and whether another page exists. So the room has to return the OLDEST N
// comments, oldest first (Linear sends the newest first), and the total when it knows it. With more than 200 the room asks for `last: 200`, the
// OLDEST 200 of a newest-first list: new comments land at the other end, so the window the host pages through does not move (PR #47 review).
// This gate runs the real room read over a fake HTTP channel, then the real host handlers on top of it.
// 门禁归属: src/tracker/rooms/linear/read.ts
// 门禁归属: src/tracker/rooms/linear/queries.ts
// 门禁归属: src/tracker/rooms/linear/normalize.ts
// 门禁归属: src/refresh/rooms/host/comment-thread-fetch.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-comments-read.ts
import { printGateResult } from './lib/gate-result.ts'
import { createCommentThreads } from '../src/refresh/rooms/host/comment-thread-fetch.ts'
import { getIssue } from '../src/tracker/rooms/linear/read.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'
const ISSUE_NODE = { id: 'uuid-1', identifier: 'OMB-890', title: 'T', description: 'd', url: 'https://linear.app/x/issue/OMB-890', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'OMB', name: 'Ombrello' }, parent: null, assignee: null, labels: { nodes: [] } }

/** Comment number i (1 = oldest) as Linear sends it. */
const commentNode = (i: number): any => ({ id: 'c' + i, body: 'body ' + i, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), updatedAt: new Date(Date.UTC(2026, 10, 1, 0, i, 30)).toISOString(), user: { name: 'user' + i, displayName: 'User ' + i } })
/** n comments, NEWEST FIRST, the order Linear answers in. */
const newestFirst = (n: number): any[] => Array.from({ length: n }, (_, k) => commentNode(n - k))

/**
 * A fake Linear channel. `comments` is the WHOLE connection, newest first (null = the query did not ask for comments). It answers like a
 * Relay connection: `last: k` returns the k items at the END of the list (the oldest k) and says hasPreviousPage when more come before them;
 * `first: k` returns the k at the start (the newest k) and says hasNextPage. Whatever argument the room's query uses decides what it gets.
 */
function channel(comments: any[] | null, _unused = false, issue: any = ISSUE_NODE): { ctx: any, calls: any[] } {
  const calls: any[] = []
  const ctx = { http: { request: async (req: any) => {
    calls.push(req)
    const vars = JSON.parse(req.body).variables || {}
    let node: any = issue
    if (issue !== null && comments !== null) {
      const total = comments.length
      const conn = typeof vars.last === 'number'
        ? { nodes: comments.slice(Math.max(0, total - vars.last)), pageInfo: { hasPreviousPage: total > vars.last, hasNextPage: false } }
        : { nodes: comments.slice(0, typeof vars.first === 'number' ? vars.first : 50), pageInfo: { hasNextPage: total > (typeof vars.first === 'number' ? vars.first : 50), hasPreviousPage: false } }
      node = Object.assign({}, issue, { comments: conn })
    }
    return { status: 200, headers: {}, body: JSON.stringify({ data: { issue: node } }) }
  } } }
  return { ctx, calls }
}
const sentOf = (calls: any[]): any => (calls[0] ? JSON.parse(calls[0].body) : null)
const csOf = (r: any): any[] => (r && r.data && r.data.comments) || []
const bodies = (list: any[] | undefined): string => (list || []).map((c: any) => c.body.replace('body ', '')).join(',')

// A) the query that goes out
{
  const ch = channel(newestFirst(3))
  await getIssue(ch.ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  const sent = sentOf(ch.calls)
  check(ch.calls.length === 1, 'A: one request carries the ticket and its comments')
  check(!!sent && /comments\s*\(\s*last:\s*\$last/.test(sent.query), 'A: the query asks for the comments connection with a last argument: on a newest-first list that is the OLDEST comments, a window that new comments do not shift')
  check(!!sent && sent.variables.id === 'OMB-890', 'A: the key goes as Linear expects')
  check(!!sent && sent.variables.last === 200 && sent.variables.first === undefined, 'A: it always asks for the cap (200), never just the 50 the host wants: the host slices off what it already holds (got last ' + String(sent && sent.variables.last) + ')')
  check(!!sent && /hasPreviousPage/.test(sent.query), 'A: it asks whether there are more comments than the window (hasPreviousPage)')
  check(!!sent && /\bidentifier\b/.test(sent.query), 'A: the ticket fields still come in the same request')
}

// B) mapping and order
{
  const ch = channel(newestFirst(3))
  const got: any = await getIssue(ch.ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(got.ok === true && Array.isArray(got.data.comments) && csOf(got).length === 3, 'B: the comments come back as an array on the ticket')
  check(bodies(csOf(got)) === '1,2,3', 'B: oldest first, although Linear answered newest first (got ' + bodies(csOf(got)) + ')')
  const first = csOf(got)[0] || null
  check(!!first && first.id === 'c1' && first.author.login === 'user1' && first.author.name === 'User 1', 'B: id, author login and author name are mapped')
  check(!!first && first.createdAt === commentNode(1).createdAt && first.updatedAt === commentNode(1).updatedAt, 'B: createdAt and updatedAt are kept')
  check(!!first && first.authorAssociation === '', 'B: the association is empty, as for every backend without one')
  const odd = channel([{ id: 'x', body: 'b', createdAt: '2026-11-01T00:00:00Z', user: null }, { id: 'y', body: null, createdAt: '2026-11-01T00:01:00Z' }])
  const oddGot: any = await getIssue(odd.ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  const o: any[] = csOf(oddGot)
  check(!!o[0] && o[0].author.login === '' && o[0].updatedAt === '2026-11-01T00:00:00Z', 'B: a comment without an author has an empty login, and without updatedAt it uses createdAt')
  check(!!o[1] && o[1].body === '' && o[1].author.login === '', 'B: a null body is an empty string')
}

// C) how many come back, and the total
{
  const all = channel(newestFirst(120))
  const p50: any = await getIssue(all.ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(csOf(p50).length === 50 && csOf(p50)[0].id === 'c1' && csOf(p50)[49].id === 'c50', 'C: first 50 are the OLDEST 50, c1 to c50 (the host slices what it already holds)')
  check(p50.ok && p50.data.commentCount === 120, 'C: the total is known when Linear says there is no next page (commentCount 120, got ' + String(p50.data && p50.data.commentCount) + ')')
  const p100: any = await getIssue(channel(newestFirst(120)).ctx, ACCOUNT, 'OMB-890', { comments: { first: 100 } } as any)
  check(csOf(p100).length === 100 && csOf(p100)[99].id === 'c100', 'C: first 100 are c1 to c100')
  const few: any = await getIssue(channel(newestFirst(7)).ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(csOf(few).length === 7 && few.data.commentCount === 7, 'C: fewer comments than asked returns them all, with the exact total')
  const big: any = await getIssue(channel(newestFirst(250)).ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(csOf(big).length === 50 && csOf(big)[0].id === 'c1' && csOf(big)[49].id === 'c50', 'C: with 250 comments the first 50 are still the oldest of the ticket, c1 to c50 (a window of the newest 200 would start at c51)')
  check(csOf(big).length === 50 && big.ok && big.data.commentCount === undefined && big.data.comments !== undefined, 'C: when Linear says there are more than it sent, the total is NOT claimed (commentCount absent)')
  check(big.ok && big.data.commentsHasMore === true, 'C: when Linear says there are more than it sent, the ticket says so without a total (commentsHasMore true)')
  check(p50.ok && p50.data.commentsHasMore !== true && few.ok && few.data.commentsHasMore !== true, 'C: when the batch is everything, commentsHasMore is not set')
  const none: any = await getIssue(channel([]).ctx, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(none.ok && Array.isArray(none.data.comments) && csOf(none).length === 0 && none.data.commentCount === 0, 'C: a ticket with no comments says so: an empty array and a total of 0')
}

// D) comments not asked for: nothing changes
{
  for (const [name, opts] of [['no options', undefined], ['empty options', {}], ['first 0', { comments: { first: 0 } }]] as [string, any][]) {
    const ch = channel(null)
    const got: any = await getIssue(ch.ctx, ACCOUNT, 'OMB-890', opts)
    const sent = sentOf(ch.calls)
    check(got.ok && got.data.comments === undefined && got.data.commentCount === undefined, 'D: ' + name + ': the ticket carries no comments field (it does not claim "no comments")')
    check(!!sent && !/comments/.test(sent.query), 'D: ' + name + ': the query does not ask for comments')
  }
}

// E) failures stay failures
{
  const gone: any = await getIssue(channel(null, false, null).ctx, ACCOUNT, 'OMB-999', { comments: { first: 50 } } as any)
  check(gone.ok === false && gone.error.kind === 'not-found', 'E: a ticket that does not exist is still not-found when comments were asked')
  const denied = { http: { request: async () => ({ status: 401, headers: {}, body: '' }) } }
  const bad: any = await getIssue(denied, ACCOUNT, 'OMB-890', { comments: { first: 50 } } as any)
  check(bad.ok === false && bad.error.kind === 'auth', 'E: a rejected credential is still an auth failure, never an empty comment list')
}

// F) the real host handlers over the real room read
function hostFor(totalOrRef: number | { n: number }): any {
  const ref = typeof totalOrRef === 'number' ? { n: totalOrRef } : totalOrRef
  const opened = { ok: true, backendId: 'linear', budget: {}, canWrite: false, repoRef: { backend: 'linear', refId: CWD, name: 'repo', url: '' }, call: async (fn: any) => fn({ get: async (_repo: any, key: string, opts: any) => getIssue(channel(newestFirst(ref.n)).ctx, ACCOUNT, key, opts) }, { cwd: CWD, caller: 'refresh' }) }
  return createCommentThreads({ openSession: async () => opened, normCwd: async (x: any) => x, selectEarly: async () => { throw new Error('unused') }, isComposerSelection: () => false, getTrackerRegistry: async () => ({}), getPlatform: async () => ({}), ctx: {}, timer: {}, DEFAULT_CWD: '', errText: (e: any) => String((e && e.message) || e), isRateLimitError: () => false, getRepoKey: async () => null, execProc: async () => { throw new Error('unused') }, fetchIssueDetail: async () => { throw new Error('unused') }, fetchIssueIndex: async () => { throw new Error('unused') }, issueIndexFromSnapshot: () => ({}), setCache: () => {}, logCtx: { fire: () => {} } } as any)
}
{
  const d: any = await hostFor(120).handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  const conn = d && d.issue && d.issue.comments
  check(d.ok === true && !!conn && conn.nodes.length === 50, 'F: the detail shows the first 50 comments (got ' + String(conn && conn.nodes && conn.nodes.length) + ')')
  check(!!conn && !!conn.nodes[0] && !!conn.nodes[49] && conn.nodes[0].body === 'body 1' && conn.nodes[49].body === 'body 50', 'F: they are the oldest 50, in order')
  check(!!conn && conn.totalCount === 120 && conn.pageInfo.hasNextPage === true, 'F: the page knows the total (120) and offers the next page')
  const p2: any = await hostFor(120).handleIssueComments({ number: 'OMB-890', cwd: CWD, after: 50 })
  check(p2.ok === true && bodies(p2.nodes) === Array.from({ length: 50 }, (_, k) => k + 51).join(','), 'F: "load more" after 50 delivers exactly comments 51 to 100, no repeat')
  check(p2.ok && p2.pageInfo.hasNextPage === true && p2.pageInfo.totalCount === 120, 'F: and says there is one more page')
  const p3: any = await hostFor(120).handleIssueComments({ number: 'OMB-890', cwd: CWD, after: 100 })
  check(p3.ok === true && !!p3.nodes && p3.nodes.length === 20 && p3.nodes[0].body === 'body 101' && p3.nodes[19].body === 'body 120', 'F: the last page delivers comments 101 to 120')
  check(p3.ok && p3.pageInfo.hasNextPage === false, 'F: and the last page says there is no next page')
  const empty: any = await hostFor(0).handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  check(empty.ok === true && !!empty.issue && !!empty.issue.comments && empty.issue.comments.nodes.length === 0 && empty.issue.comments.totalCount === 0, 'F: a ticket without comments shows an honest zero')
}

// F2) more than 200 comments: the total is unknown, but the page must still offer the next page (review finding on PR #47)
{
  const d: any = await hostFor(250).handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  const conn = d && d.issue && d.issue.comments
  check(d.ok === true && !!conn && conn.nodes.length === 50, 'F2: with more than 200 comments the detail still shows the first 50')
  check(!!conn && conn.pageInfo.hasNextPage === true, 'F2: and it offers the next page, although the total is unknown (got ' + String(conn && conn.pageInfo && conn.pageInfo.hasNextPage) + ')')
  check(!!conn && conn.totalCount === 50, 'F2: it does not claim a total it does not know: the count stays at what was returned (got ' + String(conn && conn.totalCount) + ')')
  const p4: any = await hostFor(250).handleIssueComments({ number: 'OMB-890', cwd: CWD, after: 150 })
  check(p4.ok === true && p4.nodes.length === 50 && p4.nodes[0].body === 'body 151' && p4.nodes[49].body === 'body 200', 'F2: loading more reaches comment 200, the cap (no comment already fetched stays out of reach)')
  check(p4.ok && p4.pageInfo.hasNextPage === false, 'F2: at the cap it stops offering more')
}

// F3) review finding on PR #47: a comment arriving between two pages must not shift the pages (the window is the OLDEST 200, not a moving newest one)
{
  const ref = { n: 202 }
  const host = hostFor(ref)
  const d: any = await host.handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  const first = d && d.issue && d.issue.comments && d.issue.comments.nodes
  check(!!first && bodies(first) === Array.from({ length: 50 }, (_, k) => k + 1).join(','), 'F3: with 202 comments the first page is comments 1 to 50 (got ' + bodies(first).slice(0, 24) + '...)')
  ref.n = 203
  const p2: any = await host.handleIssueComments({ number: 'OMB-890', cwd: CWD, after: 50 })
  check(p2.ok === true && bodies(p2.nodes) === Array.from({ length: 50 }, (_, k) => k + 51).join(','), 'F3: a comment arrives, and the next page is still exactly 51 to 100, none skipped (got ' + bodies(p2.nodes).slice(0, 24) + '...)')
  ref.n = 210
  const p3: any = await host.handleIssueComments({ number: 'OMB-890', cwd: CWD, after: 100 })
  check(p3.ok === true && bodies(p3.nodes) === Array.from({ length: 50 }, (_, k) => k + 101).join(','), 'F3: seven more arrive, and the following page is still 101 to 150')
}

// G) the receipt of a comment on a backend that has no local library is not reported as a loss
function writeHostWith(receiptAnswer: any): any {
  const opened = { ok: true, backendId: 'linear', budget: {}, canWrite: true, repoRef: { backend: 'linear', refId: CWD, name: 'repo', url: '' }, call: async (fn: any) => fn({ comment: async () => ({ ok: true, data: { id: 'new', author: { login: 'me' }, authorAssociation: '', body: 'teste', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' } }) }, { cwd: CWD, caller: 'refresh' }) }
  return createCommentThreads({ openSession: async () => opened, normCwd: async (x: any) => x, selectEarly: async () => { throw new Error('unused') }, isComposerSelection: () => false, getTrackerRegistry: async () => ({}), getPlatform: async () => ({}), ctx: {}, timer: {}, DEFAULT_CWD: '', errText: (e: any) => String((e && e.message) || e), isRateLimitError: () => false, getRepoKey: async () => null, execProc: async () => { throw new Error('unused') }, fetchIssueDetail: async () => { throw new Error('unused') }, fetchIssueIndex: async () => { throw new Error('unused') }, issueIndexFromSnapshot: () => ({}), setCache: () => {}, logCtx: { fire: () => {} }, getSnapshotLibrary: receiptAnswer === null ? undefined : async () => ({ recordCommentReceipt: async () => receiptAnswer }) } as any)
}
for (const [name, answer, wantStored] of [
  ['the library does not support this backend', { ok: false, reason: 'unsupported-backend' }, true],
  ['the library committed it', { ok: true }, true],
  ['the library is degraded', { ok: true, degraded: true }, false],
  ['the library failed to commit', { ok: false, reason: 'not-committed' }, false],
] as [string, any, boolean][]) {
  const r: any = await writeHostWith(answer).handleCommentIssue({ number: 'OMB-890', body: 'teste', cwd: CWD })
  check(r.ok === true && r.stored === wantStored, 'G: ' + name + ' -> stored ' + String(wantStored) + ' (got ' + String(r.stored) + ')')
}
{
  const r: any = await writeHostWith(null).handleCommentIssue({ number: 'OMB-890', body: 'teste', cwd: CWD })
  check(r.ok === true && r.stored === false && r.storedReason === 'library-unavailable', 'G: no library at all is still reported as not stored, with its own reason (got ' + String(r.stored) + ', ' + String(r.storedReason) + ')')
  const u: any = await writeHostWith({ ok: false, reason: 'unsupported-backend' }).handleCommentIssue({ number: 'OMB-890', body: 'teste', cwd: CWD })
  check(u.storedReason === 'unsupported-backend', 'G: the reason is still passed on, so the log keeps saying why nothing was stored')
}
printGateResult('verify-45-linear-comments-read', assertions, failed)
if (failed) process.exit(1)
