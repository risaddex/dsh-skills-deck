// tests/verify-13-linear-paging.ts — the Linear room's counting, paging and budget reading (#13)
//
// Why this gate exists: these three reads are the ones that can lie quietly. A count that only
// counted the rows it happened to receive looks like a total, a last page that still offers a cursor
// makes the caller ask for a page that does not exist, and a budget number nobody measured reads
// exactly like one that was measured. Eight things are checked:
//   P1  counts walks the connection to its last page and reports Linear's own totals, asking for the
//       page size the connection allows and for the closed-state types from their one definition.
//   P2  a narrowed state counts only that state, the other number is 0 rather than unknown, and a
//       state value this room does not recognise means "both", as the contract says.
//   P3  a count that cannot be completed fails instead of reporting a lower bound (a page that has a
//       next one but no cursor, a connection without pageInfo, and walking past the page cap).
//   P4  a connection that does carry totalCount is believed without walking.
//   P5  listPage asks in creation-time order, clamps the page size into the connection's 1..250,
//       normalises its rows through the same reading the single-ticket read uses, and reports the
//       count of the same filter (narrowed or not) as the page total.
//   P6  cursors: a middle page offers Linear's cursor verbatim, the caller's cursor goes back
//       untouched, and the last page offers no cursor at all.
//   P7  a page whose count could not be read fails as a whole; a filter this room cannot express is
//       refused before any request; a stale cursor is a not-found with reload advice.
//   P8  readBudget reports "not measured" and sends nothing, instead of guessing a number.
//
// This gate is not registered in tests/gate-map.json yet (that file is outside this slice), so it
// prints no GATE-RESULT line: a completion record belongs to a registered gate, and inventing an
// expectation for one would turn a real red into a false green.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-paging.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'
import { CLOSED_STATE_TYPES } from '../src/tracker/rooms/linear/normalize.ts'
import { MAX_PAGE } from '../src/tracker/rooms/linear/queries.ts'
import { countsOf, listPageOf, readBudgetOf } from '../src/tracker/rooms/linear/paging.ts'
import { PAGINATION } from '../src/tracker/contract/pagination.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

/** One prepared answer: a GraphQL payload, or the errors[] Linear puts in an HTTP 200. */
type Reply = { payload?: any; errors?: any[] }

/** A context whose channel answers the prepared replies in order and remembers every call it made. */
function ctxAnswering(replies: Reply[]): { ctx: OpContext; calls: any[] } {
  const calls: any[] = []
  const ctx = {
    http: {
      async request(req: any) {
        calls.push(req)
        const reply = replies[calls.length - 1] || replies[replies.length - 1] || {}
        const body = reply.errors ? JSON.stringify({ errors: reply.errors }) : JSON.stringify({ data: reply.payload })
        return { status: 200, headers: {}, body }
      },
    },
    logEvent: () => {},
    isEnabled: () => false,
  } as unknown as OpContext
  return { ctx, calls }
}

/** One ticket node, shaped like the ones the thin page fragment asks for (no description). */
const node = (id: string) => ({
  id: 'uuid-' + id,
  identifier: 'ENG-' + id,
  title: 'ticket ' + id,
  url: 'https://linear.app/x/issue/ENG-' + id,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-02T10:00:00Z',
  state: { name: 'Todo', type: 'unstarted' },
  team: { key: 'ENG' },
  parent: null,
  assignee: null,
  labels: { nodes: [{ name: 'bug', color: '#EB5757' }] },
})

/** One connection answer. */
const page = (nodes: any[], hasNextPage: boolean, endCursor: string | null, totalCount?: number) => ({
  issues: { nodes, pageInfo: { hasNextPage, endCursor }, ...(totalCount === undefined ? {} : { totalCount }) },
})

const sent = (call: any) => (call ? JSON.parse(call.body) : { variables: {}, query: '' })

async function main(): Promise<void> {
  console.log('P1 counts walks the connection to its last page')
  {
    const { ctx, calls } = ctxAnswering([
      { payload: page([node('1'), node('2')], true, 'c-open-1') },
      { payload: page([node('3')], false, null) },
      { payload: page([node('4')], true, 'c-closed-1') },
      { payload: page([node('5'), node('6')], false, null) },
    ])
    const answer = await countsOf(ctx, ACCOUNT, undefined)
    check(answer.ok === true, 'the count answers', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && answer.data.open === 3 && answer.data.closed === 3 && answer.data.total === 6,
      'the three numbers are the totals of both walks', answer.ok ? JSON.stringify(answer.data) : '')
    check(calls.length === 4, 'each state was walked to its own last page', String(calls.length))
    check(sent(calls[1]).variables.after === 'c-open-1', 'the next page is asked with the cursor Linear gave', JSON.stringify(sent(calls[1]).variables))
    check(sent(calls[0]).variables.first === MAX_PAGE, 'a count page asks for the connection maximum', String(sent(calls[0]).variables.first))
    check(JSON.stringify(sent(calls[0]).variables.filter) === JSON.stringify({ state: { type: { nin: CLOSED_STATE_TYPES } } }),
      'the open walk asks for the open state types', JSON.stringify(sent(calls[0]).variables.filter))
  }

  console.log('P2 a narrowed state counts only that state')
  {
    const closedOnly = ctxAnswering([{ payload: page([node('7')], false, null) }])
    const answer = await countsOf(closedOnly.ctx, ACCOUNT, { state: 'closed' })
    check(answer.ok && answer.data.open === 0 && answer.data.closed === 1 && answer.data.total === 1,
      'the state that was not asked for is 0, not unknown', answer.ok ? JSON.stringify(answer.data) : JSON.stringify(answer.error))
    check(closedOnly.calls.length === 1, 'one walk for one state', String(closedOnly.calls.length))
    check(JSON.stringify(sent(closedOnly.calls[0]).variables.filter) === JSON.stringify({ state: { type: { in: CLOSED_STATE_TYPES } } }),
      'the closed walk asks for the closed state types', JSON.stringify(sent(closedOnly.calls[0]).variables.filter))

    const bothStates = ctxAnswering([
      { payload: page([node('8')], false, null) },
      { payload: page([node('9')], false, null) },
    ])
    const unknown = await countsOf(bothStates.ctx, ACCOUNT, { state: 'all' } as any)
    check(bothStates.calls.length === 2, 'a state value this room does not recognise means both states', String(bothStates.calls.length))
    check(unknown.ok && unknown.data.total === 2, 'and the total is the sum of both', unknown.ok ? JSON.stringify(unknown.data) : '')
  }

  console.log('P3 a count that cannot be completed fails instead of reporting a lower bound')
  {
    const noCursor = ctxAnswering([{ payload: { issues: { nodes: [node('1')], pageInfo: { hasNextPage: true, endCursor: null } } } }])
    const refused = await countsOf(noCursor.ctx, ACCOUNT, undefined)
    check(refused.ok === false && refused.error.kind === 'parse', 'a next page with no cursor is a parse failure', refused.ok ? 'ok' : refused.error.kind)
    check(noCursor.calls.length === 1, 'and the walk stops there', String(noCursor.calls.length))

    const noInfo = ctxAnswering([{ payload: { issues: { nodes: [node('1')] } } }])
    const unknown = await countsOf(noInfo.ctx, ACCOUNT, undefined)
    check(unknown.ok === false && unknown.error.kind === 'parse', 'a connection without pageInfo is a parse failure', unknown.ok ? 'ok' : unknown.error.kind)

    // The same answer forever: every page says there is a next one, so the walk runs into its cap.
    const endless = ctxAnswering([{ payload: page([node('1')], true, 'c1') }])
    const capped = await countsOf(endless.ctx, ACCOUNT, undefined)
    check(capped.ok === false && capped.error.kind === 'unsupported', 'walking past the page cap fails', capped.ok ? 'ok' : capped.error.kind)
    check(endless.calls.length === 40, 'and it really stopped at the cap, 40 pages', String(endless.calls.length))
  }

  console.log('P4 a totalCount on the connection is believed without walking')
  {
    const trusted = ctxAnswering([{ payload: page([], false, null, 42) }])
    const answer = await countsOf(trusted.ctx, ACCOUNT, { state: 'open' })
    check(answer.ok && answer.data.total === 42, 'the number Linear itself gave is the answer', answer.ok ? JSON.stringify(answer.data) : JSON.stringify(answer.error))
    check(trusted.calls.length === 1, 'and no second page is asked for', String(trusted.calls.length))
  }

  console.log('P5 listPage asks the way the contract says')
  {
    const { ctx, calls } = ctxAnswering([
      { payload: page([node('1')], true, 'opaque-1') },
      { payload: page([node('2')], false, null) },
      { payload: page([node('3')], false, null) },
    ])
    const answer = await listPageOf(ctx, ACCOUNT, undefined, { limit: 999 })
    check(answer.ok === true, 'the page answers', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(sent(calls[0]).variables.first === 200, 'a page size above the contract limit is clamped to the contract 200, not the connection 250', String(sent(calls[0]).variables.first))
    check(sent(calls[0]).variables.after === null, 'the first page asks for no cursor', JSON.stringify(sent(calls[0]).variables.after))
    check(String(sent(calls[0]).query).indexOf('orderBy: createdAt') >= 0, 'pages are asked in creation-time order', String(sent(calls[0]).query).slice(0, 120))
    check(answer.ok && answer.data.items.length === 1 && answer.data.items[0].key === 'ENG-1', 'the row is a normalised ticket', answer.ok ? JSON.stringify(answer.data.items) : '')
    check(answer.ok && answer.data.items[0].body === '', 'a page row carries no body', answer.ok ? JSON.stringify(answer.data.items[0].body) : '')
    check(answer.ok && answer.data.items[0].labels !== undefined && answer.data.items[0].labels[0].color === 'eb5757', 'the row went through the same label colour normalisation the reads use', answer.ok ? JSON.stringify(answer.data.items[0].labels) : '')
    check(answer.ok && answer.data.total === 2, 'the total comes from the same filter, not from the page', answer.ok ? String(answer.data.total) : '')

    const narrowed = ctxAnswering([
      { payload: page([node('4')], false, null) },
      { payload: page([node('5')], false, null) },
    ])
    const filtered = await listPageOf(narrowed.ctx, ACCOUNT, { state: 'open' }, undefined, undefined)
    check(narrowed.calls.length === 2, 'a narrowed page counts only its own state', String(narrowed.calls.length))
    check(filtered.ok && filtered.data.total === 1, 'and the total is that state count', filtered.ok ? String(filtered.data.total) : JSON.stringify(filtered.error))

    const sized = ctxAnswering([{ payload: page([], false, null) }, { payload: page([], false, null) }, { payload: page([], false, null) }])
    await listPageOf(sized.ctx, ACCOUNT, undefined, { limit: 0 })
    check(sent(sized.calls[0]).variables.first === 50, 'a page size of 0 falls back to Linear default 50', String(sent(sized.calls[0]).variables.first))
  }

  console.log('P6 cursors go out and come back untouched')
  {
    const middle = ctxAnswering([
      { payload: page([node('1')], true, 'next-==?&/x') },
      { payload: page([], false, null) },
      { payload: page([], false, null) },
    ])
    const answer = await listPageOf(middle.ctx, ACCOUNT, undefined, { cursor: 'prev-==?&/y' }, undefined)
    check(sent(middle.calls[0]).variables.after === 'prev-==?&/y', 'the caller cursor goes back exactly as it arrived', JSON.stringify(sent(middle.calls[0]).variables.after))
    check(answer.ok && answer.data.nextCursor === 'next-==?&/x', 'a middle page offers Linear cursor verbatim', answer.ok ? JSON.stringify(answer.data.nextCursor) : '')

    const last = ctxAnswering([
      { payload: page([node('9')], false, 'cursor-of-the-last-page') },
      { payload: page([], false, null) },
      { payload: page([], false, null) },
    ])
    const done = await listPageOf(last.ctx, ACCOUNT, undefined, undefined, undefined)
    check(done.ok === true, 'the last page answers', done.ok ? 'ok' : JSON.stringify(done.error))
    check(done.ok && done.data.nextCursor === null, 'the last page offers no cursor at all (null, not an empty string)', done.ok ? JSON.stringify(done.data.nextCursor) : '')
  }

  console.log('P7 failures are values, and they are the right ones')
  {
    // The page itself reads fine; the count behind it does not. A half receipt has no reader.
    const brokenCount = ctxAnswering([
      { payload: page([node('1')], false, null) },
      { payload: { issues: { nodes: [], pageInfo: {} } } },
    ])
    const whole = await listPageOf(brokenCount.ctx, ACCOUNT, undefined, undefined, undefined)
    check(whole.ok === false, 'a page without a fresh count fails as a whole', whole.ok ? 'ok' : JSON.stringify(whole.error))
    check(whole.ok === false && whole.error.kind === 'parse', 'and the failure is the count one, passed through', whole.ok ? 'ok' : whole.error.kind)

    const refusedFilter = ctxAnswering([{ payload: page([], false, null) }])
    // Labels used to be the example here; since #49 they are expressible (tests/verify-49-linear-label-filter.ts pins that),
    // so the example of "a filter this room cannot express" is now the batch-by-keys cell, which is still refused.
    const listKeys = await listPageOf(refusedFilter.ctx, ACCOUNT, { keys: ['ENG-1'] }, undefined, undefined)
    check(listKeys.ok === false && listKeys.error.kind === 'unsupported', 'a filter this room cannot express is refused by listPage', listKeys.ok ? 'ok' : listKeys.error.kind)
    const countKeys = await countsOf(refusedFilter.ctx, ACCOUNT, { keys: ['ENG-1'] })
    check(countKeys.ok === false && countKeys.error.kind === 'unsupported', 'and by counts, with the same table', countKeys.ok ? 'ok' : countKeys.error.kind)
    check(refusedFilter.calls.length === 0, 'and nothing is sent for either', String(refusedFilter.calls.length))

    const stale = ctxAnswering([{ errors: [{ message: 'Invalid input: the cursor is malformed' }] }])
    const staleAnswer = await listPageOf(stale.ctx, ACCOUNT, undefined, { cursor: 'gone' }, undefined)
    check(staleAnswer.ok === false && staleAnswer.error.kind === 'not-found', 'a stale cursor is a not-found', staleAnswer.ok ? 'ok' : staleAnswer.error.kind)
    check(staleAnswer.ok === false && staleAnswer.error.message.indexOf('please reload') >= 0, 'and it says the caller should reload', staleAnswer.ok ? '' : staleAnswer.error.message)
  }

  console.log('P8 readBudget does not invent a number')
  {
    const quiet = ctxAnswering([{ payload: {} }])
    const answer = await readBudgetOf(quiet.ctx)
    check(answer.ok === true, 'reading the budget answers', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && answer.data.known === false, 'it says the number was not measured', answer.ok ? JSON.stringify(answer.data) : '')
    check(answer.ok && answer.data.known === false && answer.data.reason === 'not-measured', 'the reason is "not measured", not "measured and failed"', answer.ok ? JSON.stringify(answer.data) : '')
    check(quiet.calls.length === 0, 'and reading the budget sends no request', String(quiet.calls.length))
  }

  console.log('P9 the caller limit is the page size, not a house default')
  {
    const { ctx, calls } = ctxAnswering([{ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }, { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }, { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }])
    await listPageOf(ctx, ACCOUNT, undefined, { limit: 3 })
    const listCall = calls.filter((c) => String(JSON.parse(c.body).query || '').indexOf('issues(') >= 0)[0]
    check(listCall && JSON.parse(listCall.body).variables.first === 3, 'a caller asking for 3 rows sends first: 3', listCall ? String(JSON.parse(listCall.body).variables.first) : '(no list call)')
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
