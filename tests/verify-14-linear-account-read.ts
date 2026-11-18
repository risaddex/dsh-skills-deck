/** #14：只模拟账号缝与 HTTP，不借旧插件的查询实现。 */
import assert from 'node:assert/strict'
import type { OpContext, HttpRequest } from '../src/tracker/contract/contexts.js'
import type { AccountSeamEntry } from '../src/tracker/contract/accounts.js'
import { getAccountIssue, listAccountIssues, listConfiguredAccounts } from '../src/tracker/rooms/linear/account-read.js'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.js'

const entry = (alias = 'home', reviewScope = 'subscribed'): AccountSeamEntry => ({ alias, teams: ['ENG'], reviewPattern: 'review|qa', reviewScope })
const node = (id = 'one', state = 'In ReViEw', type = 'started') => ({ id, identifier: 'ENG-1', title: 'Ticket', state: { name: state, type }, team: { key: 'ENG' }, project: { id: 'project-id' } })
type Call = { alias: string; query: string; variables: Record<string, any> }
function fixture(options: { entries?: AccountSeamEntry[]; binding?: string; respond?: (call: Call, index: number) => unknown; fail?: string; throwResolve?: boolean } = {}) {
  const calls: Call[] = []
  const resolves: string[] = []
  const ctx = {
    cwd: '/workspace', signal: new AbortController().signal,
    fs: { resolve: async (path: string, opts: { cwd: string }) => { assert.equal(opts.cwd, '/workspace'); return '/workspace/' + path }, readText: async () => options.binding ?? '# Issue tracker: linear\nalias: home\nteam: ENG\nproject: Deck\n' },
    accounts: {
      list: async () => ({ ok: true, accounts: options.entries ?? [entry()] }),
      resolve: async (alias: string) => {
        resolves.push(alias)
        if (options.throwResolve) throw new Error('secret-token-' + alias)
        return alias === options.fail ? { ok: false, status: 'needs_auth', message: 'please sign in' } : { ok: true, alias, authorization: 'secret-token-' + alias }
      },
    },
    http: { request: async (req: HttpRequest) => {
      assert.ok(req.bucket === 'read' || req.bucket === 'probe')
      const body = JSON.parse(req.body || '{}')
      const alias = req.headers?.Authorization?.replace('secret-token-', '') || ''
      const call = { alias, ...body } as Call
      calls.push(call)
      const custom = options.respond?.(call, calls.length)
      const data = custom ?? (body.query.includes('LinearAccountProject') ? { projects: { nodes: [{ id: 'project-id' }], pageInfo: { hasNextPage: false } } } : body.query.includes('LinearIdentity') ? { viewer: { id: 'viewer-' + alias } } : body.query.includes('LinearAccountIssue') ? { issue: node() } : { issues: { nodes: [node()], pageInfo: { hasNextPage: false } } })
      return { status: 200, headers: {}, body: JSON.stringify(data && typeof data === 'object' && 'errors' in data ? data : { data }) }
    } },
  } as unknown as OpContext
  return { ctx, calls, resolves }
}

// 列账不探活，不解析凭据，并且只复制契约公开字段。
{
  const f = fixture({ entries: [{ ...entry(), authorization: 'MUST-NOT-LEAK' } as AccountSeamEntry] })
  const result = await listConfiguredAccounts(f.ctx)
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result).includes('MUST-NOT-LEAK'), false)
  assert.deepEqual(f.resolves, [])
  assert.deepEqual(f.calls, [])
}
// 指派口径使用 viewer.id，不用人名；团队与绑定项目同时收窄。
{
  const f = fixture()
  const result = await listAccountIssues(f.ctx, { scope: 'assigned', state: 'open' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal((result.data[0] as any).account, 'home')
  const query = f.calls.find(call => call.query.includes('query LinearIssues'))!
  assert.deepEqual(query.variables.filter.and, [
    { state: { type: { nin: ['completed', 'canceled', 'duplicate'] } } },
    { project: { id: { eq: 'project-id' } } },
    { team: { key: { in: ['ENG'] } } },
    { assignee: { id: { eq: 'viewer-home' } } },
  ])
}
// Review 正则不区分大小写；订阅筛选使用 some.id；终态即使名称命中也不返回。
{
  const f = fixture({ respond: call => call.query.includes('query LinearIssues') ? { issues: { nodes: [node('yes'), node('no', 'Review', 'completed'), node('other', 'Todo')], pageInfo: { hasNextPage: false } } } : undefined })
  const result = await listAccountIssues(f.ctx, { account: 'home', scope: 'review' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.length, 1)
  assert.ok(f.calls.some(call => JSON.stringify(call.variables).includes('"subscribers":{"some":{"id":{"eq":"viewer-home"}}}')))
}
// 一账号失败不抹掉另一账号的成功行，凭据不会进入聚合信封。
{
  const f = fixture({ entries: [entry('home'), entry('work')], fail: 'work' })
  const result = await listAccountIssues(f.ctx, { account: '*', scope: 'review' })
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(result.errors?.[0].account, 'work')
  if (result.ok) assert.equal((result.data[0] as any).account, 'home')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
}
// 全失败不是成功空名单，也不是部分成功。
{
  const f = fixture({ fail: 'home' })
  const result = await listAccountIssues(f.ctx, { account: '*' })
  assert.equal(result.ok, false)
  assert.equal(result.partial, undefined)
  assert.equal(result.errors?.length, 1)
  assert.equal('data' in result, false)
}
// 同名项目必须拒绝，不拿第一张项目冒充唯一匹配。
{
  const f = fixture({ respond: call => call.query.includes('LinearAccountProject') ? { projects: { nodes: [{ id: 'a' }, { id: 'b' }], pageInfo: { hasNextPage: false } } } : undefined })
  const result = await listAccountIssues(f.ctx, { account: 'home' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'conflict')
  assert.equal(f.calls.length, 1)
}
// 没有绑定就不出站，显式账号也不能绕过工作区范围。
{
  const f = fixture({ binding: '# No Linear binding' })
  assert.equal((await listAccountIssues(f.ctx, { account: '*' })).ok, false)
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', { account: 'home' })).ok, false)
  assert.equal(f.calls.length, 0)
}
// 显式另一账号使用自己的团队，而不是继承绑定账号的团队。
{
  const f = fixture({ entries: [entry(), { ...entry('work'), teams: ['OPS'] }] })
  const result = await listAccountIssues(f.ctx, { account: 'work' })
  assert.equal(result.ok, true)
  const filter = f.calls.find(call => call.query.includes('query LinearIssues'))!.variables.filter
  assert.ok(JSON.stringify(filter).includes('OPS'))
  assert.equal(JSON.stringify(filter).includes('ENG'), false)
  assert.deepEqual(f.resolves, ['work'])
}
// 每次调用分别解析凭据，不在模块上缓存上一工作区的账号。
{
  const a = fixture()
  const b = fixture({ entries: [entry('work')], binding: '# Issue tracker: linear\nalias: work\nteam: ENG\nproject: Deck' })
  const x = await getAccountIssue(a.ctx, 'ENG-1', { account: 'home' })
  const y = await getAccountIssue(b.ctx, 'ENG-1', { account: 'work' })
  assert.equal(x.ok, true); assert.equal(y.ok, true)
  assert.ok(a.calls.every(call => call.alias === 'home'))
  assert.ok(b.calls.every(call => call.alias === 'work'))
  if (y.ok) assert.equal((y.data as any).account, 'work')
}
// Get 不交出项目或团队外的节点，也不接受通配账号。
for (const wrong of [{ ...node(), project: { id: 'elsewhere' } }, { ...node(), team: { key: 'OPS' } }]) {
  const f = fixture({ respond: call => call.query.includes('LinearAccountIssue') ? { issue: wrong } : undefined })
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', { account: 'home' })).ok, false)
  const before = f.calls.length
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', { account: '*' })).ok, false)
  assert.equal(f.calls.length, before)
}
// 达到页预算明确截断；坏游标或回包缺连接明确失败。
{
  let page = 0
  const f = fixture({ respond: call => call.query.includes('query LinearIssues') ? { issues: { nodes: [node(String(++page))], pageInfo: { hasNextPage: true, endCursor: 'cursor-' + page } } } : undefined })
  f.ctx.listMaxPages = 2
  const result = await listAccountIssues(f.ctx, { account: 'home' })
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.equal(page, 2)
  assert.equal(f.calls.at(-1)?.variables.after, 'cursor-1')
}
for (const response of [{ issues: { nodes: [], pageInfo: { hasNextPage: true } } }, {}, { issues: { nodes: [null], pageInfo: { hasNextPage: false } } }]) {
  const f = fixture({ respond: call => call.query.includes('query LinearIssues') ? response : undefined })
  const result = await listAccountIssues(f.ctx, {})
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'parse')
}
// 不支持的条件不能悄悄丢掉，元数据不合法也不能变成默认 review。
for (const filter of [{ scope: 'unknown' }, { state: 'all' }, { labels: [null] }, { since: 'not-a-time' }, { surprise: true }, { parentKey: null }]) {
  const f = fixture()
  assert.equal((await listAccountIssues(f.ctx, filter as any)).ok, false)
  assert.equal(f.calls.length, 0)
}
{
  const f = fixture({ entries: [{ ...entry(), reviewPattern: '[' }] })
  assert.equal((await listAccountIssues(f.ctx, { scope: 'review' })).ok, false)
  assert.equal(f.calls.length, 0)
}
{
  const f = fixture({ entries: [entry(), entry()] })
  assert.equal((await listConfiguredAccounts(f.ctx)).ok, false)
}
// 远端回显凭据与 seam 抛出的异常均不能穿过结果边界。
{
  const f = fixture({ respond: call => ({ errors: [{ message: 'bad secret-token-' + call.alias }] }) })
  const result = await listAccountIssues(f.ctx, {})
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
}
{
  const f = fixture({ throwResolve: true })
  const result = await listAccountIssues(f.ctx, {})
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
}
// 工具默认 first:0 不要求评论正文；真正要求正文时明确拒绝。
{
  const f = fixture()
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', { account: 'home', comments: { first: 0 } })).ok, true)
  const count = f.calls.length
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', { account: 'home', comments: { first: 1 } })).ok, false)
  assert.equal(f.calls.length, count)
}
// 本地类型和全部标签过滤精确生效；since 保留在服务端筛选里。
{
  const f = fixture({ respond: call => call.query.includes('query LinearIssues') ? { issues: { nodes: [
    { ...node('map'), labels: { nodes: [{ name: 'wayfinder:map' }, { name: 'bug' }] } },
    { ...node('plain'), labels: { nodes: [{ name: 'bug' }] } },
  ], pageInfo: { hasNextPage: false } } } : undefined })
  const result = await listAccountIssues(f.ctx, { type: 'map', labels: ['bug', 'wayfinder:map'], since: '2026-11-01T00:00:00Z' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.length, 1)
  assert.ok(f.calls.some(call => JSON.stringify(call.variables).includes('"updatedAt":{"gte":"2026-11-01T00:00:00Z"}')))
}
// 公开房间接线保留旧入口；上下文元数据只列配置，不探活其他账号。
{
  const f = fixture({ entries: [entry(), entry('work')] })
  const backend = createLinearBackend(f.ctx)
  const preflight = await backend.preflight!({} as never, f.ctx)
  assert.equal(preflight.ok, true)
  assert.equal(preflight.accounts?.length, 2)
  assert.deepEqual(f.resolves, ['home'])
  assert.equal(f.calls.length, 1)
  const result = await backend.list!({} as never, { account: 'work', scope: 'assigned' }, f.ctx)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal((result.data[0] as any).account, 'work')
  const got = await backend.get!({} as never, 'ENG-1', { account: 'work', comments: { first: 0 } }, f.ctx)
  assert.equal(got.ok, true)
  if (got.ok) assert.equal((got.data as any).account, 'work')
}
// 账号入口不能用裸 key 猜账号；畸形 opts 也是失败值而不是异常。
for (const opts of [undefined, {}, null, { account: '*' }, { account: 'bad:alias' }, { account: 'home', comments: null }]) {
  const f = fixture()
  assert.equal((await getAccountIssue(f.ctx, 'ENG-1', opts as any)).ok, false)
  assert.equal(f.calls.length, 0)
}
// 单账号畸形项目节点不得冲掉其他账号的成功行。
{
  const f = fixture({ entries: [entry(), entry('work')], respond: call => call.alias === 'work' && call.query.includes('LinearAccountProject') ? { projects: { nodes: [null], pageInfo: { hasNextPage: false } } } : undefined })
  const result = await listAccountIssues(f.ctx, { account: '*' })
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(result.errors?.[0].account, 'work')
  if (result.ok) assert.equal(result.data.length, 1)
}
// ctx.http 抛错由客户端翻成失败，聚合器仍保留先前账号的成功。
{
  const f = fixture({ entries: [entry(), entry('work')], respond: call => {
    if (call.alias === 'work') throw new Error('secret-token-work')
    return undefined
  } })
  const result = await listAccountIssues(f.ctx, { account: '*' })
  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
}
for (const malformed of [{ ...node(), labels: { nodes: [null] } }, { ...node(), labels: { nodes: 'bad' } }, { ...node(), id: 17 }]) {
  const f = fixture({ respond: call => call.query.includes('LinearAccountIssue') ? { issue: malformed } : undefined })
  const result = await getAccountIssue(f.ctx, 'ENG-1', { account: 'home' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'parse')
}
// 解析失败时尚无授权值可用于遮蔽；账号缝返回的任意异常原文都不能穿过结果。
{
  const f = fixture()
  f.ctx.accounts!.resolve = async () => ({ ok: false, status: 'error', message: 'bad opaque-secret-without-prefix' })
  for (const result of [await listAccountIssues(f.ctx, { account: 'home' }), await getAccountIssue(f.ctx, 'ENG-1', { account: 'home' })]) {
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes('opaque-secret'), false)
  }
}
{
  const f = fixture({ respond: call => call.query.includes('query LinearIssues') ? { issues: { nodes: [{ ...node(), labels: { nodes: [{ name: 'Bug' }] } }], pageInfo: { hasNextPage: false } } } : undefined })
  const result = await listAccountIssues(f.ctx, { labels: ['bug'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.length, 1)
  // #49 taught the single-workspace reads to push labels into Linear's filter; the account-wide read stays a local,
  // case-insensitive filter, so no label condition may appear in what it sends (the 'Bug' row above is kept by that local filter).
  assert.equal(f.calls.filter(call => call.query.includes('query LinearIssues')).every(call => !JSON.stringify(call.variables.filter).includes('"labels"')), true)
}
console.log('verify-14-linear-account-read: all assertions passed')
