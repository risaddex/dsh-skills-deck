// tests/verify-45-linear-blockers-list.ts: the rows of a Linear list carry who blocks them, within Linear's query limit (#45).
//
// Why this gate exists: step 1 made one ticket carry its blockers. The map does not read tickets one by one: its children come from the list
// the snapshot asks for (`list` with state open), and those rows had no blockedBy, so every card on a Linear map was Ready and the counter said
// Blocked 0. The list now asks for the relations of every row, but Linear rejects a whole query above 10,000 points and charges a nested
// connection by its `first` (50 when not written): written as 50 per row, the list of 50 tickets would cost 12,132 by the published rule and the
// panel list would go blank. So the page of relations per row is small and explicit (10 per row cost 5,132 in all), and a row
// with more relations than that is returned WITHOUT blockedBy, never with a partial list read as complete.
// This gate runs the real room list over a fake channel that honours both `first` values, checks the query against the published complexity
// rule (tests/lib/linear-complexity.ts), and follows the rows through the host's own snapshot assembly and normaliser into the map model the
// dock draws, to see the statuses and the counters the maintainer saw as "Blocked 0".
// 门禁归属: src/tracker/rooms/linear/read.ts
// 门禁归属: src/tracker/rooms/linear/queries.ts
// 门禁归属: src/host/tracker/snapshotAssemble.ts
// 门禁归属: src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-blockers-list.ts
import { printGateResult } from './lib/gate-result.ts'
import { complexityOf } from './lib/linear-complexity.ts'
import { listIssues } from '../src/tracker/rooms/linear/read.ts'
import * as Q from '../src/tracker/rooms/linear/queries.ts'
import { assembleSnapshot, normalizeMapTickets } from '../src/host/tracker/snapshotAssemble.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }
const show = (v: unknown): string => JSON.stringify(v)

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const REPO: any = { backend: 'linear', refId: '/ws/ombrellosolar-backend', name: 'repo', url: '' }
const node = (n: number, extra: any = {}): any => ({ id: 'u' + n, identifier: 'OMB-' + n, title: 'T' + n, description: '', url: 'https://linear.app/x/issue/OMB-' + n, createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T11:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'OMB', name: 'O' }, parent: { identifier: 'OMB-916' }, assignee: null, labels: { nodes: [] }, ...extra })
const rel = (type: string, ident: string, title: string, stateType: string | null = 'unstarted'): any => ({ id: 'r-' + ident, type, issue: { identifier: ident, title, state: stateType === null ? null : { type: stateType } } })
type Spec = { node: any, rels: any[] }

/** A fake Linear channel for the list query. It honours `first` of the page and the literal `first` of the relations written in the query. */
function channel(pool: Spec[]): { ctx: any, calls: any[] } {
  const calls: any[] = []
  const ctx = { http: { request: async (req: any) => {
    calls.push(req)
    const body = JSON.parse(req.body)
    const per = /inverseRelations\(first:\s*(\d+)\)/.exec(String(body.query))
    const first = typeof body.variables.first === 'number' ? body.variables.first : 50
    const nodes = pool.slice(0, first).map((s) => (per ? Object.assign({}, s.node, { inverseRelations: { nodes: s.rels.slice(0, Number(per[1])), pageInfo: { hasNextPage: s.rels.length > Number(per[1]) } } }) : s.node))
    return { status: 200, headers: {}, body: JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: pool.length > first, endCursor: null } } } }) }
  } } }
  return { ctx, calls }
}
const keysOf = (issue: any): string => ((issue && issue.blockedBy) || []).map((r: any) => r.key).join(',')

// The map of the maintainer's workspace: OMB-916 with four children. 918 is blocked by 917; 919 by 918 and 917; 920 and 917 by nobody.
const MAP = node(916, { parent: null, labels: { nodes: [{ name: 'wayfinder:map', color: '#4EA7FC' }] } })
const POOL: Spec[] = [
  { node: MAP, rels: [] },
  { node: node(917), rels: [] },
  { node: node(918), rels: [rel('blocks', 'OMB-917', 'T917')] },
  { node: node(919), rels: [rel('blocks', 'OMB-918', 'T918'), rel('related', 'OMB-800', 'Related'), rel('blocks', 'OMB-917', 'T917')] },
  { node: node(920), rels: [] },
]

// A) the query
{
  const listQuery = String((Q as any).ISSUES_WITH_BLOCKERS_QUERY || '')
  check((Q as any).LIST_BLOCKERS_PER_TICKET === 10, 'A: the page of relations per row is 10 and is a named value (got ' + String((Q as any).LIST_BLOCKERS_PER_TICKET) + ')')
  check(/inverseRelations\(first:\s*10\)\s*\{\s*pageInfo\s*\{\s*hasNextPage\s*\}/.test(listQuery), 'A: the list query asks for the relations of each row with an explicit first of 10 and the page info')
  check(!/inverseRelations(?!\(first:)/.test(listQuery), 'A: no inverseRelations in the list query is left to the default page of 50')
  check(!/inverseRelations/.test(Q.ISSUES_QUERY), 'A: the plain ISSUES_QUERY, used by the multi-account inbox, is untouched and asks for no relations')
  const ch = channel(POOL)
  await listIssues(ch.ctx, ACCOUNT)
  const sent = ch.calls[0] ? JSON.parse(ch.calls[0].body) : null
  check(!!sent && /inverseRelations\(first:\s*10\)/.test(sent.query) && sent.variables.first === 50, 'A: listIssues sends that query, for a page of 50 rows')
}

// B) the complexity budget, by Linear's published rule
{
  const listQuery = String((Q as any).ISSUES_WITH_BLOCKERS_QUERY || 'query X { x }')
  const now = complexityOf(listQuery, { first: 50 })
  const before = complexityOf(Q.ISSUES_QUERY, { first: 50 })
  check(now < 7000, 'B: the list query of 50 rows costs ' + String(now) + ' of the 10,000 allowed, with room to spare (it was ' + String(before) + ' before relations)')
  check(before > 3000 && before < 4000, 'B: and the plain list query costs ' + String(before) + ', which is what the maintainer\'s workspace already runs')
  const fifty = complexityOf(listQuery.replace('inverseRelations(first: 10)', 'inverseRelations(first: 50)'), { first: 50 })
  const dflt = complexityOf(listQuery.replace('inverseRelations(first: 10)', 'inverseRelations'), { first: 50 })
  check(fifty > 10000, 'B: the same query with 50 relations per row would cost ' + String(fifty) + ' and be rejected as a whole: this is why the limit is small')
  check(dflt > 10000, 'B: and so would leaving the relations at the default page (' + String(dflt) + ')')
}

// C) each row carries its own blockers
{
  const got: any = await listIssues(channel(POOL).ctx, ACCOUNT)
  const rows: any[] = got.ok ? got.data : []
  const byKey = (k: string): any => rows.find((r: any) => r.key === k)
  check(got.ok === true && rows.length === 5, 'C: the list answers with the five rows')
  check(Array.isArray(byKey('OMB-917').blockedBy) && byKey('OMB-917').blockedBy.length === 0, 'C: OMB-917, which nobody blocks, has an empty list: known empty')
  check(keysOf(byKey('OMB-918')) === 'OMB-917' && byKey('OMB-918').blockedBy[0].state === 'open' && byKey('OMB-918').blockedBy[0].title === 'T917', 'C: OMB-918 is blocked by the open OMB-917, with its title')
  check(keysOf(byKey('OMB-919')) === 'OMB-918,OMB-917', 'C: OMB-919 is blocked by OMB-918 and OMB-917; the related ticket is not a blocker (got ' + keysOf(byKey('OMB-919')) + ')')
  check(Array.isArray(byKey('OMB-920').blockedBy) && byKey('OMB-920').blockedBy.length === 0, 'C: OMB-920 has an empty list')
}

// D) a row with more relations than the page is returned without blockedBy, and only that row
{
  const crowded: Spec = { node: node(917), rels: Array.from({ length: 11 }, (_, i) => rel('blocks', 'OMB-' + (100 + i), 'B' + i)) }
  const got: any = await listIssues(channel([POOL[0], crowded, POOL[2]]).ctx, ACCOUNT)
  const rows: any[] = got.ok ? got.data : []
  const byKey = (k: string): any => rows.find((r: any) => r.key === k)
  check(got.ok === true && byKey('OMB-917') && byKey('OMB-917').blockedBy === undefined, 'D: a row with 11 relations (page of 10) has NO blockedBy: unknown, never a partial list read as complete')
  check(!!byKey('OMB-917') && byKey('OMB-917').title === 'T917', 'D: the row itself is still returned')
  check(keysOf(byKey('OMB-918')) === 'OMB-917', 'D: the other rows keep their blockers')
  const exact: Spec = { node: node(917), rels: Array.from({ length: 10 }, (_, i) => rel('blocks', 'OMB-' + (100 + i), 'B' + i)) }
  const ok10: any = await listIssues(channel([exact]).ctx, ACCOUNT)
  check(ok10.ok === true && ((ok10.data[0] && ok10.data[0].blockedBy) || []).length === 10, 'D: exactly 10 relations is a complete list')
}

// E) the page itself: more rows than one page is still reported as truncated, and the rows of the page keep their blockers
{
  const many: Spec[] = Array.from({ length: 60 }, (_, i) => ({ node: node(1000 + i), rels: i % 2 ? [rel('blocks', 'OMB-1000', 'T1000')] : [] }))
  const got: any = await listIssues(channel(many).ctx, ACCOUNT)
  check(got.ok === true && got.data.length === 50 && got.truncated === true, 'E: 60 tickets give a page of 50 and truncated (the honest page flag is unchanged)')
  check(got.ok === true && got.data.every((r: any) => Array.isArray(r.blockedBy)) && keysOf(got.data[1]) === 'OMB-1000', 'E: every row of the page carries its blockers')
}

// F) the map the dock draws: host assembly, host normaliser, then the map model
{
  const g: any = globalThis
  g.prStateKind = (await import('../src/client/views/shared/stateKind.ts')).prStateKind
  g.detailTopGate = (await import('../src/client/kernel/detail-top-gate.ts')).detailTopGate
  const facts: any = await import('../src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts')
  const board: any = await import('../src/client/views/mapDetailV2/model/tickets/ticketBoard.ts')
  const got: any = await listIssues(channel(POOL).ctx, ACCOUNT)
  const snap: any = assembleSnapshot(REPO, got.ok ? got.data : [])
  const map = (snap.maps || []).find((m: any) => m.key === 'OMB-916')
  check(!!map && map.tickets.length === 4, 'F: the host assembly puts the four children under OMB-916')
  // the host upper-cases the state when it hands the snapshot to the panel; the same step is done here
  const normalized = normalizeMapTickets(((map && map.tickets) || []).map((t: any) => Object.assign({}, t, { state: String(t.state).toUpperCase() }))).tickets
  const ENV: any = { cardIdPrefix: 'p', colorOf: {}, actionOf: () => 'execute', textOf: (key: string) => key }
  const ctx = facts.ticketFactsContextOf(normalized, ENV)
  const cards: any[] = normalized.map((r: any) => facts.ticketCardFactsOf(r, ctx))
  const status = (k: string): string => (cards.find((c: any) => c.rowKey === k) || {}).status
  check(show(['OMB-917', 'OMB-918', 'OMB-919', 'OMB-920'].map(status)) === show(['ready', 'blocked', 'blocked', 'ready']), 'F: the cards are ready, blocked, blocked, ready (got ' + show(['OMB-917', 'OMB-918', 'OMB-919', 'OMB-920'].map(status)) + ')')
  const c918 = cards.find((c: any) => c.rowKey === 'OMB-918') || {}
  check(!!c918.blockedBy && c918.blockedBy.no === 'OMB-917' && c918.blockedBy.title === 'T917', 'F: the card of OMB-918 says it is blocked by OMB-917 (got ' + show(c918.blockedBy) + ')')
  const c917 = cards.find((c: any) => c.rowKey === 'OMB-917') || {}
  check(!!c917.blocks && c917.blocks.no === 'OMB-918', 'F: and the card of OMB-917 points at the first ticket it blocks, OMB-918 (got ' + show(c917.blocks) + ')')
  check(show(board.boardCountsOf(cards)) === show({ total: 4, closed: 0, ready: 2, doing: 0, blocked: 2 }), 'F: the counters the maintainer saw as Ready 4 / Blocked 0 are now Ready 2 / Blocked 2 (got ' + show(board.boardCountsOf(cards)) + ')')
}
printGateResult('verify-45-linear-blockers-list', assertions, failed)
if (failed) process.exit(1)
