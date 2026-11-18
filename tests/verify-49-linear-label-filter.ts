// tests/verify-49-linear-label-filter.ts: the Linear room filters by label, in Linear's own filter language (#49).
//
// Why this gate exists: the panel builds a workspace snapshot and, when it has no closed map row yet, asks for one page of
// closed tickets that carry the map label (`src/host/tracker/snapshotWorkingSet.ts`:
// `tracker.listPage(ref, { state: 'closed', labels: [MAP_LABEL] }, ...)`). The Linear room refused every non-empty `labels`
// filter ("this room cannot count or page by labels yet"), so for a Linear workspace that page was always an error and a
// closed wayfinder map never appeared. Measured before the change, with this same fake channel:
// `listPage({ state: 'closed', labels: ['wayfinder:map'] })` answered `{ ok: false, error: { kind: 'unsupported' } }` after
// 0 requests, while the same call without labels was ok after 2 requests (one page, one count walk).
//
// What is asserted, always on the request that actually leaves for the fake channel (not only on the answer being ok):
//   F1  listPage: the page request AND its count walk carry the same label condition, next to the state condition, and the
//       page size and the creation-time order that already worked are unchanged.
//   F2  listPage cursor path: the caller's cursor goes out verbatim, the label condition rides along on every page, and the
//       next cursor Linear gives comes back verbatim.
//   F3  counts: with no state both walks (open, closed) carry the label condition; with a state only that walk is sent.
//   F4  list: the single page read carries the label condition too.
//   F5  one shared builder: the filter of the page, of the count and of the list are the same object for the same
//       ListFilter, so a count and the page it describes can never mean different tickets.
//   F6  several labels mean AND (the contract: "must carry all of these labels"), written as one `labels.and` of `some`
//       branches; names are trimmed and de-duplicated without regard to case; blanks and an empty list add no condition.
//   F7  everything that is still not expressible stays refused with zero requests (type, parentKey, keys, isPullRequest:true),
//       also when a label filter is combined with it, and the refusal no longer names labels.
//   F8  the other rooms' vocabulary is untouched: the Linear room still answers for `state` and `since` exactly as before.
//
// 门禁归属: src/tracker/rooms/linear/read.ts
// 门禁归属: src/tracker/rooms/linear/paging.ts
// 门禁归属: src/tracker/rooms/linear/account-read.ts
// 门禁归属: src/tracker/rooms/linear/index.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-49-linear-label-filter.ts
import { isDeepStrictEqual } from 'node:util'
import { printGateResult } from './lib/gate-result.ts'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.ts'
import { buildIssuesFilter, unsupportedFilters } from '../src/tracker/rooms/linear/read.ts'
import { CLOSED_STATE_TYPES } from '../src/tracker/rooms/linear/normalize.ts'
import { MAX_PAGE } from '../src/tracker/rooms/linear/queries.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  assertions += 1
  if (!ok) failed += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok || detail === undefined ? '' : ' — ' + String(detail).slice(0, 500)))
}
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b)
const show = (value: unknown): string => JSON.stringify(value)
/** The filter a recorded call carried; a missing call (nothing was sent) reads as undefined so a red run reports instead of crashing. */
const filterOf = (call: { variables: any } | undefined): unknown => (call ? call.variables.filter : undefined)

const ACCOUNT = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const REPO = { backend: 'linear', refId: '/tmp/some-workspace', name: 'some-workspace', url: '' }
const MAP = 'wayfinder:map'

/** The three request kinds the room sends, told apart by the name Linear would see in the query text. */
type Kind = 'page' | 'count' | 'list' | 'other'
type Call = { kind: Kind; query: string; variables: any }
const kindOf = (query: string): Kind =>
  query.indexOf('LinearIssuePage') >= 0 ? 'page'
    : query.indexOf('LinearCountPage') >= 0 ? 'count'
      : query.indexOf('LinearIssuesWithBlockers') >= 0 ? 'list'
        : 'other'

/** One closed ticket carrying the map label, shaped as the thin page fragment returns it. */
const NODE = (n: number): any => ({
  id: 'u' + n, identifier: 'ENG-' + n, number: n, title: 'Map ' + n, description: '', url: 'https://linear.app/x/issue/ENG-' + n,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  state: { name: 'Done', type: 'completed' }, team: { key: 'ENG', name: 'Eng' },
  parent: null, assignee: null, labels: { nodes: [{ name: MAP, color: '#4ea7fc' }] },
})

/**
 * A fake Linear endpoint behind the room's real HTTP seam. Every request is recorded with its parsed GraphQL variables.
 * `pageNext` makes a page request say "there is a next page" with that cursor; counts always end on their first page.
 */
function fake(pageNext?: string): { backend: ReturnType<typeof createLinearBackend>; ctx: any; calls: Call[] } {
  const calls: Call[] = []
  const ctx: any = {
    http: {
      async request(req: any) {
        const body = JSON.parse(String(req.body || '{}'))
        const query = String(body.query || '')
        const kind = kindOf(query)
        calls.push({ kind, query, variables: body.variables })
        const hasNext = kind === 'page' && pageNext !== undefined
        const nodes = [NODE(2), NODE(1)]
        const connection = kind === 'count'
          ? { nodes: nodes.map((n) => ({ id: n.id })), pageInfo: { hasNextPage: false, endCursor: null } }
          : { nodes, pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? pageNext : null } }
        return { status: 200, headers: {}, body: JSON.stringify({ data: { issues: connection } }) }
      },
    },
    logEvent: () => {},
    isEnabled: () => false,
  }
  return { backend: createLinearBackend(ctx, ACCOUNT), ctx, calls }
}

const labelCondition = (name: string): any => ({ some: { name: { eqIgnoreCase: name } } })
const CLOSED = { state: { type: { in: CLOSED_STATE_TYPES } } }
const OPEN = { state: { type: { nin: CLOSED_STATE_TYPES } } }

async function main(): Promise<void> {
  console.log('F1 listPage with a label carries it on the page request and on the count walk')
  {
    const f = fake()
    const answer: any = await f.backend.listPage!(REPO as any, { state: 'closed', labels: [MAP] }, { limit: 20 }, f.ctx)
    check(answer.ok === true, 'the page is answered, not refused as unsupported', show(answer.error))
    check(answer.ok && answer.data.items.length === 2 && answer.data.total === 2, 'two rows and a total of two come back', show(answer.data))
    check(f.calls.length === 2, 'two requests leave: one page and one count walk of the closed state', String(f.calls.length))
    const page = f.calls.find((c) => c.kind === 'page')
    const count = f.calls.find((c) => c.kind === 'count')
    const expected = { ...CLOSED, labels: labelCondition(MAP) }
    check(!!page && same(page.variables.filter, expected), 'the page request filter is the closed state plus the label condition', show(page && page.variables.filter))
    check(!!count && same(count.variables.filter, expected), 'the count walk filter is that very same condition', show(count && count.variables.filter))
    check(!!page && page.variables.first === 20, 'the page size the caller asked for is still the page size sent', show(page && page.variables.first))
    check(!!page && page.query.indexOf('orderBy: createdAt') >= 0, 'the page is still read in creation-time order')
    check(!!count && count.variables.first === MAX_PAGE, 'the count walk still asks for the connection maximum', show(count && count.variables.first))
    check(!!page && page.variables.after === null, 'a first page sends no cursor', show(page && page.variables.after))
  }

  console.log('F2 the cursor path keeps working and keeps the label on every page')
  {
    const f = fake('CUR-NEXT')
    const answer: any = await f.backend.listPage!(REPO as any, { state: 'closed', labels: [MAP] }, { limit: 1, cursor: 'CUR-IN' }, f.ctx)
    check(answer.ok === true, 'a page asked with a cursor is answered', show(answer.error))
    const page = f.calls.find((c) => c.kind === 'page')
    check(!!page && page.variables.after === 'CUR-IN', 'the caller cursor goes out verbatim', show(page && page.variables.after))
    check(!!page && same(page.variables.filter, { ...CLOSED, labels: labelCondition(MAP) }), 'and the label condition rides along on that page', show(page && page.variables.filter))
    check(answer.ok && answer.data.nextCursor === 'CUR-NEXT', 'the next cursor Linear gives comes back verbatim', show(answer.ok && answer.data.nextCursor))
    check(!!page && page.variables.first === 1, 'a page size of 1 is sent as 1', show(page && page.variables.first))
  }

  console.log('F3 counts carries the label on every walk it sends')
  {
    const both = fake()
    const answer: any = await both.backend.counts!(REPO as any, { labels: [MAP] }, both.ctx)
    check(answer.ok === true && answer.data.total === 4, 'counts is answered (two walks of two)', show(answer.ok ? answer.data : answer.error))
    check(both.calls.length === 2 && both.calls.every((c) => c.kind === 'count'), 'two count walks leave, one per state', String(both.calls.length))
    check(same(filterOf(both.calls[0]), { ...OPEN, labels: labelCondition(MAP) }), 'the open walk is the open state plus the label', show(filterOf(both.calls[0])))
    check(same(filterOf(both.calls[1]), { ...CLOSED, labels: labelCondition(MAP) }), 'the closed walk is the closed state plus the label', show(filterOf(both.calls[1])))

    const only = fake()
    await only.backend.counts!(REPO as any, { state: 'closed', labels: [MAP] }, only.ctx)
    check(only.calls.length === 1 && same(filterOf(only.calls[0]), { ...CLOSED, labels: labelCondition(MAP) }), 'a narrowed state sends one walk with the label', show(only.calls.map((c) => c.variables.filter)))
  }

  console.log('F4 list carries the label too')
  {
    const f = fake()
    const answer: any = await f.backend.list!(REPO as any, { state: 'closed', labels: [MAP] }, f.ctx)
    check(answer.ok === true && answer.data.length === 2, 'list is answered with its rows', show(answer.error))
    check(f.calls.length === 1 && f.calls[0] !== undefined && f.calls[0].kind === 'list', 'one list request leaves', show(f.calls.map((c) => c.kind)))
    check(same(filterOf(f.calls[0]), { ...CLOSED, labels: labelCondition(MAP) }), 'its filter is the closed state plus the label condition', show(filterOf(f.calls[0])))
    check(f.calls[0] !== undefined && f.calls[0].variables.first === 50, 'and the page size is still the schema default of 50', show(f.calls[0] && f.calls[0].variables.first))
  }

  console.log('F5 one builder: the page, the count and the list send the same filter for the same ListFilter')
  {
    const filter = { state: 'closed' as const, labels: [MAP, 'bug'], since: '2026-11-01T00:00:00Z' }
    const p = fake(); await p.backend.listPage!(REPO as any, filter, undefined, p.ctx)
    const l = fake(); await l.backend.list!(REPO as any, filter, l.ctx)
    const pageFilter = filterOf(p.calls.find((c) => c.kind === 'page'))
    const countFilter = filterOf(p.calls.find((c) => c.kind === 'count'))
    const listFilter = filterOf(l.calls[0])
    check(same(pageFilter, countFilter), 'the page filter and its count filter are identical', show({ pageFilter, countFilter }))
    check(same(pageFilter, listFilter), 'and the list filter is that same one', show({ pageFilter, listFilter }))
    check(same(pageFilter, buildIssuesFilter(filter)), 'and it is exactly what the shared builder returns', show(buildIssuesFilter(filter)))
    check(same(buildIssuesFilter(filter), { ...CLOSED, updatedAt: { gte: '2026-11-01T00:00:00Z' }, labels: { and: [labelCondition(MAP), labelCondition('bug')] } }), 'state, window and labels are all expressed together', show(buildIssuesFilter(filter)))
    check(same(unsupportedFilters(filter), []), 'the refusal table has nothing to say about that filter', show(unsupportedFilters(filter)))
  }

  console.log('F6 several labels mean AND; spelling variants collapse; blanks add nothing')
  {
    check(same(buildIssuesFilter({ labels: ['bug'] }), { labels: labelCondition('bug') }), 'one label is one `some` condition on the name', show(buildIssuesFilter({ labels: ['bug'] })))
    check(same(buildIssuesFilter({ labels: ['bug', 'ready-for-agent'] }), { labels: { and: [labelCondition('bug'), labelCondition('ready-for-agent')] } }), 'two labels are two `some` branches under `and` (all must be carried), never one `in` (which would be any)', show(buildIssuesFilter({ labels: ['bug', 'ready-for-agent'] })))
    check(same(buildIssuesFilter({ labels: ['  bug ', 'BUG', 'bug'] }), { labels: labelCondition('bug') }), 'names are trimmed and de-duplicated without regard to case (the first spelling is sent)', show(buildIssuesFilter({ labels: ['  bug ', 'BUG', 'bug'] })))
    check(buildIssuesFilter({ labels: [] }) === undefined, 'an empty list adds no condition at all', show(buildIssuesFilter({ labels: [] })))
    check(buildIssuesFilter({ labels: ['', '   '] }) === undefined, 'blank names add no condition either', show(buildIssuesFilter({ labels: ['', '   '] })))
    check(same(buildIssuesFilter({ state: 'open', labels: [] }), OPEN), 'an empty list next to a state leaves exactly the state condition', show(buildIssuesFilter({ state: 'open', labels: [] })))
    check(!('labels' in (buildIssuesFilter({ state: 'open' }) || {})), 'no labels key appears when none were asked for')
    const f = fake()
    await f.backend.list!(REPO as any, { labels: ['bug', 'wayfinder:map'] }, f.ctx)
    check(same(filterOf(f.calls[0]), { labels: { and: [labelCondition('bug'), labelCondition(MAP)] } }), 'the AND shape is what actually leaves for the channel', show(filterOf(f.calls[0])))
  }

  console.log('F7 what is still not expressible stays refused, with zero requests')
  {
    const refused: [string, any][] = [
      ['type', { type: 'map' }],
      ['parentKey', { parentKey: 'ENG-100' }],
      ['parentKey', { parentKey: null }],
      ['keys', { keys: ['ENG-1'] }],
      ['isPullRequest', { isPullRequest: true }],
    ]
    for (const [name, extra] of refused) {
      for (const withLabels of [false, true]) {
        const filter = withLabels ? { ...extra, labels: [MAP] } : extra
        const f = fake()
        const viaList: any = await f.backend.list!(REPO as any, filter, f.ctx)
        const viaCounts: any = await f.backend.counts!(REPO as any, filter, f.ctx)
        const viaPage: any = await f.backend.listPage!(REPO as any, filter, undefined, f.ctx)
        const tag = name + (withLabels ? ' + labels' : '')
        check(!viaList.ok && viaList.error.kind === 'unsupported' && !viaCounts.ok && viaCounts.error.kind === 'unsupported' && !viaPage.ok && viaPage.error.kind === 'unsupported', 'list, counts and listPage all refuse (' + tag + ')', show([viaList, viaCounts, viaPage].map((r) => r.ok ? 'ok' : r.error.kind)))
        check(f.calls.length === 0, 'and not a single request leaves (' + tag + ')', String(f.calls.length))
        check([viaList, viaCounts, viaPage].every((r) => !r.ok && r.error.message.indexOf(name) >= 0), 'and each refusal names the cell it cannot honour (' + tag + ')')
        check([viaList, viaCounts, viaPage].every((r) => !r.ok && !/\blabels\b/.test(r.error.message)), 'and none of them blames labels, which are expressible now (' + tag + ')')
      }
    }
    check(same(unsupportedFilters({ labels: [MAP] }), []), 'unsupportedFilters no longer lists labels')
    check(same(unsupportedFilters({ type: 'map', labels: [MAP], keys: ['ENG-1'] }), ['type', 'keys']), 'but still lists the cells that are refused, in the table order', show(unsupportedFilters({ type: 'map', labels: [MAP], keys: ['ENG-1'] })))
    check(same(unsupportedFilters({ labels: [], isPullRequest: false }), []), 'an empty label list and isPullRequest:false are still not requirements')
  }

  console.log('F8 state and since are expressed exactly as before')
  {
    check(same(buildIssuesFilter({ state: 'closed' }), CLOSED), 'closed is still the closed state types')
    check(same(buildIssuesFilter({ state: 'open' }), OPEN), 'open is still the complement of them')
    check(same(buildIssuesFilter({ since: '2026-11-01T00:00:00Z' }), { updatedAt: { gte: '2026-11-01T00:00:00Z' } }), 'since is still the updatedAt window')
    check(buildIssuesFilter(undefined) === undefined && buildIssuesFilter({}) === undefined, 'no filter is no condition')
    const f = fake()
    const answer: any = await f.backend.listPage!(REPO as any, { state: 'closed' }, undefined, f.ctx)
    check(answer.ok === true && f.calls.length === 2 && f.calls.every((c) => same(c.variables.filter, CLOSED)), 'listPage without labels is still ok after 2 requests, filtered by state alone', show(f.calls.map((c) => c.variables.filter)))
  }

  printGateResult('verify-49-linear-label-filter', assertions, failed)
  if (failed) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(1) })
