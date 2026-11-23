// tests/verify-73-deck-tree-read-backends.ts —— #73 门禁（后端矩阵·树读）：四个后端各走一遍真实读路径
//
// 判据来自票面：树读必须在 GitHub、GitLab、本地 Markdown 与 Linear 上都能读到同一棵树，且 GitHub 与
// Linear 是各自显式测的（不是「另一个后端通了，这个想必也通」）。四条路都经过同一份 Tracker 契约与同一条
// 「会话 → 只读会话 → 契约 list」管线；假身只换运输层（脚本化的 gh / glab、Linear 的假 HTTP 通道、
// 临时工作区），房间模块、开会话管线、宿主投影全部是真的。
//
// 这一扇证明的是「树读在四个后端上都通」；两个条数上限与字节护栏另见 verify-73-deck-read-limits.ts，
// 票读另见 verify-73-deck-ticket-read-backends.ts。
import { printGateResult } from './lib/gate-result.ts'
import { DECK_READ_LIMITS } from '../src/tracker/contract/deck-read.ts'
import { PAGINATION } from '../src/tracker/contract/pagination.ts'
import {
  cwdReply,
  githubMap,
  githubNode,
  githubSession,
  gitlabMap,
  gitlabRow,
  gitlabSession,
  linearMap,
  linearNode,
  linearSession,
  markdownSession,
  type DeckSession,
} from './lib/deck-backend-matrix.ts'

const { createDeckTreeRead } = await import('../src/host/deckTree.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

type Expected = {
  /** 后端 id（回包要原样带出来，面板据此说「这是哪个后端的树」）。 */
  backendId: string
  /** 容器与子票的键（各后端的键形状不同：GitHub/GitLab 是数字号，Linear 是 ENG-…，Markdown 是 00/01）。 */
  containerKey: string
  childKey: string
  /** 子票上的阻塞者键：四个后端都给了同一个阻塞者时才有。 */
  blockerKey?: string
}

/** 在一份假会话上跑树读，按同一组判据断言；四个后端共用这一段，判据不会各写一份。 */
async function runTree(label: string, session: DeckSession, want: Expected): Promise<void> {
  const phone = createDeckTreeRead({ handleCwd: cwdReply(session.cwd), openSession: session.openSession })
  const r: any = await phone.handleTree({ sessionId: 's-' + label })
  check(r && r.ok === true, label + '：树读成功', JSON.stringify(r).slice(0, 300))
  check(r && r.backendId === want.backendId, label + '：回包带上这个后端自己的 id', r && r.backendId)
  check(r && Array.isArray(r.containers) && r.containers.length === 1, label + '：树里恰好一个容器', r && r.containers && r.containers.length)
  const c = r && r.containers && r.containers[0]
  check(c && c.key === want.containerKey && c.kind === 'map', label + '：容器带自己的键与种类', c && JSON.stringify({ key: c.key, kind: c.kind }))
  check(c && c.state === 'OPEN' && typeof c.title === 'string' && c.title.length > 0, label + '：容器有标题与大写状态', c && JSON.stringify({ t: c.title, s: c.state }))
  check(c && Array.isArray(c.tickets) && c.tickets.length === 2, label + '：容器带两张子票', c && c.tickets && c.tickets.length)
  const child = c && c.tickets && c.tickets.find((t: any) => t.key === want.childKey)
  check(child && typeof child.title === 'string' && child.title.length > 0 && child.state === 'OPEN', label + '：子票带键、标题与大写状态', child && JSON.stringify(child))
  check(child && !Object.prototype.hasOwnProperty.call(child, 'body'), label + '：子票行不带正文')
  check(r && r.truncated === false && r.backendTruncated === false && r.omittedContainers === 0 && r.omittedTickets === 0, label + '：完整结果没有任何截断信号', r && JSON.stringify({ t: r.truncated, o: r.omittedTickets }))
  // 只读是硬条件：两条读在任何后端上都只开 read 会话。
  const open = session.calls.filter((x: any) => x.kind === 'open')[0]
  check(!!open && open.opts && open.opts.write === false, label + '：开会话时显式请求 write:false（只读就够）', open && JSON.stringify(open.opts))
  const list = session.calls.filter((x: any) => x.kind === 'list')[0]
  check(!!list && list.filter && list.filter.state === 'open', label + '：契约 list 按 state=open 读（关闭的容器与票不进树）', list && JSON.stringify(list.filter))
  if (want.blockerKey) {
    check(child && Array.isArray(child.blockedBy) && child.blockedBy.some((b: any) => String(b.key) === want.blockerKey), label + '：子票的阻塞者读出来了', child && JSON.stringify(child.blockedBy))
  }
}

// —— 一、GitHub：脚本化 gh + 真实 GitHub 房间 ——
await runTree('github', githubSession({
  issues: [
    githubMap(40),
    githubNode(41, { parent: { number: 40 }, blockedBy: { nodes: [{ number: 42, title: 'Blocker', state: 'CLOSED' }] } }),
    githubNode(42, { parent: { number: 40 } }),
  ],
}), { backendId: 'github', containerKey: '40', childKey: '41', blockerKey: '42' })

// —— 二、Linear：假 HTTP 通道 + 真实 Linear 房间 ——
await runTree('linear', linearSession({
  issues: [
    linearMap('ENG-916'),
    linearNode('ENG-917', { parent: { identifier: 'ENG-916' }, inverseRelations: { nodes: [{ id: 'r-1', type: 'blocks', issue: { identifier: 'ENG-918', title: 'Blocker', state: { type: 'completed' } } }], pageInfo: { hasNextPage: false } } }),
    linearNode('ENG-918', { parent: { identifier: 'ENG-916' } }),
  ],
}), { backendId: 'linear', containerKey: 'ENG-916', childKey: 'ENG-917', blockerKey: 'ENG-918' })

// —— 三、GitLab：脚本化 glab + 真实 GitLab 房间 ——
await runTree('gitlab', gitlabSession({
  rows: [
    gitlabMap(101),
    gitlabRow(102, { title: 'Ticket 102', description: '<!-- DSH-PARENT: 101 -->', blocked_by: [{ iid: 103, title: 'Blocker', state: 'opened' }] }),
    gitlabRow(103, { description: '<!-- DSH-PARENT: 101 -->' }),
  ],
}), { backendId: 'gitlab', containerKey: '101', childKey: '102', blockerKey: '103' })

// —— 四、本地 Markdown：真实临时工作区 + 真实 Markdown 房间 ——
await runTree('markdown', markdownSession(), { backendId: 'markdown', containerKey: '00', childKey: '01', blockerKey: '02' })

// —— 五、上限在真实回包上同样生效：GitHub 回 60 个地图，树只画前 50 个并说清楚 ——
{
  const session = githubSession({ issues: Array.from({ length: DECK_READ_LIMITS.maxContainers + 10 }, (_, i) => githubMap(100 + i)) })
  const phone = createDeckTreeRead({ handleCwd: cwdReply(session.cwd), openSession: session.openSession })
  const r: any = await phone.handleTree({ sessionId: 's-github-capped' })
  check(r && r.ok === true, 'GitHub：容器超过上限时读仍成功', JSON.stringify(r).slice(0, 200))
  check(r && r.containers && r.containers.length === DECK_READ_LIMITS.maxContainers, 'GitHub：真实回包也只画前 ' + DECK_READ_LIMITS.maxContainers + ' 个容器', r && r.containers && r.containers.length)
  check(r && r.truncated === true && r.containersTruncated === true && r.backendTruncated === false, 'GitHub：截断信号来自本层容器上限，不是后端名册', r && JSON.stringify({ t: r.truncated, c: r.containersTruncated, b: r.backendTruncated }))
  check(r && r.omittedContainers === 10, 'GitHub：少画的 10 个容器如实报出', r && r.omittedContainers)
}

// —— 六、后端自己说名单不全时，真实房间的那个事实也要传到回包上（GitLab 一页取满就是这种） ——
{
  // 回满一页（GitLab 的 per_page 上限，从共享分页表取）时房间自己就会置 truncated：那是后端说的话，
  // 宿主不许把它吞掉，也不许和自己的两个上限混成一句话。
  const rows = Array.from({ length: PAGINATION.gitlab.maxPerPage }, (_, i) => gitlabMap(200 + i))
  const session = gitlabSession({ rows })
  const phone = createDeckTreeRead({ handleCwd: cwdReply(session.cwd), openSession: session.openSession })
  const r: any = await phone.handleTree({ sessionId: 's-gitlab-pagefull' })
  check(r && r.ok === true && r.backendId === 'gitlab', 'GitLab：一页取满时树读仍成功', JSON.stringify(r).slice(0, 200))
  check(r && r.backendTruncated === true, 'GitLab：取满一页时房间自己置的 truncated 传到回包上（名册可能还有第 101 张）', r && r.backendTruncated)
  check(r && r.containers && r.containers.length === DECK_READ_LIMITS.maxContainers, 'GitLab：100 个容器里只画前 ' + DECK_READ_LIMITS.maxContainers + ' 个', r && r.containers && r.containers.length)
}

printGateResult('verify-73-deck-tree-read-backends', total, failed)
