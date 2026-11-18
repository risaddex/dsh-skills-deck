// tests/verify-45-linear-repo-identity.ts: the Linear backend gives the workspace directory as its repository identity (#45).
//
// Why this gate exists: after the list row opened a Linear ticket, the detail page showed "cannot resolve the target repository
// (refId missing)". The Linear room never reads its `repo` argument, but the host's detail, comments and comment-write entries
// refuse an empty refId before calling any room, and the Linear module had no `describe`, so the registry's skeleton gave refId ''.
// The list still drew because the snapshot path invents refId = cwd on its own. This gate checks the module's describe, the
// registry view that production calls, that a GitHub module without a refId still answers empty (an honest failure, unchanged),
// and that the real detail handler reads a Linear ticket once the identity is there and refuses it when it is not.
// 门禁归属: src/tracker/rooms/linear/index.ts
// 门禁归属: src/tracker/registry/views.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-repo-identity.ts
import { printGateResult } from './lib/gate-result.ts'
import { createCommentThreads } from '../src/refresh/rooms/host/comment-thread-fetch.ts'
import { describe as registryDescribe } from '../src/tracker/registry/views.ts'
import { describe as linearDescribe, linearModule } from '../src/tracker/rooms/linear/index.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'

// 1) the module's own describe
{
  const r: any = linearDescribe({ cwd: CWD } as any, 'linear')
  check(r.backend === 'linear' && r.refId === CWD && r.name === 'ombrellosolar-backend' && r.url === '', 'describe(cwd): refId is the workspace directory, name is its last segment, url stays empty (got ' + JSON.stringify(r) + ')')
  check(linearDescribe({ cwd: CWD, refId: 'team-x' } as any).refId === 'team-x', 'describe: an explicit handle.refId wins over the directory')
  check((linearDescribe({ cwd: CWD, effortId: 'e1' } as any) as any).effortId === 'e1', 'describe: effortId is forwarded')
  check(linearDescribe({} as any).refId === '', 'describe: no directory and no refId stays empty (nothing is invented)')
  check(linearDescribe({ cwd: 'C:\\work\\ombrello' } as any).name === 'ombrello', 'describe: a Windows path still gives its last segment as the name')
}

// 2) the registry view production calls (module first, skeleton as fallback)
const store = (mod: any): any => new Map([[mod.id, { mod: mod, tracker: {} }]])
{
  const r: any = registryDescribe(store(linearModule), { cwd: CWD } as any, 'linear')
  check(r.refId === CWD && r.backend === 'linear', 'registry describe for the Linear module gives refId = directory (got ' + JSON.stringify(r.refId) + ')')
  const without: any = registryDescribe(store({ id: 'linear' }), { cwd: CWD } as any, 'linear')
  check(without.refId === '', 'control: a Linear module WITHOUT describe gives the empty refId that caused the error (the defect this gate reproduces)')
  const gh: any = registryDescribe(store({ id: 'github' }), { cwd: CWD } as any, 'github')
  check(gh.refId === '', 'control: GitHub with only a directory still answers an empty refId (an honest failure, unchanged)')
}

// 3) the real detail handler, with the repo reference the session would carry
const OPENED_ISSUE = { key: 'OMB-890', title: '[EPIC/TASK] Redesign', state: 'open', body: 'body', url: 'https://linear.app/x/issue/OMB-890', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', closedAt: null, author: { login: 'a' }, labels: [], assignees: [], comments: [], blockedBy: [] }
function handlerFor(repoRef: any, seen: any[]): any {
  const opened = { ok: true, backendId: 'linear', budget: {}, canWrite: false, repoRef: repoRef, call: async (fn: any) => fn({ get: async (ref: any, key: any) => { seen.push({ refId: ref && ref.refId, key }); return { ok: true, data: OPENED_ISSUE } } }, { cwd: CWD, caller: 'refresh' }) }
  return createCommentThreads({
    openSession: async () => opened, normCwd: async (x: any) => x, selectEarly: async () => { throw new Error('unused') }, isComposerSelection: () => false,
    getTrackerRegistry: async () => ({}), getPlatform: async () => ({}), ctx: {}, timer: {}, DEFAULT_CWD: '', errText: (e: any) => String((e && e.message) || e),
    isRateLimitError: () => false, getRepoKey: async () => null, execProc: async () => { throw new Error('unused') }, fetchIssueDetail: async () => { throw new Error('unused') },
    fetchIssueIndex: async () => { throw new Error('unused') }, issueIndexFromSnapshot: () => ({}), setCache: () => {}, logCtx: { fire: () => {} },
  } as any)
}
{
  const seen: any[] = []
  const d: any = await handlerFor(registryDescribe(store(linearModule), { cwd: CWD } as any, 'linear'), seen).handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  check(d && d.ok === true && seen.length === 1 && seen[0].key === 'OMB-890' && seen[0].refId === CWD, 'detail of OMB-890 with the Linear identity succeeds and reaches the room with key OMB-890 (got ' + JSON.stringify(d && (d.ok ? 'ok' : d.error)) + ')')
  const c: any = await handlerFor(registryDescribe(store(linearModule), { cwd: CWD } as any, 'linear'), []).handleIssueComments({ number: 'OMB-890', cwd: CWD })
  check(c && c.ok === true, 'comments of OMB-890 with the Linear identity succeed')
}
{
  const d: any = await handlerFor(registryDescribe(store({ id: 'linear' }), { cwd: CWD } as any, 'linear'), []).handleIssueDetail({ number: 'OMB-890', cwd: CWD })
  check(d && d.ok === false && d.error && d.error.kind === 'not-found' && String(d.error.message).indexOf('refId missing') >= 0, 'control: without the identity the same call fails with "refId missing", the message seen on the panel')
}
printGateResult('verify-45-linear-repo-identity', assertions, failed)
if (failed) process.exit(1)
