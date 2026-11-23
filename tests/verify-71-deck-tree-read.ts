// tests/verify-71-deck-tree-read.ts —— #71 门禁：按会话读取开放地图/规格树
//
// 判据直接来自票面：成功的瘦树、明确的空结果、会话找不到时如实失败且不回落。
// 测试在宿主电话的公开出口上驱动真实的“会话 → list({state:'open'}) → assembleSnapshot”路径，
// 只把 Tracker 会话换成可控夹具；不进入映射内部，也不手写最终快照形状。
import { printGateResult } from './lib/gate-result.ts'

const { createDeckTreeRead } = await import('../src/host/deckTree.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

const REPO = { backend: 'github', refId: 'acme/demo', name: 'acme/demo', url: 'https://example.test/acme/demo' }
const okCwd = async (args: any) => ({ ok: true, cwd: '/workspace/demo', workspaceRoot: '/workspace/demo', sessionId: args.sessionId })

function openedWithRows(rows: any[], calls: any[], resultExtra: any = {}) {
  return async (cwd: string, opts: any) => {
    calls.push({ kind: 'open', cwd, opts })
    return {
      ok: true,
      backendId: 'github',
      repoRef: REPO,
      call: async (fn: any) => fn({
        list: async (ref: any, filter: any, ctx: any) => {
          calls.push({ kind: 'list', ref, filter, ctx })
          return Object.assign({ ok: true, data: rows }, resultExtra)
        },
      }, { cwd }),
    }
  }
}

{
  const calls: any[] = []
  const phone = createDeckTreeRead({
    handleCwd: okCwd,
    openSession: openedWithRows([], calls),
  })
  const r: any = await phone.handleTree({ sessionId: 's-empty' })
  check(r && r.ok === true, '空工作区返回 ok=true')
  check(Array.isArray(r && r.containers) && r.containers.length === 0, '空工作区返回空 containers，而不是失败')
  check(r && r.sessionId === 's-empty', '回包保留请求的 sessionId')
  check(r && r.workspaceRoot === '/workspace/demo', '回包带上会话解析出的 workspaceRoot')
  check(r && r.truncated === false && r.fallback === null, '完整空结果同时说明它不是截断、不是降级')
  check(calls.length === 2 && calls[0].kind === 'open' && calls[0].cwd === '/workspace/demo' && calls[0].opts && calls[0].opts.write === false, '只读会话使用会话解析出的 cwd，并显式请求 write:false')
  check(calls[1] && calls[1].kind === 'list' && calls[1].filter && calls[1].filter.state === 'open', 'Tracker 契约按 state=open 读取')
}

{
  const calls: any[] = []
  const phone = createDeckTreeRead({
    handleCwd: okCwd,
    openSession: openedWithRows([], calls, { truncated: true, fallback: 'rest', fallbackReason: 'quota' }),
  })
  const r: any = await phone.handleTree({ sessionId: 's-truncated' })
  check(r && r.ok === true, '部分列表仍回 ok=true，不把截断伪装成失败')
  check(r && r.truncated === true, 'Tracker 列表截断时把 truncated=true 交给上层')
  check(r && r.fallback === 'rest' && r.fallbackReason === 'quota', 'Tracker 列表降级时把 fallback 与原因交给上层，不冒充完整空树')
}

{
  const calls: any[] = []
  const rows = [
    { key: '10', number: 10, type: 'map', title: 'Exploration', state: 'open', url: 'https://example.test/10', isPullRequest: false, body: 'container body' },
    { key: '11', number: 11, type: 'issue', parentKey: '10', title: 'Open child', state: 'open', url: 'https://example.test/11', isPullRequest: false, blockedBy: [{ number: 12, title: 'Blocker', state: 'closed' }], body: 'must not leak' },
    { key: '12', number: 12, type: 'issue', parentKey: '10', title: 'Blocker', state: 'closed', url: 'https://example.test/12', isPullRequest: false, body: 'must not leak either' },
    { key: '13', number: 13, type: 'issue', parentKey: '10', title: 'No blocker field', state: 'open', url: 'https://example.test/13', isPullRequest: false },
    { key: '14', number: 14, type: 'issue', parentKey: '10', title: 'Confirmed empty', state: 'open', url: 'https://example.test/14', isPullRequest: false, blockedBy: [] },
    { key: '20', number: 20, type: 'spec', title: 'Implementation', state: 'open', url: 'https://example.test/20', isPullRequest: false },
    { key: '30', number: 30, type: 'map', title: 'Closed map', state: 'closed', url: 'https://example.test/30', isPullRequest: false },
    { key: '99', number: 99, type: 'issue', title: 'Orphan', state: 'open', url: 'https://example.test/99', isPullRequest: false },
  ]
  const phone = createDeckTreeRead({
    handleCwd: okCwd,
    openSession: openedWithRows(rows, calls),
  })
  const r: any = await phone.handleTree({ sessionId: 's-tree' })
  check(r && r.ok === true, '有数据时返回 ok=true')
  check(r && r.backendId === 'github', '回包带上只读会话选中的 backendId')
  check(r && Array.isArray(r.containers) && r.containers.length === 2, '只保留开放的 map/spec 容器（关闭容器与未挂票不进树）')
  const map = r && r.containers && r.containers[0]
  const spec = r && r.containers && r.containers[1]
  check(map && map.kind === 'map' && map.key === '10' && map.state === 'OPEN', 'map 容器有种类、键与大写状态')
  check(spec && spec.kind === 'spec' && spec.key === '20', 'spec 容器保留自己的种类')
  check(map && Array.isArray(map.tickets) && map.tickets.length === 4, '容器带子票行')
  const child = map && map.tickets && map.tickets[0]
  check(child && child.key === '11' && child.state === 'OPEN' && child.title === 'Open child', '子票行保留键、标题与规范化状态')
  check(child && Array.isArray(child.blockedBy) && child.blockedBy.length === 1 && child.blockedBy[0].key === 12 && child.blockedBy[0].title === 'Blocker' && child.blockedBy[0].state === 'CLOSED', '阻塞引用保留键、标题与规范化状态')
  check(!Object.prototype.hasOwnProperty.call(child || {}, 'body'), '子票行不带正文')
  const ticketWithUnknownBlockers = map && map.tickets && map.tickets.find((t: any) => t.key === '13')
  check(ticketWithUnknownBlockers && !Object.prototype.hasOwnProperty.call(ticketWithUnknownBlockers, 'blockedBy'), '缺少阻塞字段时保持未知，不写成空数组')
  const emptyBlocker = map && map.tickets && map.tickets.find((t: any) => t.key === '14')
  check(emptyBlocker && Array.isArray(emptyBlocker.blockedBy) && emptyBlocker.blockedBy.length === 0, '后端明确给空数组时保留空数组')
}

{
  let openCalled = false
  const missingPhone = createDeckTreeRead({
    handleCwd: async () => ({ ok: false, error: 'This session could not be found', kind: 'not-found' }),
    openSession: async () => { openCalled = true; return { ok: true } },
  })
  const r: any = await missingPhone.handleTree({ sessionId: 'missing' })
  check(r && r.ok === false, '找不到会话时返回 ok=false')
  check(r && r.error && r.error.kind === 'not-found', '找不到会话时保留机器可读的 not-found 原因')
  check(openCalled === false, '找不到会话时绝不回落到 Tracker 或别的 workspace')
}

{
  let openCalled = false
  const failedPhone = createDeckTreeRead({
    handleCwd: okCwd,
    openSession: async () => { openCalled = true; return { ok: false, reason: 'open-failed', detail: 'no tracker session' } },
  })
  const r: any = await failedPhone.handleTree({ sessionId: 's-fail' })
  check(r && r.ok === false, '只读会话开不起来时返回 ok=false')
  check(r && r.error && r.error.kind === 'open-failed', '会话失败保留 open-failed 原因')
  check(openCalled === true, '会话失败发生在会话打开之后，而不是静默回落到别的路径')
}

{
  let openCalled = false
  const noSid = createDeckTreeRead({
    handleCwd: async () => { throw new Error('must not be called without a session id') },
    openSession: async () => { openCalled = true; return { ok: true } },
  })
  const r: any = await noSid.handleTree({})
  check(r && r.ok === false && r.error && r.error.kind === 'no-sid', '缺 sessionId 时直接失败，reason=no-sid')
  check(openCalled === false, '缺 sessionId 时连 Tracker 都不开')
}

{
  const { createSessionLifecycle } = await import('../src/host/sessionLifecycle.ts')
  const lifecycle: any = createSessionLifecycle({
    ctx: { get: (key: string) => key === 'sessions' ? { get: (sid: string) => sid === 's-real' ? { header: { cwd: '/workspace/real' } } : null } : undefined },
    DEFAULT_CWD: '',
    errText: (e: any) => String((e && e.message) || e),
    canonicalKey: async (p: string) => p,
    getDetectionService: async () => null,
    getTrackerRegistry: async () => null,
    getPlatform: async () => ({}),
    logCtx: null,
  })
  const calls: any[] = []
  const phone = createDeckTreeRead({
    handleCwd: lifecycle.handleCwd,
    openSession: openedWithRows([], calls),
  })
  const r: any = await phone.handleTree({ sessionId: 's-real' })
  check(r && r.ok === true && r.workspaceRoot === '/workspace/real', '真实会话解析器把 sessionId 解析为 workspace，不靠调用方传路径')
  check(calls.length === 2 && calls[0].cwd === '/workspace/real' && calls[0].opts.write === false, '真实会话解析出的 cwd 进入只读 Tracker 会话')
}

{
  // Integration seam: real session opener + real read pipeline + fake GitHub room, then the deck tree phone.
  const { createSessionOpener } = await import('../src/refresh/rooms/host/session-opener.ts')
  const budget = { kind: 'two-buckets', countsRequests: true, countsPoints: true, independentBuckets: true }
  const listCalls: any[] = []
  const room = {
    list: async (ref: any, filter: any, ctx: any) => {
      listCalls.push({ ref, filter, ctx })
      return {
        ok: true,
        data: [
          { key: '40', number: 40, type: 'map', title: 'GitHub map', state: 'open', url: 'https://example.test/40', isPullRequest: false },
          { key: '41', number: 41, type: 'issue', parentKey: '40', title: 'GitHub child', state: 'open', url: 'https://example.test/41', isPullRequest: false, blockedBy: [] },
        ],
      }
    },
  }
  const registry: any = {
    select: async () => ({ backendId: 'github', source: 'explicit', ref: REPO }),
    get: (id: string) => id === 'github' ? room : undefined,
    modules: () => [{ id: 'github', budget }],
  }
  const opener: any = createSessionOpener({ getTrackerRegistry: async () => registry, ledger: null, backendCtx: () => ({}) })
  const phone = createDeckTreeRead({ handleCwd: okCwd, openSession: opener })
  const r: any = await phone.handleTree({ sessionId: 's-github-integration' })
  check(r && r.ok === true && r.backendId === 'github', '真实 session opener 能把 GitHub 工作区读成树')
  check(listCalls.length === 1 && listCalls[0].filter && listCalls[0].filter.state === 'open', '真实 Tracker 管线按 state=open 调 GitHub 房间')
  check(r && r.containers && r.containers[0] && r.containers[0].tickets && r.containers[0].tickets[0] && r.containers[0].tickets[0].key === '41', '真实管线返回的 GitHub 子票进入瘦树')
  check(r && r.containers && r.containers[0] && r.containers[0].tickets && r.containers[0].tickets[0].blockedBy && r.containers[0].tickets[0].blockedBy.length === 0, 'GitHub 房间明确给空阻塞数组时保留空数组')
}

printGateResult('verify-71-deck-tree-read', total, failed)
