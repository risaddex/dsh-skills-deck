// tests/verify-45-linear-probe.ts: the panel's 5-second probe works for a Linear workspace (#45).
//
// Why this gate exists: with a Linear workspace the panel kept showing "Failed" next to Refresh and a yellow banner, and the host log had
// one `wf.probe` failure with errorKind env every 5 seconds. The probe built its own operation context (only `exec`, made for rooms that
// run commands) and handed it to `tracker.list`. The Linear room speaks HTTP only and uses the context it is given, so it answered
// "the room has no HTTP channel wired (ctx.http is missing)" every time. The snapshot never showed it because it goes through the read
// session, which brings the channel and the account. The probe now lists through the read session for a backend that speaks HTTP,
// and leaves the backends that run commands (GitLab, local Markdown) on the path that older gates pin.
// 门禁归属: src/refresh/rooms/host/probe-handler.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-probe.ts
import { printGateResult } from './lib/gate-result.ts'
import { createProbeHandler } from '../src/refresh/rooms/host/probe-handler.ts'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const ACCOUNT = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'
const NODE = (n: number): any => ({ id: 'u' + n, identifier: 'OMB-' + n, title: 'T' + n, description: '', url: 'https://linear.app/x/issue/OMB-' + n, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'OMB', name: 'O' }, parent: null, assignee: null, labels: { nodes: [] } })

function fakeHttp(status = 200, nodes = [NODE(1), NODE(2)]): { http: any, calls: any[] } {
  const calls: any[] = []
  return { calls, http: { request: async (req: any) => { calls.push(req); return { status, headers: {}, body: status === 200 ? JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false } } } }) : '' } } } }
}

/** The probe's dependencies, with the REAL Linear room as the tracker. `session` decides what openSession answers. */
function handlerWith(opts: { session?: any, backendId?: string, tracker?: any, sessionCalls?: any[] }): any {
  const backendId = opts.backendId || 'linear'
  const tracker = opts.tracker || createLinearBackend({} as any, ACCOUNT as any)
  const deps: any = {
    canonicalKey: async (c: any) => c,
    selectEarly: async () => ({ backendId }),
    isComposerSelection: (sel: any) => !!sel && sel.backendId === backendId,
    getTrackerRegistry: async () => ({ get: () => tracker, describe: () => ({ backend: backendId, refId: CWD, name: 'repo', url: '' }) }),
    getPlatform: async () => ({}),
    ctx: { get: () => null },
    // What the old path used: a command executor and nothing else. A Linear room cannot talk through it.
    detectionExec: async () => ({ stdout: '[]', stderr: '', code: 0 }),
    fetchIssueIndexWindowed: async () => ({ ok: false, error: { kind: 'unsupported', message: 'the GitHub path must not run' } }),
    issueIndexChanged: () => false, rememberIssueIndex: () => {}, commitIssueIndex: () => {}, getCache: () => null, setCache: () => {},
    lastIssueIndexByRepo: {}, lastProbeAtByRepo: {}, deltaRefresh: async () => null, takeWritePatch: async () => null,
    errText: (e: any) => (e && typeof e === 'object' ? String(e.message || e.error || '') : String(e)),
    logCtx: { fire: () => {} },
  }
  if (opts.session !== undefined) deps.openSession = opts.session
  void opts.sessionCalls
  return createProbeHandler(deps)
}

/** A read session whose room context carries the channel, as the real one does. */
function sessionOver(http: any, tracker: any, seen: any[] = []): any {
  return async (cwd: string) => { seen.push(cwd); return { ok: true, backendId: 'linear', budget: {}, canWrite: false, repoRef: { backend: 'linear', refId: CWD, name: 'repo', url: '' }, call: async (fn: any) => fn({ list: (r: any, f: any, c: any) => tracker.list(r, f, c) }, { cwd, http, caller: 'refresh' }) } }
}

// 1) the defect, as the panel saw it: no session, so the room gets the probe's exec-only context
{
  const r: any = await handlerWith({}).handleProbe({ cwd: CWD })
  check(r.ok === false && r.errorKind === 'env' && /ctx\.http is missing/.test(String(r.error)), 'control: without a session the probe fails as env with "ctx.http is missing", the error behind the Failed chip (got ' + JSON.stringify(r).slice(0, 200) + ')')
}

// 2) through the read session
{
  const h = fakeHttp()
  const tracker = createLinearBackend({} as any, ACCOUNT as any)
  const seen: any[] = []
  const r: any = await handlerWith({ tracker, session: sessionOver(h.http, tracker, seen) }).handleProbe({ cwd: CWD })
  check(r.ok === true, 'the probe succeeds for a Linear workspace (got ' + JSON.stringify(r).slice(0, 200) + ')')
  check(r.ok === true && r.count === 2, 'it sees the two tickets (count ' + String(r.count) + ')')
  check(h.calls.length === 1 && JSON.parse(h.calls[0].body).query.indexOf('LinearIssues') >= 0, 'exactly one list request went out, through the session channel')
  check(seen.length === 1 && seen[0] === CWD, 'the read session was opened once, for the workspace')
  check(r.ok === true && typeof r.since === 'string' && r.since !== '' && r.repo && r.repo.owner === 'linear', 'the reply keeps its usual shape: since and the repo marker')
  const again: any = await handlerWith({ tracker, session: sessionOver(fakeHttp().http, tracker) }).handleProbe({ cwd: CWD })
  check(again.ok === true, 'a second probe succeeds too (it is a loop, not a one-off)')
}

// 3) failures keep their own kind, and a session that does not open is said plainly
{
  const denied = fakeHttp(401)
  const tracker = createLinearBackend({} as any, ACCOUNT as any)
  const r: any = await handlerWith({ tracker, session: sessionOver(denied.http, tracker) }).handleProbe({ cwd: CWD })
  check(r.ok === false && r.errorKind === 'auth', 'a rejected credential is reported as auth, not as an environment problem (got ' + String(r.errorKind) + ')')
  const closed: any = await handlerWith({ tracker, session: async () => ({ ok: false, reason: 'no-backend', detail: 'nothing claimed the workspace' }) }).handleProbe({ cwd: CWD })
  check(closed.ok === false && closed.errorKind === 'env' && String(closed.error).indexOf('nothing claimed the workspace') >= 0, 'a session that cannot open says why, as env (got ' + JSON.stringify(closed).slice(0, 200) + ')')
  const threw: any = await handlerWith({ tracker, session: async () => { throw new Error('boom') } }).handleProbe({ cwd: CWD })
  check(threw.ok === false && String(threw.error).indexOf('boom') >= 0, 'a session that throws is reported, never swallowed (got ' + JSON.stringify(threw).slice(0, 200) + ')')
}

// 4) the backends that run commands do not touch the session: their gates pin the old path
for (const id of ['gitlab', 'markdown']) {
  let opened = 0
  let listed = 0
  const tracker: any = { list: async () => { listed += 1; return { ok: true, data: [{ key: '1', state: 'open' }], truncated: false } } }
  const r: any = await handlerWith({ backendId: id, tracker, session: async () => { opened += 1; return { ok: false, reason: 'must not be asked' } } }).handleProbe({ cwd: CWD })
  check(r.ok === true && listed === 1 && opened <= 1, id + ': lists on its own path (listed ' + listed + ' time)')
  check(!(r.ok === true && opened > 0 && listed === 0), id + ': the probe does not replace its listing by the session')
}
printGateResult('verify-45-linear-probe', assertions, failed)
if (failed) process.exit(1)
