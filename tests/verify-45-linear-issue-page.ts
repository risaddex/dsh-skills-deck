// tests/verify-45-linear-issue-page.ts: the panel's Closed tab pages a Linear workspace (#45).
//
// Why this gate exists: with a Linear workspace the Closed tab answered "Could not load more history; try again shortly" and
// "0 loaded / 0 total". The host log showed `wf.issuesPage` failing in 4 to 41 milliseconds with `quota.op listPage` recording
// `ok:false, requests:0` — no request ever left. The cause is the same one the 5-second probe had (tests/verify-45-linear-probe.ts):
// `src/host/issuePage.ts` built its own operation context (cwd, platform, fs, exec, logEvent, isEnabled) and handed it to
// `tracker.listPage`. The linear room speaks HTTP only and reads the channel from the context it is given, so it answered
// "the room has no HTTP channel wired (ctx.http is missing)". The snapshot never showed this because it goes through the read
// session, which brings the channel and the account. Paging now goes through the same read session for a backend that speaks
// HTTP, and the backends that run commands (GitLab, local Markdown) stay on the path that older gates pin.
//
// The GitHub calls that did work through this same phone are why the defect looked intermittent: GitHub pages through `exec`,
// which the old context always had (the three successes in the 2026-11-18 host log returned 28 of 28, the closed count of
// risaddex/dsh-skills-deck at the time).
// 门禁归属: src/host/issuePage.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-issue-page.ts
import { printGateResult } from './lib/gate-result.ts'
import { createIssuePage } from '../src/host/issuePage.ts'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const ACCOUNT = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'
const REPO = { backend: 'linear', refId: CWD, name: 'ombrellosolar-backend', url: '' }

/** A Linear issue node shaped as the linear room expects (`normalize.issueOf` reads these). */
const NODE = (n: number, done = true): any => ({
  id: 'u' + n, identifier: 'OMB-' + n, number: n, title: 'T' + n, description: '', url: 'https://linear.app/x/issue/OMB-' + n,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  state: { name: done ? 'Done' : 'Todo', type: done ? 'completed' : 'unstarted' }, team: { key: 'OMB', name: 'O' },
  parent: null, assignee: null, labels: { nodes: [] },
})

/**
 * A fake Linear endpoint. The page query carries the `LinearPageCore` fragment; the counts walk asks only for `nodes { id }`.
 * Both are answered from the same script so one page read is one page query plus one counts walk, as the real room does.
 */
function fakeHttp(opts: { nodes?: any[], hasNext?: boolean, endCursor?: string, after?: string } = {}): { http: any, calls: any[] } {
  const calls: any[] = []
  const nodes = opts.nodes || [NODE(903), NODE(902)]
  const http = {
    request: async (req: any) => {
      const body = JSON.parse(String(req.body || '{}'))
      const query = String(body.query || '')
      calls.push({ headers: req.headers, bucket: req.bucket, service: req.service, query, variables: body.variables })
      const hasNext = body.variables && body.variables.after && opts.after !== undefined ? false : opts.hasNext === true
      const endCursor = opts.endCursor || 'CUR1'
      const payload = query.indexOf('LinearPageCore') >= 0
        ? { nodes, pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? endCursor : null } }
        : { nodes: nodes.map((n: any) => ({ id: n.id })), pageInfo: { hasNextPage: false, endCursor: null } }
      return { status: 200, headers: {}, body: JSON.stringify({ data: { issues: payload } }) }
    },
  }
  return { calls, http }
}

/** The phone's dependencies, with the REAL Linear room as the tracker. `session` decides what openSession answers. */
function phoneWith(opts: { session?: any, backendId?: string, tracker?: any }): any {
  const backendId = opts.backendId || 'linear'
  const tracker = opts.tracker || createLinearBackend({} as any, ACCOUNT as any)
  const deps: any = {
    normCwd: async (c: any) => c,
    selectEarly: async () => ({ backendId }),
    getTrackerRegistry: async () => ({ get: () => tracker, describe: () => ({ backend: backendId, refId: CWD, name: 'repo', url: '' }) }),
    getPlatform: async () => ({}),
    getRepoKey: async () => null,
    ctx: { get: () => null },
    DEFAULT_CWD: '/ws-default',
    // What the old context had: a command executor and nothing else. A Linear room cannot talk through it.
    detectionExec: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    logCtx: { fire: () => {} },
  }
  if (opts.session !== undefined) deps.openSession = opts.session
  return createIssuePage(deps)
}

/** A read session whose room context carries the channel, as the real one does. */
function sessionOver(http: any, tracker: any, opened: any[] = []): any {
  return async (cwd: string) => {
    opened.push(cwd)
    return {
      ok: true, backendId: 'linear', budget: {}, canWrite: false, repoRef: REPO,
      call: async (fn: any) => fn({ listPage: (r: any, f: any, o: any, c: any) => tracker.listPage(r, f, o, c) }, { cwd, http, caller: 'refresh' }),
    }
  }
}

// 1) the defect as the panel saw it: the page read must work for a Linear workspace at all
{
  const { calls, http } = fakeHttp()
  const tracker: any = createLinearBackend({} as any, ACCOUNT as any)
  const opened: any[] = []
  const phone = phoneWith({ session: sessionOver(http, tracker, opened) })
  const r: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed', limit: 50 })
  check(r && r.ok === true, 'control: a Closed page for a Linear workspace comes back ok (before the fix this was env "ctx.http is missing") (got ' + JSON.stringify(r).slice(0, 220) + ')')
  check(opened.length >= 1 && opened[0] === CWD, 'the read session is opened for the workspace being paged (got ' + JSON.stringify(opened) + ')')
  check(calls.length >= 2 && calls.every((c: any) => c.headers && c.headers.Authorization === 'lin_api_key'), 'the Linear room talked through the session channel with the account header (' + calls.length + ' requests)')
  check(calls.length >= 2 && calls.every((c: any) => c.bucket === 'read' && c.service === 'linear'), 'both requests ask the channel for the read bucket of the linear service (got ' + calls.length + ')')
}

// 2) the rows keep the text key, and the total matches the walk the room does for it
{
  const { http } = fakeHttp()
  const tracker: any = createLinearBackend({} as any, ACCOUNT as any)
  const phone = phoneWith({ session: sessionOver(http, tracker) })
  const r: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed' })
  const rows = (r && r.items) || []
  check(rows.length === 2, 'two rows come back (got ' + rows.length + ')')
  check(rows[0] && rows[0].key === 'OMB-903', 'a Linear row keeps its text key (got ' + JSON.stringify(rows[0] && rows[0].key) + ')')
  check(rows[0] && rows[0].number === undefined, 'a text key is not turned into a guessed number (got ' + JSON.stringify(rows[0] && rows[0].number) + ')')
  check(rows[0] && rows[0].state === 'CLOSED', 'the state is upper-cased the way the client compares it (got ' + JSON.stringify(rows[0] && rows[0].state) + ')')
  check(r && r.total === 2, 'the total is the count the room walked, not the size of this page (got ' + JSON.stringify(r && r.total) + ')')
  check(r && r.nextCursor === null, 'no next cursor when Linear says the page is the last one (got ' + JSON.stringify(r && r.nextCursor) + ')')
}

// 3) the cursor goes out on the wire and comes back untouched
{
  const { calls, http } = fakeHttp({ hasNext: true, endCursor: 'CUR7' })
  const tracker: any = createLinearBackend({} as any, ACCOUNT as any)
  const phone = phoneWith({ session: sessionOver(http, tracker) })
  const first: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed' })
  check(first && first.ok === true && first.nextCursor === 'CUR7', "Linear's endCursor comes back as the next cursor untouched (got " + JSON.stringify(first && first.nextCursor) + ')')
  const second: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed', cursor: 'CUR7' })
  const pageCalls = calls.filter((c: any) => c.query.indexOf('LinearPageCore') >= 0)
  check(second && second.ok === true, 'the second page loads with the cursor handed back (got ' + JSON.stringify(second).slice(0, 200) + ')')
  check(pageCalls.length === 2 && pageCalls[1].variables.after === 'CUR7', 'the cursor is sent as the query`s after variable, unchanged (got ' + JSON.stringify(pageCalls.map((c: any) => c.variables.after)) + ')')
  check(pageCalls.length >= 1 && pageCalls[0].variables.after === null, 'the first page sends a null cursor instead of an empty string (got ' + JSON.stringify(pageCalls.map((c: any) => c.variables.after)) + ')')
}

// 4) no session wired: say so plainly, instead of blaming a channel the room never had
{
  const tracker: any = createLinearBackend({} as any, ACCOUNT as any)
  const phone = phoneWith({ session: undefined })
  const r: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed' })
  const msg = String((r && r.error && r.error.message) || '')
  check(r && r.ok === false && r.error && r.error.kind === 'env', 'with no session outlet the phone fails as env, not as network (got ' + JSON.stringify(r).slice(0, 200) + ')')
  check(/session/i.test(msg) && !/ctx\.http is missing/.test(msg), 'the message names the missing session outlet, the actual cause (got ' + JSON.stringify(msg) + ')')
  void tracker
}

// 5) the backends that run commands keep the old path: the session is never opened for them
for (const backendId of ['gitlab', 'markdown']) {
  let sessionAsked = 0
  const wrote: any[] = []
  const tracker: any = { listPage: async () => { wrote.push('listPage'); return { ok: true, data: { items: [{ key: '12', title: 'from ' + backendId, state: 'closed' }], nextCursor: 'NEXT', total: 40 } } } }
  const phone = phoneWith({ backendId, tracker, session: async () => { sessionAsked += 1; throw new Error('the session must not be opened for ' + backendId) } })
  const r: any = await phone.handleIssuesPage({ cwd: CWD, state: 'closed' })
  check(r && r.ok === true && r.items && r.items[0] && r.items[0].key === '12', backendId + ': paging still works on the command path (got ' + JSON.stringify(r).slice(0, 160) + ')')
  check(sessionAsked === 0, backendId + ': the read session is never opened, so its accounting and policy do not change (got ' + sessionAsked + ')')
  check(wrote.length === 1, backendId + ': the room was called exactly once (got ' + wrote.length + ')')
}

printGateResult('verify-45-linear-issue-page', assertions, failed)
if (failed) process.exit(1)
