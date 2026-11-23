// tests/verify-73-deck-ticket-read-backends.ts —— #73 门禁（后端矩阵·票读）：四个后端各读一次同一张票
//
// 判据来自票面：票读也要在 GitHub、GitLab、本地 Markdown 与 Linear 上都能读到同一份详情（标题、状态、
// 标签、正文、验收标准、进度、阻塞者），GitHub 与 Linear 是各自显式测的。四条路走同一份 Tracker 契约的 get
// 与同一条「会话 → 只读会话 → 契约 get」管线；假身只换运输层，房间模块与开会话管线都是真的。
//
// 这一扇证明的是「票读在四个后端上都通」；失败形状见 verify-72-deck-ticket-read-failures.ts，
// 树读的矩阵见 verify-73-deck-tree-read-backends.ts。
import { printGateResult } from './lib/gate-result.ts'
import {
  cwdReply,
  githubNode,
  githubSession,
  gitlabRow,
  gitlabSession,
  linearNode,
  linearSession,
  markdownSession,
  type DeckSession,
} from './lib/deck-backend-matrix.ts'

const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

/** 一张「什么都有」的票的正文：四个后端的夹具共用，判据才不会一处一个样。 */
const BODY = [
  '## Body',
  '',
  'A ticket the phone panel should show.',
  '',
  '## Acceptance criteria',
  '',
  '- [x] The read resolves the workspace from the session',
  '- [ ] Comments stay out of the response',
  '',
  '## Progress',
  '',
  '- Progress: 40% (2026-11-23T15:15:33-03:00): Half of it is done',
].join('\n')

type Expected = {
  backendId: string
  /** 票号键：GitHub/GitLab/Markdown 是数字号，Linear 是 ENG-…。 */
  key: string
  /** 标题里那句能确认「读的是这张票」的原话。 */
  title: string
  /** 阻塞者键：四个后端都给了同一个阻塞者。 */
  blockerKey: string
}

/** 在一份假会话上跑票读，按同一组判据断言；四个后端共用这一段。 */
async function runTicket(label: string, session: DeckSession, want: Expected): Promise<void> {
  const phone = createDeckTicketRead({ handleCwd: cwdReply(session.cwd), openSession: session.openSession })
  const r: any = await phone.handleTicket({ sessionId: 's-' + label, key: want.key })
  check(r && r.ok === true, label + '：票读成功', JSON.stringify(r).slice(0, 300))
  check(r && r.backendId === want.backendId, label + '：回包带上这个后端自己的 id', r && r.backendId)
  const t = r && r.ticket
  check(t && t.key === want.key, label + '：详情带上票号', t && t.key)
  check(t && t.title === want.title, label + '：详情带上标题', t && t.title)
  check(t && t.state === 'OPEN', label + '：状态归一为大写两态', t && t.state)
  check(t && Array.isArray(t.labels) && t.labels.some((l: any) => l.name === 'wayfinder:task'), label + '：标签读出来了', t && JSON.stringify(t.labels))
  check(t && typeof t.body === 'string' && t.body.indexOf('A ticket the phone panel should show.') >= 0, label + '：正文原样带回', t && String(t.body).slice(0, 80))
  check(t && Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length === 2, label + '：验收标准读成两条', t && JSON.stringify(t.acceptanceCriteria))
  check(t && t.acceptanceCriteria && t.acceptanceCriteria[0] && t.acceptanceCriteria[0].done === true && t.acceptanceCriteria[1].done === false, label + '：勾选与未勾选分得清', t && JSON.stringify(t.acceptanceCriteria && t.acceptanceCriteria[0]))
  check(t && t.progress && t.progress.percent === 40, label + '：进度区读成结构化进度', t && JSON.stringify(t.progress))
  check(t && Array.isArray(t.blockedBy) && t.blockedBy.some((b: any) => String(b.key) === want.blockerKey), label + '：阻塞者读出来了', t && JSON.stringify(t.blockedBy))
  check(JSON.stringify(r).indexOf('SECRET COMMENT TEXT') < 0 && t && !Object.prototype.hasOwnProperty.call(t, 'comments'), label + '：回包里没有评论这一格')
  const open = session.calls.filter((x: any) => x.kind === 'open')[0]
  check(!!open && open.opts && open.opts.write === false, label + '：开会话时显式请求 write:false（只读就够）', open && JSON.stringify(open.opts))
  const got = session.calls.filter((x: any) => x.kind === 'get')[0]
  check(!!got && got.opt && got.opt.comments && got.opt.comments.first === 0, label + '：契约 get 只要 0 条评论正文', got && JSON.stringify(got.opt))
}

// —— 一、GitHub：脚本化 gh + 真实 GitHub 房间 ——
await runTicket('github', githubSession({
  issues: [],
  issue: githubNode(41, {
    title: 'GitHub ticket through the real room',
    body: BODY,
    labels: { nodes: [{ name: 'wayfinder:task', color: '0e8a16' }] },
    blockedBy: { nodes: [{ number: 40, title: 'Parent map', state: 'OPEN' }] },
    comments: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }),
}), { backendId: 'github', key: '41', title: 'GitHub ticket through the real room', blockerKey: '40' })

// —— 二、Linear：假 HTTP 通道 + 真实 Linear 房间 ——
await runTicket('linear', linearSession({
  issues: [],
  issue: linearNode('ENG-101', {
    title: 'Linear ticket through the real room',
    description: BODY,
    labels: { nodes: [{ name: 'wayfinder:task', color: '#4EA7FC' }] },
    inverseRelations: { nodes: [{ id: 'r-1', type: 'blocks', issue: { identifier: 'ENG-100', title: 'Parent map', state: { type: 'unstarted' } } }], pageInfo: { hasNextPage: false } },
  }),
}), { backendId: 'linear', key: 'ENG-101', title: 'Linear ticket through the real room', blockerKey: 'ENG-100' })

// —— 三、GitLab：脚本化 glab + 真实 GitLab 房间 ——
await runTicket('gitlab', gitlabSession({
  rows: [],
  issue: gitlabRow(101, {
    title: 'GitLab ticket through the real room',
    description: BODY,
    labels: [{ name: 'wayfinder:task', color: '#4EA7FC' }],
    blocked_by: [{ iid: 100, title: 'Parent map', state: 'opened' }],
  }),
}), { backendId: 'gitlab', key: '101', title: 'GitLab ticket through the real room', blockerKey: '100' })

// —— 四、本地 Markdown：真实临时工作区 + 真实 Markdown 房间 ——
await runTicket('markdown', markdownSession(), { backendId: 'markdown', key: '01', title: 'Open ticket from markdown', blockerKey: '02' })

printGateResult('verify-73-deck-ticket-read-backends', total, failed)
