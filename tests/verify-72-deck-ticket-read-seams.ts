// tests/verify-72-deck-ticket-read-seams.ts —— #72 门禁（真实接缝）：真实会话解析器与真实读取管线
//
// 为什么单立一扇：前两扇把 Tracker 会话换成假夹具，证明的是投影与失败形状。这一扇换成真的
// sessionLifecycle 与真的 sessionOpener（只把 GitHub 房间换成假回包），证明「sessionId 解析出
// 工作区 → 只读会话 → 契约 get」这条路真的通，而不是只在夹具上通。
import { printGateResult } from './lib/gate-result.ts'
import { REPO, okCwd } from './lib/deck-ticket-fixture.ts'

const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

// —— 真实会话解析器把 sessionId 解析成 workspace，调用方一个字路径都不传 ——
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
  const phone = createDeckTicketRead({
    handleCwd: lifecycle.handleCwd,
    openSession: async (cwd: string, opts: any) => {
      calls.push({ kind: 'open', cwd, opts })
      return { ok: true, backendId: 'github', repoRef: REPO, call: async (fn: any) => fn({ get: async () => ({ ok: true, data: { key: '11', number: 11, title: 'real', state: 'open', body: '', url: '' } }) }, { cwd }) }
    },
  })
  const r: any = await phone.handleTicket({ sessionId: 's-real', key: '11' })
  check(r && r.ok === true && r.workspaceRoot === '/workspace/real', '真实会话解析器把 sessionId 解析为 workspace，不靠调用方传路径')
  check(calls.length === 1 && calls[0].cwd === '/workspace/real' && calls[0].opts && calls[0].opts.write === false, '真实会话解析出的 cwd 进入只读 Tracker 会话，并显式请求 write:false')
  check(r && r.sessionId === 's-real', '回包保留请求的 sessionId，面板能把回包与请求对上')
}

// —— 真实 session opener + 真实读取管线 + 假的 GitHub 房间，证明这条路真的通 ——
{
  const { createSessionOpener } = await import('../src/refresh/rooms/host/session-opener.ts')
  const getCalls: any[] = []
  const budget = { kind: 'two-buckets', countsRequests: true, countsPoints: true, independentBuckets: true }
  const room = {
    get: async (ref: any, key: any, opt: any, ctx: any) => {
      getCalls.push({ ref, key, opt, ctx })
      return {
        ok: true,
        data: {
          key: '41',
          number: 41,
          type: 'issue',
          title: 'GitHub ticket through the real pipeline',
          state: 'open',
          url: 'https://example.test/acme/demo/issues/41',
          parentKey: '40',
          body: ['## Acceptance criteria', '', '- [x] Real pipeline reads it'].join('\n'),
          labels: [{ name: 'ready-for-agent', color: '0e8a16' }],
          blockedBy: [{ key: '40', title: 'Parent map', state: 'open' }],
        },
      }
    },
  }
  const registry: any = {
    select: async () => ({ backendId: 'github', source: 'explicit', ref: REPO }),
    get: (id: string) => id === 'github' ? room : undefined,
    modules: () => [{ id: 'github', budget }],
  }
  const opener: any = createSessionOpener({ getTrackerRegistry: async () => registry, ledger: null, backendCtx: () => ({}) })
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: opener })
  const r: any = await phone.handleTicket({ sessionId: 's-github-integration', key: '41' })
  check(r && r.ok === true && r.backendId === 'github', '真实 session opener 能把 GitHub 工作区里的一张票读成详情')
  check(getCalls.length === 1 && getCalls[0].key === '41', '真实 Tracker 管线按票号调 GitHub 房间的 get，只读一次')
  check(getCalls[0].opt && getCalls[0].opt.comments && getCalls[0].opt.comments.first === 0, '真实管线里也只问 0 条评论正文')
  check(r && r.ticket && r.ticket.title === 'GitHub ticket through the real pipeline' && r.ticket.labels && r.ticket.labels[0].name === 'ready-for-agent', '真实管线回来的标签进入详情')
  check(r && r.ticket && r.ticket.acceptanceCriteria && r.ticket.acceptanceCriteria.length === 1 && r.ticket.acceptanceCriteria[0].done === true, '真实管线回来的验收标准读成已完成的一条')
  check(r && r.ticket && r.ticket.blockedBy && r.ticket.blockedBy[0] && r.ticket.blockedBy[0].key === '40', '真实管线回来的阻塞者进入详情')
}

printGateResult('verify-72-deck-ticket-read-seams', total, failed)
