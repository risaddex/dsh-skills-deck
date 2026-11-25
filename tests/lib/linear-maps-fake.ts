// tests/lib/linear-maps-fake.ts: the fake Linear channel and the room entry shared by the two gates of #89
// (tests/verify-89-linear-list-maps.ts for the room, tests/verify-89-linear-list-maps-callers.ts for deck_context and deck_issue_list end to end).
// Why a helper: both gates must run the SAME real room over the SAME fake connection, or "the room is right" and "the tools work with it"
// could each pass against a different idea of what Linear sends. The fake behaves like a Relay connection over a list of tickets: it honours the
// filter (label compared without case, state), `first`, `after` (an opaque `c:<offset>` cursor) and `orderBy` (`createdAt` or `updatedAt`, newest first).
import { PAGINATION } from '../../src/tracker/contract/pagination.ts'
import { wrapTracker } from '../../src/tracker/registry/shape.ts'
import { createLinearBackend, linearModule } from '../../src/tracker/rooms/linear/index.ts'
import type { LinearAccount } from '../../src/tracker/rooms/linear/client.ts'

export const show = (v: unknown): string => JSON.stringify(v)

export const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key_SECRET' }
export const REPO: any = { backend: 'linear', refId: '/ws/ombrellosolar-backend', name: 'ombrellosolar-backend', url: '' }
/** The page size and the page cap the room is documented to use: both come from the shared table, never from the room. */
export const PAGE = PAGINATION.linear.listPageSize
export const CAP_PAGES = (PAGINATION.linear as any).mapListMaxPages as number
export const CAP_ROWS = PAGE * CAP_PAGES

/** Ticket number n of the fake workspace: a higher number was updated later. Maps carry the map label, other tickets do not. */
export const node = (n: number, o: { isMap?: boolean, closed?: boolean, updated?: number } = {}): any => ({
  id: 'uuid-' + n, identifier: 'ENG-' + n, number: n, title: (o.isMap === false ? 'Ticket ' : 'Map ') + n, url: 'https://linear.app/x/issue/ENG-' + n,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(), updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, o.updated === undefined ? n : o.updated)).toISOString(),
  state: { name: o.closed ? 'Done' : 'Todo', type: o.closed ? 'completed' : 'unstarted' },
  labels: { nodes: o.isMap === false ? [] : [{ name: 'wayfinder:map', color: '#112233' }] },
})
export const maps = (count: number, from: number = 1): any[] => Array.from({ length: count }, (_, i) => node(from + i))

export type FakeOpts = {
  /** Every ticket of the workspace, any order. The fake serves only what the request's filter lets through. */
  tickets: any[]
  failOnCall?: number
  noCursor?: boolean
  noPageInfo?: boolean
  /** Every page is empty but says there is a next page, for ever. */
  endless?: boolean
  /** Raw nodes put at the start of the first page (null and half-empty nodes). */
  junk?: any[]
  /** Serve oldest first even when the query names an order: the room must not rely on the order Linear sent. */
  scramble?: boolean
  /** Put the first ticket of page one again at the start of page two (a ticket that moved while the walk was going on). */
  repeatAcrossPages?: boolean
}

/** A fake Linear channel: a Relay connection over `tickets`. It honours the filter (label, state), `first`, `after` (`c:<offset>`) and `orderBy`. */
export function fake(opts: FakeOpts): { ctx: any, calls: any[], bodies: any[], events: any[] } {
  const calls: any[] = []
  const bodies: any[] = []
  const events: any[] = []
  const ctx = {
    opId: 'op-1',
    isEnabled: () => true,
    logEvent: (level: string, event: string, fields: any) => { events.push({ level, event, fields }) },
    http: { request: async (req: any) => {
      calls.push(req)
      const body = JSON.parse(req.body)
      bodies.push(body)
      if (opts.failOnCall === calls.length) return { status: 500, headers: {}, body: 'boom' }
      const vars = body.variables || {}
      const filter = vars.filter || {}
      let rows = opts.tickets.slice()
      // label condition: a ticket passes only if it carries a label the filter names (case-insensitive), like Linear's `labels.some.name.eqIgnoreCase`
      const wanted: string[] = []
      const collect = (c: any): void => { if (c && c.some && c.some.name && typeof c.some.name.eqIgnoreCase === 'string') wanted.push(c.some.name.eqIgnoreCase.toLowerCase()); if (c && Array.isArray(c.and)) c.and.forEach(collect) }
      collect(filter.labels)
      if (wanted.length > 0) rows = rows.filter((t) => wanted.every((w) => (t.labels.nodes as any[]).some((l) => String(l.name).toLowerCase() === w)))
      if (filter.state && filter.state.type && Array.isArray(filter.state.type.nin)) rows = rows.filter((t) => !filter.state.type.nin.includes(t.state.type))
      if (filter.state && filter.state.type && Array.isArray(filter.state.type.in)) rows = rows.filter((t) => filter.state.type.in.includes(t.state.type))
      if (filter.updatedAt && filter.updatedAt.gte) rows = rows.filter((t) => t.updatedAt >= filter.updatedAt.gte)
      // the sort key is the one the query names (`orderBy: createdAt` or `updatedAt`), newest first, like Linear
      const sortKey = /orderBy:\s*updatedAt/.test(String(body.query)) ? 'updatedAt' : 'createdAt'
      const newestFirst = !opts.scramble
      rows.sort((a, b) => (newestFirst ? (a[sortKey] < b[sortKey] ? 1 : -1) : (a[sortKey] < b[sortKey] ? -1 : 1)))
      const first = typeof vars.first === 'number' ? vars.first : 50
      const offset = typeof vars.after === 'string' && vars.after.startsWith('c:') ? Number(vars.after.slice(2)) : 0
      let nodes: any[]
      let hasNext: boolean
      if (opts.endless) { nodes = []; hasNext = true } else {
        nodes = rows.slice(offset, offset + first)
        hasNext = offset + first < rows.length
        if (opts.junk && offset === 0) nodes = [...opts.junk, ...nodes]
        if (opts.repeatAcrossPages && offset > 0 && rows.length > 0) nodes = [rows[0], ...nodes]
      }
      const conn: any = { nodes }
      if (!opts.noPageInfo) conn.pageInfo = { hasNextPage: hasNext, endCursor: hasNext && !opts.noCursor ? 'c:' + (offset + first) : null }
      return { status: 200, headers: {}, body: JSON.stringify({ data: { issues: conn } }) }
    } },
  }
  return { ctx, calls, bodies, events }
}

/** The room, reached the way the registry reaches it: the module's operations wrapped by `wrapTracker` (a missing operation answers the stub). */
export const trackerOf = (f: { ctx: any }): any => wrapTracker(linearModule as any, createLinearBackend(f.ctx, ACCOUNT), f.ctx)
export const run = async (f: { ctx: any }): Promise<any> => trackerOf(f).listMaps(REPO, f.ctx)
export const keysOf = (r: any): string[] => (r && r.ok && r.data && r.data.rows ? r.data.rows : []).map((x: any) => x.key)
export const why = (r: any): string => (r.ok ? 'ok with ' + r.data.rows.length + ' rows' : String(r.error && r.error.kind) + ': ' + String(r.error && r.error.message))
