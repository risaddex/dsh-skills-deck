// tests/lib/linear-sub-issues-fake.ts: the fake Linear channel and the room entry shared by the two gates of #50
// (tests/verify-50-linear-list-sub-issues.ts for the room, tests/verify-50-linear-list-sub-issues-callers.ts for the callers and the log).
// Why a helper: both gates must run the SAME real room over the SAME fake connection, or "the room is right" and "the callers work with
// it" could each pass against a different idea of what Linear sends. The fake behaves like a Relay connection: it honours `first`,
// `after` (an opaque `c:<offset>` cursor), `orderBy: createdAt` (newest first, as the room documents) and the literal page of relations.
import { wrapTracker } from '../../src/tracker/registry/shape.ts'
import { createLinearBackend, linearModule } from '../../src/tracker/rooms/linear/index.ts'
import type { LinearAccount } from '../../src/tracker/rooms/linear/client.ts'

export const show = (v: unknown): string => JSON.stringify(v)

export const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key_SECRET' }
export const REPO: any = { backend: 'linear', refId: '/ws/ombrellosolar-backend', name: 'ombrellosolar-backend', url: '' }
export const PARENT = 'ENG-12'
/** What the contract documents for this room: 50 children a page (so a page of rows with blockers stays under the query limit), 1000 at most. */
export const PAGE = 50
export const MAX = 1000

/** Child number n (1 = the oldest) of PARENT, in the shape Linear sends it. */
export const child = (n: number, extra: any = {}): any => ({
  id: 'uuid-' + n, identifier: 'ENG-' + (100 + n), number: 100 + n, title: 'Child ' + n, description: '', url: 'https://linear.app/x/issue/ENG-' + (100 + n),
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), updatedAt: new Date(Date.UTC(2026, 10, 2, 0, n)).toISOString(),
  state: { name: 'Todo', type: 'unstarted' }, team: { key: 'ENG', name: 'Engineering' }, parent: { identifier: PARENT }, assignee: null, labels: { nodes: [] }, ...extra,
})
export const kids = (count: number): any[] => Array.from({ length: count }, (_, i) => child(i + 1))
export const keysOf = (r: any): string[] => (r && r.ok && r.data && r.data.items ? r.data.items : []).map((i: any) => i.key)

export type FakeOpts = {
  /** Children of each parent, oldest first (the fake serves them newest first when the query asks `orderBy: createdAt`, as Linear does). */
  children: Record<string, any[]>
  /** The call number (1-based) that answers HTTP 500 instead of a page. */
  failOnCall?: number
  /** Do not give an endCursor although a next page exists. */
  noCursor?: boolean
  /** Leave pageInfo out of the connection. */
  noPageInfo?: boolean
  /** Every page is empty but says there is a next page, for ever. */
  endless?: boolean
  /** Raw nodes to put at the start of the first page (null and half-empty nodes), after the real ones are cut to the page. */
  junk?: any[]
}

/** A fake Linear channel: a Relay connection over `children`. It honours `first`, `after` (an opaque `c:<offset>` cursor) and `orderBy`. */
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
      const all = opts.children[vars.id]
      if (!all) return { status: 200, headers: {}, body: JSON.stringify({ data: { issue: null } }) }
      const first = typeof vars.first === 'number' ? vars.first : 50
      const offset = typeof vars.after === 'string' && vars.after.startsWith('c:') ? Number(vars.after.slice(2)) : 0
      let nodes: any[]
      let hasNext: boolean
      if (opts.endless) {
        nodes = []
        hasNext = true
      } else {
        const served = /orderBy:\s*createdAt/.test(String(body.query)) ? all.slice().reverse() : all
        nodes = served.slice(offset, offset + first)
        hasNext = offset + first < served.length
        if (opts.junk && offset === 0) nodes = [...opts.junk, ...nodes]
      }
      // blockers: honour the literal page the query writes for them, like Linear does
      const per = /inverseRelations\(first:\s*(\d+)\)/.exec(String(body.query))
      if (per) nodes = nodes.map((n: any) => (n && n.rels ? Object.assign({}, n, { inverseRelations: { nodes: n.rels.slice(0, Number(per[1])), pageInfo: { hasNextPage: n.rels.length > Number(per[1]) } } }) : n))
      const conn: any = { nodes }
      if (!opts.noPageInfo) conn.pageInfo = { hasNextPage: hasNext, endCursor: hasNext && !opts.noCursor ? 'c:' + (offset + first) : null }
      return { status: 200, headers: {}, body: JSON.stringify({ data: { issue: { identifier: vars.id, children: conn } } }) }
    } },
  }
  return { ctx, calls, bodies, events }
}

/** The room, reached the way the registry reaches it: the module's operations wrapped by `wrapTracker` (a missing operation answers the stub). */
export const trackerOf = (f: { ctx: any }): any => wrapTracker(linearModule as any, createLinearBackend(f.ctx, ACCOUNT), f.ctx)
export const list = async (f: { ctx: any }, key: string = PARENT): Promise<any> => trackerOf(f).listSubIssues(REPO, key, {}, f.ctx)
