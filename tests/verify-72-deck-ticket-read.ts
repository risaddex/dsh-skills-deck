// tests/verify-72-deck-ticket-read.ts —— #72 门禁：按会话读取一张票的结构化详情
//
// 判据直接来自票面：完整票读出七样东西（标题、状态、标签、正文、验收标准、进度、阻塞者）、
// 没有可选区块的票不凭空造、评论绝不出现、缺票与读失败是两种可分辨的结果。
// 测试只驱动宿主电话的公开出口（createDeckTicketRead → handleTicket）与真实的
// 「会话 → Tracker 契约 get」路径，不进入投影内部，也不手写最终回包形状。
import { printGateResult } from './lib/gate-result.ts'

const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

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

const FULL_BODY = [
  '## What to build',
  '',
  'Something the panel should show.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] The read resolves the workspace from the session',
  '- [x] The detail returns the labels',
  '- [ ] Comments stay out of the response',
  '',
  '## Progress',
  '',
  '- Progress: 40% (2026-11-23T15:15:33-03:00): Half of it is done',
  '',
  '## Out of scope',
  '',
  '- Comment threads',
].join('\n')

const FULL_TICKET = {
  key: '72',
  number: 72,
  type: 'issue',
  title: 'Read one deck ticket for the same session',
  state: 'open',
  body: FULL_BODY,
  url: 'https://example.test/acme/demo/issues/72',
  createdAt: '2026-11-23T17:00:00Z',
  updatedAt: '2026-11-23T17:57:08Z',
  closedAt: null,
  parentKey: '70',
  labels: [{ name: 'ready-for-agent', color: '0e8a16' }, { name: 'bug', color: '' }],
  blockedBy: [{ key: '71', title: 'Read the session deck tree', state: 'closed' }],
  comments: [{ id: 'c1', author: { login: 'someone' }, body: 'SECRET COMMENT TEXT', createdAt: '2026-11-23T17:10:00Z', updatedAt: '2026-11-23T17:10:00Z' }],
  commentCount: 3,
}

function openedWithTicket(issue: unknown, calls: any[], resultExtra: any = {}) {
  return async (cwd: string, opts: any) => {
    calls.push({ kind: 'open', cwd, opts })
    return {
      ok: true,
      backendId: 'github',
      repoRef: REPO,
      call: async (fn: any) => fn({
        get: async (ref: any, key: any, opt: any, ctx: any) => {
          calls.push({ kind: 'get', ref, key, opt, ctx })
          return Object.assign({ ok: true, data: issue }, resultExtra)
        },
      }, { cwd }),
    }
  }
}

// —— 第一片：完整的一张票，七样东西都读得出来，评论一个字都不出现 ——
{
  const calls: any[] = []
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithTicket(FULL_TICKET, calls),
  })
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
  check(calls[1] && calls[1].opt && calls[1].opt.comments === undefined, '读票时连评论都不向后端要（不是取回来再丢掉）')
}

// —— 第二片：没有可选区块的票，不凭空造东西；明确给空的照旧给空 ——
{
  const sparse = {
    key: 'ab-7',
    type: 'issue',
    title: 'A Linear ticket with a text key',
    state: 'closed',
    body: '',
    url: '',
    parentKey: null,
    createdAt: '',
    updatedAt: '',
    closedAt: '2026-11-23T18:00:00Z',
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
}

{
  const explicitEmpty = {
    key: '9',
    number: 9,
    type: 'issue',
    title: 'Nothing optional but said so',
    state: 'open',
    body: 'just a line',
    url: '',
    parentKey: null,
    labels: [],
    blockedBy: [],
  }
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(explicitEmpty, []) })
  const r: any = await phone.handleTicket({ sessionId: 's-empty', key: 9 })
  const t = r && r.ticket
  check(t && Array.isArray(t.labels) && t.labels.length === 0, '后端明确给空标签数组时保留空数组')
  check(t && Array.isArray(t.blockedBy) && t.blockedBy.length === 0, '后端明确给空阻塞数组时保留空数组')
  check(t && t.key === '9', '客户端送数字票号时也收得下，并折成字符串键')
}

// —— 第三片：验收标准的读法只认它那个区，围栏里的示例与别的区里的勾选项都不算 ——
{
  const trickyBody = [
    '## Acceptance criteria',
    '',
    '- [x] Only this one counts',
    '',
    '```md',
    '- [ ] an example inside a fence does not count',
    '```',
    '',
    '## 验收标准',
    '',
    '- [ ] the second section is not the acceptance section',
    '',
    '## Out of scope',
    '',
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
  const chineseBody = [
    '## 验收标准',
    '',
    '- [ ] 会话能解析出工作区',
    '- [x] 详情带标签',
  ].join('\n')
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithTicket({ key: '8', number: 8, title: '老票', state: 'open', body: chineseBody, url: '' }, []),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-cn', key: '8' })
  const items = (r && r.ticket && r.ticket.acceptanceCriteria) || []
  check(items.length === 2 && items[0].text === '会话能解析出工作区' && items[1].done === true, '老票的中文验收标准区也读得出来', JSON.stringify(items))
}

// —— 第四片：缺票、读失败、回包不成形，是三种彼此可分辨的结果 ——
{
  const backing = async (result: any) => async (cwd: string, opts: any) => ({
    ok: true,
    backendId: 'github',
    repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => result }, { cwd }),
  })
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: await backing({ ok: false, error: { kind: 'not-found', message: 'Could not resolve to an issue with the number of 999.' } }) })
  const r: any = await phone.handleTicket({ sessionId: 's-missing', key: '999' })
  check(r && r.ok === false, '缺票时回 ok=false')
  check(r && r.error && r.error.kind === 'not-found', '缺票的机器可读原因是 not-found', JSON.stringify(r.error))
  check(r && r.error && r.error.message === 'Could not resolve to an issue with the number of 999.', '缺票时把后端原话带上，不换一句自己编的')
  check(!('ticket' in (r || {})), '缺票时没有 ticket 这一格（不交半张空票）')
}

{
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: await (async () => async (cwd: string) => ({
    ok: true, backendId: 'github', repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => ({ ok: false, error: { kind: 'network', message: 'connection reset by peer' } }) }, { cwd }),
  }))() })
  const r: any = await phone.handleTicket({ sessionId: 's-net', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'network', '读失败的失败原因原样带出（network），与缺票分开', JSON.stringify(r.error))
  check(r && r.error && r.error.kind !== 'not-found', '读失败不会被说成缺票')
}

{
  const throwing = async (cwd: string) => ({
    ok: true, backendId: 'github', repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => { throw new Error('the backend implementation threw') } }, { cwd }),
  })
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: throwing })
  const r: any = await phone.handleTicket({ sessionId: 's-throw', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'fetch-failed', '后端实现抛错时折成 fetch-failed，不是悄悄回一张空票', JSON.stringify(r.error))
  check(r && r.error && r.error.message.indexOf('the backend implementation threw') >= 0, '抛错时保留抛出来的那句话')
}

{
  const noRow = async (cwd: string) => ({
    ok: true, backendId: 'github', repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => ({ ok: true }) }, { cwd }),
  })
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: noRow })
  const r: any = await phone.handleTicket({ sessionId: 's-norow', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'parse', '后端说读成了却没给票行时归 parse，不拿空对象装成一张票', JSON.stringify(r.error))
}

{
  let getCalled = false
  const mustNotGet = async (cwd: string) => ({
    ok: true, backendId: 'github', repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => { getCalled = true; return { ok: true, data: {} } } }, { cwd }),
  })
  const noSid = createDeckTicketRead({ handleCwd: async () => { throw new Error('must not be called without a session id') }, openSession: mustNotGet })
  const r: any = await noSid.handleTicket({ key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'no-sid', '缺 sessionId 时直接失败，reason=no-sid')
  check(getCalled === false, '缺 sessionId 时连那张票都不读')

  const noKey = createDeckTicketRead({ handleCwd: okCwd, openSession: mustNotGet })
  const rk: any = await noKey.handleTicket({ sessionId: 's-full' })
  check(rk && rk.ok === false && rk.error && rk.error.kind === 'no-key', '缺票号时直接失败，reason=no-key')
  check(getCalled === false, '缺票号时不去读一张不知道是谁的票')
}

{
  // 会话找不到：如实失败，且绝不回落到别的 workspace 去读别的仓库的票。
  let openCalled = false
  let getCalled = false
  const phone = createDeckTicketRead({
    handleCwd: async () => ({ ok: false, error: 'This session could not be found', kind: 'not-found' }),
    openSession: async () => { openCalled = true; return { ok: true, backendId: 'github', repoRef: REPO, call: async (fn: any) => { getCalled = true; return fn({ get: async () => ({ ok: true, data: {} }) }, {}) } } },
  })
  const r: any = await phone.handleTicket({ sessionId: 'missing', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'not-found', '找不到会话时如实失败')
  check(openCalled === false && getCalled === false, '找不到会话时绝不回落到 Tracker 或别的 workspace')
}

// —— 第五片：真实会话解析器把 sessionId 解析成 workspace，调用方一个字路径都不传 ——
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

// —— 第六片：真实 session opener + 真实读取管线 + 假的 GitHub 房间，证明这条路真的通 ——
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
  check(r && r.ticket && r.ticket.title === 'GitHub ticket through the real pipeline' && r.ticket.labels && r.ticket.labels[0].name === 'ready-for-agent', '真实管线回来的标签进入详情')
  check(r && r.ticket && r.ticket.acceptanceCriteria && r.ticket.acceptanceCriteria.length === 1 && r.ticket.acceptanceCriteria[0].done === true, '真实管线回来的验收标准读成已完成的一条')
  check(r && r.ticket && r.ticket.blockedBy && r.ticket.blockedBy[0] && r.ticket.blockedBy[0].key === '40', '真实管线回来的阻塞者进入详情')
}

printGateResult('verify-72-deck-ticket-read', total, failed)
