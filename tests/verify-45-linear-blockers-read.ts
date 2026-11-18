// tests/verify-45-linear-blockers-read.ts: the Linear room reads who blocks a ticket when it reads one ticket (#45).
//
// Why this gate exists: on a Linear map the cards were all "Ready" and "Blocked 0" although blockers had been linked, and the deck could write
// blockers but never read them back. The room only read `inverseRelations` inside the write path (setBlockedBy); no read asked for them, so a ticket
// read from Linear never carried `blockedBy`. This gate runs the real room read over a fake HTTP channel that answers like Linear: it honours the
// literal `first` written in the query and says `hasNextPage` when there are more relations than that. It also checks the query against Linear's
// own complexity rule (see tests/lib/linear-complexity.ts), because a query over 10,000 points is rejected as a whole.
// Rules checked: only relations of type `blocks` count; the state is what Linear says (an unreadable state is left out, never "open"); a ticket
// with no blockers has an empty list (known empty); a list cut short by the page limit is NOT returned, because a partial list read as complete
// would say "ready" about a ticket that is blocked; a read that did not ask for relations carries no `blockedBy` at all.
// 门禁归属: src/tracker/rooms/linear/read.ts
// 门禁归属: src/tracker/rooms/linear/queries.ts
// 门禁归属: src/tracker/rooms/linear/relations.ts
// 门禁归属: src/refresh/rooms/host/comment-thread-fetch.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-blockers-read.ts
import { printGateResult } from './lib/gate-result.ts'
import { complexityOf } from './lib/linear-complexity.ts'
import { createCommentThreads } from '../src/refresh/rooms/host/comment-thread-fetch.ts'
import { getIssue } from '../src/tracker/rooms/linear/read.ts'
import { ISSUE_QUERY, ISSUE_WITH_COMMENTS_QUERY } from '../src/tracker/rooms/linear/queries.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'
const ISSUE_NODE = { id: 'u-918', identifier: 'OMB-918', title: 'Inventariar as issues', description: 'd', url: 'https://linear.app/x/issue/OMB-918', createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T11:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'OMB', name: 'Ombrello' }, parent: { identifier: 'OMB-916' }, assignee: null, labels: { nodes: [] } }

/** A relation node as Linear sends it in `inverseRelations`. `stateType` null = Linear sent no state; `ident` null = the other ticket is not visible. */
const rel = (type: string, ident: string | null, title = '', stateType: string | null = 'unstarted'): any => ({ id: 'r-' + String(ident), type, issue: ident === null ? null : { identifier: ident, title, state: stateType === null ? null : { type: stateType } } })

/** A fake Linear channel. `rels` is the whole set of relations pointing at the ticket; the query decides how many of them come back. */
function channel(rels: any[], opts: { omitRelations?: boolean } = {}): { ctx: any, calls: any[] } {
  const calls: any[] = []
  const ctx = { http: { request: async (req: any) => {
    calls.push(req)
    const query = String(JSON.parse(req.body).query)
    const m = /inverseRelations\(first:\s*(\d+)\)/.exec(query)
    const node: any = Object.assign({}, ISSUE_NODE)
    if (m && !opts.omitRelations) { const n = Number(m[1]); node.inverseRelations = { nodes: rels.slice(0, n), pageInfo: { hasNextPage: rels.length > n } } }
    if (/comments\(last:/.test(query)) node.comments = { nodes: [{ id: 'c1', body: 'hello', createdAt: '2026-11-18T10:30:00Z', user: { name: 'u', displayName: 'U' } }], pageInfo: { hasPreviousPage: false } }
    return { status: 200, headers: {}, body: JSON.stringify({ data: { issue: node } }) }
  } } }
  return { ctx, calls }
}
const refsOf = (r: any): any[] | undefined => (r && r.ok ? r.data.blockedBy : undefined)
const keysOf = (r: any): string => (refsOf(r) || []).map((x: any) => x.key).join(',')

// A) the queries ask for the relations with an explicit page, and the page info that tells whether it was cut short
for (const [name, q] of [['ISSUE_QUERY', ISSUE_QUERY], ['ISSUE_WITH_COMMENTS_QUERY', ISSUE_WITH_COMMENTS_QUERY]] as [string, string][]) {
  check(/inverseRelations\(first:\s*250\)/.test(q), 'A: ' + name + ' asks for inverseRelations with an explicit first of 250 (the schema cap), never the default 50')
  check(/inverseRelations\([^)]*\)\s*\{\s*pageInfo\s*\{\s*hasNextPage\s*\}/.test(q), 'A: ' + name + ' asks whether that page was cut short (pageInfo hasNextPage)')
  check(/issue\s*\{\s*identifier\s+title\s+state\s*\{\s*type\s*\}\s*\}/.test(q), 'A: ' + name + ' takes the blocker identifier, title and state type, nothing heavier')
}

// B) what counts as a blocker, and how it is written
{
  const rels = [rel('blocks', 'OMB-917', 'Definir o problema', 'unstarted'), rel('related', 'OMB-800', 'Related one'), rel('blocks', 'OMB-915', 'Feito', 'completed'), rel('duplicate', 'OMB-801', 'A copy'), rel('blocks', 'OMB-914', 'Sem estado', null), rel('blocks', null), rel('blocks', 'OMB-913', 'Cancelado', 'canceled'), rel('blocks', 'OMB-912', 'Em curso', 'started')]
  const got: any = await getIssue(channel(rels).ctx, ACCOUNT, 'OMB-918')
  const refs = refsOf(got) || []
  check(got.ok === true && Array.isArray(refs), 'B: the ticket carries blockedBy as an array (got ' + JSON.stringify(refs).slice(0, 60) + ')')
  check(keysOf(got) === 'OMB-917,OMB-915,OMB-914,OMB-913,OMB-912', 'B: only relations of type blocks count, in Linear\'s order; related and duplicate are left out; a ticket that cannot be seen is skipped (got ' + keysOf(got) + ')')
  check(!!refs[0] && refs[0].title === 'Definir o problema' && refs[0].state === 'open', 'B: an unstarted blocker is open and keeps its title')
  check(!!refs[1] && refs[1].state === 'closed', 'B: a completed blocker is closed')
  check(!!refs[2] && !('state' in refs[2]) && refs[2].title === 'Sem estado', 'B: a blocker whose state Linear did not send has NO state (unknown is never "open")')
  check(!!refs[3] && refs[3].state === 'closed' && !!refs[4] && refs[4].state === 'open', 'B: canceled counts as closed and started as open, by the same table the room uses for tickets')
}

// C) known empty, not asked, and cut short
{
  const none: any = await getIssue(channel([]).ctx, ACCOUNT, 'OMB-918')
  check(none.ok === true && Array.isArray(none.data.blockedBy) && none.data.blockedBy.length === 0, 'C: a ticket nobody blocks has an empty list: known empty')
  const onlyRelated: any = await getIssue(channel([rel('related', 'OMB-800', 'x')]).ctx, ACCOUNT, 'OMB-918')
  check(onlyRelated.ok === true && Array.isArray(onlyRelated.data.blockedBy) && onlyRelated.data.blockedBy.length === 0, 'C: a ticket with relations that are not blocks is also known empty')
  const notAsked: any = await getIssue(channel([rel('blocks', 'OMB-917', 'x')], { omitRelations: true }).ctx, ACCOUNT, 'OMB-918')
  check(notAsked.ok === true && notAsked.data.blockedBy === undefined, 'C: an answer without relations leaves blockedBy out: unknown, not "no blockers"')
  const exact250: any = await getIssue(channel(Array.from({ length: 250 }, (_, i) => rel('blocks', 'OMB-' + (1000 + i), 't'))).ctx, ACCOUNT, 'OMB-918')
  check(exact250.ok === true && (refsOf(exact250) || []).length === 250, 'C: exactly 250 relations is a complete list (Linear says there is no next page)')
  const cut: any = await getIssue(channel(Array.from({ length: 260 }, (_, i) => rel('blocks', 'OMB-' + (1000 + i), 't'))).ctx, ACCOUNT, 'OMB-918')
  check(cut.ok === true && cut.data.blockedBy === undefined, 'C: 260 relations is cut short, so blockedBy is left out: a partial list read as complete would say "ready" about a blocked ticket')
  check(cut.ok === true && cut.data.title === 'Inventariar as issues' && cut.data.parentKey === 'OMB-916', 'C: and the rest of the ticket is still returned')
}

// D) with comments in the same request
{
  const ch = channel([rel('blocks', 'OMB-917', 'Definir', 'unstarted')])
  const got: any = await getIssue(ch.ctx, ACCOUNT, 'OMB-918', { comments: { first: 50 } } as any)
  check(ch.calls.length === 1, 'D: comments and blockers come in one request')
  check(got.ok === true && keysOf(got) === 'OMB-917' && Array.isArray(got.data.comments) && got.data.comments.length === 1, 'D: the ticket carries both its blockers and its comments')
}

// E) the host detail over the real room read
{
  const rels = [rel('blocks', 'OMB-917', 'Definir o problema', 'unstarted'), rel('blocks', 'OMB-915', 'Feito', 'completed'), rel('blocks', 'OMB-914', 'Sem estado', null)]
  const opened = { ok: true, backendId: 'linear', budget: {}, canWrite: false, repoRef: { backend: 'linear', refId: CWD, name: 'repo', url: '' }, call: async (fn: any) => fn({ get: async (_r: any, key: string, o: any) => getIssue(channel(rels).ctx, ACCOUNT, key, o) }, { cwd: CWD, caller: 'refresh' }) }
  const host = createCommentThreads({ openSession: async () => opened, normCwd: async (x: any) => x, selectEarly: async () => { throw new Error('unused') }, isComposerSelection: () => false, getTrackerRegistry: async () => ({}), getPlatform: async () => ({}), ctx: {}, timer: {}, DEFAULT_CWD: '', errText: (e: any) => String((e && e.message) || e), isRateLimitError: () => false, getRepoKey: async () => null, execProc: async () => { throw new Error('unused') }, fetchIssueDetail: async () => { throw new Error('unused') }, fetchIssueIndex: async () => { throw new Error('unused') }, issueIndexFromSnapshot: () => ({}), setCache: () => {}, logCtx: { fire: () => {} } } as any)
  const d: any = await host.handleIssueDetail({ number: 'OMB-918', cwd: CWD })
  const nodes: any[] = (d && d.issue && d.issue.blockedBy && d.issue.blockedBy.nodes) || []
  check(d.ok === true && nodes.length === 3, 'E: the panel detail receives the three blockers (got ' + String(nodes.length) + ')')
  check(!!nodes[0] && nodes[0].number === 'OMB-917' && nodes[0].title === 'Definir o problema' && nodes[0].state === 'OPEN', 'E: the first is OMB-917, open, with its title (the host keeps the text key in number)')
  check(!!nodes[1] && nodes[1].number === 'OMB-915' && nodes[1].state === 'CLOSED', 'E: the second is OMB-915, closed')
  check(!!nodes[2] && nodes[2].number === 'OMB-914' && !('state' in nodes[2]), 'E: the third has no state: the panel does not take it for open')
}

// F) the complexity budget: Linear rejects a single query above 10,000 points
{
  check(complexityOf('query WhoAmI { user(id: "me") { name } }') === 2, 'F: the estimator gives 2 for Linear\'s first documented example')
  check(complexityOf('query C { user(id: "me") { createdIssues { nodes { id title createdAt } } } }') === 66, 'F: and 66 for the second (default page of 50)')
  check(complexityOf('query M { user(id: "me") { createdIssues(first: 10) { nodes { id title createdAt } } } }') === 14, 'F: and 14 for the third (first: 10)')
  const detail = complexityOf(ISSUE_QUERY, {})
  const withComments = complexityOf(ISSUE_WITH_COMMENTS_QUERY, { last: 200 })
  check(detail < 5000, 'F: the single ticket query stays far under the limit (' + String(detail) + ' of 10,000)')
  check(withComments < 5000, 'F: the single ticket query with 200 comments and 250 relations stays far under the limit (' + String(withComments) + ' of 10,000)')
}
printGateResult('verify-45-linear-blockers-read', assertions, failed)
if (failed) process.exit(1)
