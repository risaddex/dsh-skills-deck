// tests/verify-72-deck-ticket-read.ts —— #72 门禁（投影）：一张票被读成什么样
//
// 判据直接来自票面：完整票读出七样东西（标题、状态、标签、正文、验收标准、进度、阻塞者）、
// 没有可选区块的票不凭空造、评论一个字都不出现、验收标准只认它那个区。
// 只在宿主电话的公开出口（createDeckTicketRead → handleTicket）上断言，不进入投影内部。
// 失败形状见 verify-72-deck-ticket-read-failures.ts，真实解析器与管线见 -seams.ts。
import { printGateResult } from './lib/gate-result.ts'
import { FULL_BODY, FULL_TICKET, REPO, okCwd, openedWithTicket } from './lib/deck-ticket-fixture.ts'

const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

// —— 第一片：完整的一张票，七样东西都读得出来，评论一个字都不出现 ——
{
  const calls: any[] = []
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(FULL_TICKET, calls) })
  const r: any = await phone.handleTicket({ sessionId: 's-full', key: '72' })
  check(r && r.ok === true, '完整票返回 ok=true', JSON.stringify(r).slice(0, 200))
  const t = r && r.ticket
  check(t && t.key === '72' && t.number === 72, '详情带上票号（字符串键与数字号）')
  check(t && t.title === 'Read one deck ticket for the same session', '详情带上标题')
  check(t && t.state === 'OPEN', '状态归一为大写两态，与树读取同口径')
  check(t && t.url === 'https://example.test/acme/demo/issues/72', '详情带上链接')
  check(t && Array.isArray(t.labels) && t.labels.length === 2
    && t.labels[0].name === 'ready-for-agent' && t.labels[0].color === '0e8a16'
    && t.labels[1].name === 'bug' && t.labels[1].color === '', '标签带名字与颜色，后端不给颜色时是空串')
  check(t && t.body === FULL_BODY, '正文原样带回，不被摘要截断')
  check(t && Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length === 3, '验收标准读成三条')
  check(t && t.acceptanceCriteria && t.acceptanceCriteria[0].text === 'The read resolves the workspace from the session' && t.acceptanceCriteria[0].done === false, '未勾选的验收项 done=false')
  check(t && t.acceptanceCriteria && t.acceptanceCriteria[1].text === 'The detail returns the labels' && t.acceptanceCriteria[1].done === true, '已勾选的验收项 done=true')
  check(t && t.progress && t.progress.percent === 40 && t.progress.updatedAt === '2026-11-23T15:15:33-03:00', '进度区读成结构化进度（百分比与时间）')
  check(t && Array.isArray(t.blockedBy) && t.blockedBy.length === 1
    && t.blockedBy[0].key === '71' && t.blockedBy[0].title === 'Read the session deck tree' && t.blockedBy[0].state === 'CLOSED', '阻塞者带键、标题与大写状态')
  check(JSON.stringify(r).indexOf('SECRET COMMENT TEXT') < 0, '评论正文不出现在回包里')
  check(t && !Object.prototype.hasOwnProperty.call(t, 'comments'), '详情里没有评论这一格')
  check(calls.length === 2 && calls[0].kind === 'open' && calls[0].cwd === '/workspace/demo' && calls[0].opts && calls[0].opts.write === false, '只读会话使用会话解析出的 cwd，并显式请求 write:false')
  check(calls[1] && calls[1].kind === 'get' && calls[1].ref === REPO && calls[1].key === '72', 'Tracker 契约按会话解析出的仓库身份读那一张票')
  check(calls[1] && calls[1].opt && calls[1].opt.comments && calls[1].opt.comments.first === 0, '读票时只要 0 条评论正文（面板不显示评论，别把整页评论拉回来再丢掉）')
}

// —— 第二片：没有可选区块的票，不凭空造东西；明确给空的照旧给空 ——
{
  const sparse = {
    key: 'ab-7', type: 'issue', title: 'A Linear ticket with a text key', state: 'closed',
    body: '', url: '', parentKey: null, createdAt: '', updatedAt: '', closedAt: '2026-11-23T18:00:00Z',
  }
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(sparse, []) })
  const r: any = await phone.handleTicket({ sessionId: 's-sparse', key: 'ab-7' })
  const t = r && r.ticket
  check(r && r.ok === true, '没有可选区块的票照样读得出来')
  check(t && t.key === 'ab-7' && t.number === null, '文字键原样保留，读不出数字号时给 null 而不是猜一个')
  check(t && t.state === 'CLOSED', '关闭的票状态归一为 CLOSED')
  check(t && t.body === '', '没有正文时正文是空串')
  check(t && Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length === 0, '没有验收标准区时回空数组，不凭空造条目')
  check(t && t.progress && t.progress.percent === null && Array.isArray(t.progress.entries) && t.progress.entries.length === 0, '没有进度区时百分比是 null，不是 0')
  check(t && !Object.prototype.hasOwnProperty.call(t, 'labels'), '后端整格没给标签时省略这一格，不写成空数组')
  check(t && !Object.prototype.hasOwnProperty.call(t, 'blockedBy'), '后端整格没给阻塞者时省略这一格，不写成空数组')
  check(t && !Object.prototype.hasOwnProperty.call(t, 'status'), '后端不报 triage 状态时省略那一格（缺席不等于没有状态）')
}

{
  const explicitEmpty = {
    key: '9', number: 9, type: 'issue', title: 'Nothing optional but said so', state: 'open',
    body: 'just a line', url: '', parentKey: null, labels: [], blockedBy: [],
  }
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(explicitEmpty, []) })
  const r: any = await phone.handleTicket({ sessionId: 's-empty', key: 9 })
  const t = r && r.ticket
  check(t && Array.isArray(t.labels) && t.labels.length === 0, '后端明确给空标签数组时保留空数组')
  check(t && Array.isArray(t.blockedBy) && t.blockedBy.length === 0, '后端明确给空阻塞数组时保留空数组')
  check(t && t.key === '9', '客户端送数字票号时也收得下，并折成字符串键')
}

// —— 第三片：triage 状态（还开着不等于可接）——
{
  const markdownTicket = {
    key: '03', number: 3, type: 'issue', title: 'A markdown ticket', state: 'open',
    status: 'needs-triage', statusSource: 'visible', url: '', body: '',
  }
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(markdownTicket, []) })
  const r: any = await phone.handleTicket({ sessionId: 's-md', key: '03' })
  check(r && r.ok === true && r.ticket && r.ticket.status === 'needs-triage', '后端报 triage 状态时带出去')
  check(r && r.ticket && r.ticket.state === 'OPEN', 'triage 状态不顶替生命周期两态')
  check(r && r.ticket && !Object.prototype.hasOwnProperty.call(r.ticket, 'statusSource'), '状态来源这一格不外泄（详情只关心状态本身）')
}

// —— 第四片：验收标准的读法只认它那个区 ——
{
  const trickyBody = [
    '## Acceptance criteria', '', '- [x] Only this one counts', '', '```md',
    '- [ ] an example inside a fence does not count', '```', '', '## 验收标准', '',
    '- [ ] the second section is not the acceptance section', '', '## Out of scope', '',
    '- [ ] an unchecked item outside the section does not count',
  ].join('\n')
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithTicket({ key: '5', number: 5, title: 't', state: 'open', body: trickyBody, url: '' }, []),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-tricky', key: '5' })
  const items = (r && r.ticket && r.ticket.acceptanceCriteria) || []
  check(items.length === 1 && items[0].text === 'Only this one counts' && items[0].done === true, '只收验收标准区里的勾选项：围栏里的示例、后面那个区、区外的勾选项都不算', JSON.stringify(items))
}

{
  const chineseBody = ['## 验收标准', '', '- [ ] 会话能解析出工作区', '- [x] 详情带标签'].join('\n')
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithTicket({ key: '8', number: 8, title: '老票', state: 'open', body: chineseBody, url: '' }, []),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-cn', key: '8' })
  const items = (r && r.ticket && r.ticket.acceptanceCriteria) || []
  check(items.length === 2 && items[0].text === '会话能解析出工作区' && items[1].done === true, '老票的中文验收标准区也读得出来', JSON.stringify(items))
}

{
  // 自造标题不算：按整句比就是为拦住这种下面没有勾选项的「差不多算命中」。
  const draftedBody = ['## Acceptance criteria (draft)', '', '- [ ] not decided yet'].join('\n')
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithTicket({ key: '6', number: 6, title: 't', state: 'open', body: draftedBody, url: '' }, []),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-draft', key: '6' })
  const items = (r && r.ticket && r.ticket.acceptanceCriteria) || []
  check(items.length === 0, '自造的标题（Acceptance criteria (draft)）不算验收标准区', JSON.stringify(items))
}

printGateResult('verify-72-deck-ticket-read', total, failed)
