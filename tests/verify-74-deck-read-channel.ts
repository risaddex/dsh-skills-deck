// tests/verify-74-deck-read-channel.ts —— #74 门禁：把两条只读宿主方法暴露给远程宿主的那一道读通道。
//
// 判据来自票面（规格 #70 第四票）：
//   · 远程宿主只能经这一道口读树与读票，一共两个操作；其它任何操作名都被拒，且拒绝时一条读都不发；
//   · deck.panel.read.v1 只有在两个操作都在、都能加载时才算「可用」，缺一个就不可用，不可用时调用也失败；
//   · 请求形状不对（不是对象、多带字段、sessionId 缺失或过长、票号缺失）一律失败，且不碰后端；
//     尤其是不许带 cwd / path 这类自由路径：规格写明工作区只由宿主按 sessionId 解析；
//   · 读失败、读抛错、读超时、回包不成形状、回包过大一律失败，不编造任何数据；
//   · 读通道只服务这两条宿主方法，不挂任何写操作；桌面 / 网页面板那条老路（wf.deckTree / wf.deckTicket）不动。
//
// 测试在读通道的公开出口（createDeckReadChannel）上驱动，只把两条宿主方法与日志口换成可控夹具。
import { printGateResult } from './lib/gate-result.ts'
import { DECK_READ_LIMITS } from '../src/tracker/contract/deck-read.ts'

const mod = await import('../src/host/deckReadChannel.ts')
const { createDeckReadChannel, DECK_READ_FEATURE } = mod

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

type Calls = { tree: any[]; ticket: any[] }

/** 造一道读通道：两条宿主方法默认都成功；各自的行为可以被覆盖。 */
function make(over: { tree?: (a: any) => any; ticket?: (a: any) => any; loadTree?: () => any; loadTicket?: () => any; timeoutMs?: number } = {}) {
  const calls: Calls = { tree: [], ticket: [] }
  const logs: any[] = []
  const tree = over.tree || ((a: any) => ({ ok: true, sessionId: a.sessionId, workspaceRoot: '/w', backendId: 'github', containers: [], truncated: false }))
  const ticket = over.ticket || ((a: any) => ({ ok: true, sessionId: a.sessionId, workspaceRoot: '/w', backendId: 'github', ticket: { key: String(a.key), title: 'T', state: 'OPEN' } }))
  const channel = createDeckReadChannel({
    loadTree: over.loadTree || (async () => ({ handleTree: async (a: any) => { calls.tree.push(a); return tree(a) } })),
    loadTicket: over.loadTicket || (async () => ({ handleTicket: async (a: any) => { calls.ticket.push(a); return ticket(a) } })),
    logCtx: { fire: (level: string, event: string, fields: any) => { logs.push({ level, event, fields }) } },
    timeoutMs: over.timeoutMs,
  })
  return { channel, calls, logs }
}

// —— 一、名字与只有两个操作 ——
{
  const { channel } = make()
  check(DECK_READ_FEATURE === 'deck.panel.read.v1', '协商出去的功能名是 deck.panel.read.v1')
  check(channel.feature === 'deck.panel.read.v1', '读通道自己带着同一个功能名')
  check(Array.isArray(channel.operations) && channel.operations.length === 2 && channel.operations[0] === 'tree' && channel.operations[1] === 'ticket', '操作清单正好是 tree 与 ticket 两个')
  check(Object.isFrozen(channel) && Object.isFrozen(channel.operations), '读通道与操作清单都冻结，别的插件改不了它')
  const keys = Object.keys(channel).sort().join(',')
  check(keys === 'available,call,feature,operations', '读通道只露这四样，没有写入口也没有别的读口', keys)
}

// —— 二、可用性：两个操作都在且都加载得起来才可用 ——
{
  const ok = make()
  const a: any = await ok.channel.available()
  check(a && a.available === true, '两个操作都能加载时可用')
  const noTree = make({ loadTree: async () => ({}) })
  const b: any = await noTree.channel.available()
  check(b && b.available === false && typeof b.reason === 'string' && b.reason.length > 0, '树读缺失时不可用，并给出原因', JSON.stringify(b))
  const noTicket = make({ loadTicket: async () => null })
  const c: any = await noTicket.channel.available()
  check(c && c.available === false, '票读缺失时不可用')
  const throws = make({ loadTree: async () => { throw new Error('import failed: /secret/path') } })
  const d: any = await throws.channel.available()
  check(d && d.available === false, '加载抛错时不可用，不把异常抛给协商方')
  check(d && !String(d.reason).includes('/secret/path'), '不可用的原因里不带路径原文', d && d.reason)
  const hang = make({ loadTree: () => new Promise(() => {}), timeoutMs: 40 })
  const e: any = await hang.channel.available()
  check(e && e.available === false, '加载卡住时按超时算不可用，不无限等')
}

// —— 三、两条读都能走通，且原样带回 ——
{
  const { channel, calls } = make()
  const t: any = await channel.call('tree', { sessionId: 's-1' })
  check(t && t.ok === true && Array.isArray(t.containers) && t.sessionId === 's-1', '树读走通并带回回包')
  check(calls.tree.length === 1 && calls.tree[0].sessionId === 's-1', '树读把 sessionId 交给树宿主方法')
  const k: any = await channel.call('ticket', { sessionId: 's-1', key: '74' })
  check(k && k.ok === true && k.ticket && k.ticket.key === '74', '票读走通并带回回包')
  check(calls.ticket.length === 1 && calls.ticket[0].sessionId === 's-1' && calls.ticket[0].key === '74', '票读把 sessionId 与票号交给票宿主方法')
  const n: any = await channel.call('ticket', { sessionId: 's-1', key: 74 })
  check(n && n.ok === true && calls.ticket[1].key === 74, '票号是整数时也接受并原样交下去')
}

// —— 四、其它任何操作都被拒，一条读都不发 ——
{
  const { channel, calls, logs } = make()
  const refused = ['invoke', 'create', 'update', 'close', 'comment', 'snapshot', 'wf.deckTree', 'wf.deckExec', 'Tree', ' tree', 'tree ', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']
  let allRefused = true
  let allKind = true
  for (const op of refused) {
    const r: any = await channel.call(op, { sessionId: 's-1' })
    if (!(r && r.ok === false)) allRefused = false
    if (!(r && r.error && r.error.kind === 'operation-not-allowed')) allKind = false
  }
  check(allRefused, '写操作名、内部宿主方法名、大小写与空白变体、原型链上的名字全被拒')
  check(allKind, '被拒的原因一律是 operation-not-allowed')
  for (const bad of [undefined, null, 7, {}, [], true] as any[]) {
    const r: any = await channel.call(bad, { sessionId: 's-1' })
    if (!(r && r.ok === false && r.error.kind === 'operation-not-allowed')) allRefused = false
  }
  check(allRefused, '操作名不是字符串时同样被拒')
  check(calls.tree.length === 0 && calls.ticket.length === 0, '被拒的调用一条读都没有发出去')
  check(logs.length > 0 && logs.every((l) => l.event === 'host.call.fail'), '每次被拒都记一行失败日志，没有一行成功日志')
  check(!JSON.stringify(logs).includes('wf.deckExec'), '日志里不记操作名原文，只记散列')
}

// —— 五、请求形状不对：失败且不碰后端 ——
{
  const { channel, calls } = make()
  const cases: Array<[string, string, any]> = [
    ['tree', '参数缺失', undefined],
    ['tree', '参数是 null', null],
    ['tree', '参数是数组', []],
    ['tree', '参数是字符串', 'abc'],
    ['tree', 'sessionId 缺失', {}],
    ['tree', 'sessionId 为空串', { sessionId: '' }],
    ['tree', 'sessionId 不是字符串', { sessionId: 7 }],
    ['tree', 'sessionId 超过 512 个字符', { sessionId: 'x'.repeat(513) }],
    ['tree', '树读带了票号', { sessionId: 's', key: '1' }],
    ['tree', '带了自由路径 cwd', { sessionId: 's', cwd: '/etc' }],
    ['tree', '带了自由路径 path', { sessionId: 's', path: '/etc/passwd' }],
    ['ticket', '票号缺失', { sessionId: 's' }],
    ['ticket', '票号为空串', { sessionId: 's', key: '' }],
    ['ticket', '票号是对象', { sessionId: 's', key: {} }],
    ['ticket', '票号是 NaN', { sessionId: 's', key: NaN }],
    ['ticket', '票号是小数', { sessionId: 's', key: 1.5 }],
    ['ticket', '票号超过 200 个字符', { sessionId: 's', key: 'k'.repeat(201) }],
    ['ticket', '票读带了 cwd', { sessionId: 's', key: '1', cwd: '/etc' }],
    ['ticket', '票读带了 comments 开关', { sessionId: 's', key: '1', comments: true }],
  ]
  let badAll = true
  const wrong: string[] = []
  for (const [op, why, params] of cases) {
    const r: any = await channel.call(op, params)
    if (!(r && r.ok === false && r.error && r.error.kind === 'bad-request')) { badAll = false; wrong.push(why) }
  }
  check(badAll, '请求形状不对的十九种情况全部以 bad-request 失败', wrong.join(' | '))
  check(calls.tree.length === 0 && calls.ticket.length === 0, '形状不对的请求一条读都没有发出去')
  const proto = Object.create({ sessionId: 's' })
  const r: any = await channel.call('tree', proto)
  check(r && r.ok === false && r.error.kind === 'bad-request', '靠原型链借来的 sessionId 不算数')
}

// —— 六、不可用时调用也失败 ——
{
  const { channel, calls } = make({ loadTicket: async () => ({}) })
  const r: any = await channel.call('tree', { sessionId: 's-1' })
  check(r && r.ok === false && r.error.kind === 'unavailable', '功能不可用（票读缺失）时连树读也失败，不放行半个通道', JSON.stringify(r))
  check(calls.tree.length === 0, '不可用时没有发出任何读')
}

// —— 七、读失败 / 抛错 / 超时 / 回包不成形状 / 回包过大：都失败，不编造数据 ——
{
  const failing = make({ tree: () => ({ ok: false, error: { kind: 'session', message: 'The session was not found', secret: 'LEAK' } }) })
  const f: any = await failing.channel.call('tree', { sessionId: 's' })
  check(f && f.ok === false && f.error.kind === 'session' && f.error.message === 'The deck read failed (session)', '读自己说的失败原因（kind）原样带回，话术换成读通道写死的一句')
  check(f && !('containers' in f) && !JSON.stringify(f).includes('LEAK') && !JSON.stringify(f).includes('not found'), '失败回包只重建 kind 与写死的话术，读自己的话术与多余字段都不夹带')
  const leaky = make({ tree: () => ({ ok: false, error: { kind: 'fetch-failed', message: 'ENOENT /Users/x/secret/repo' } }) })
  const lk: any = await leaky.channel.call('tree', { sessionId: 's' })
  check(lk && lk.ok === false && lk.error.kind === 'fetch-failed' && !JSON.stringify(lk).includes('/Users/x'), '读那一层把后端抛错折成的话术（可能带路径）不上送手机')
  const oddKind = make({ tree: () => ({ ok: false, error: { kind: '/Users/x/secret kind', message: 'm' } }) })
  const ok2: any = await oddKind.channel.call('tree', { sessionId: 's' })
  check(ok2 && ok2.ok === false && ok2.error.kind === 'read-failed' && !JSON.stringify(ok2).includes('/Users/x'), '读自己的 kind 不是短小写机器码时改叫 read-failed，不把路径当原因上送')

  const thrown = make({ ticket: () => { throw new Error('boom: /Users/x/secret') } })
  const t: any = await thrown.channel.call('ticket', { sessionId: 's', key: '1' })
  check(t && t.ok === false && t.error.kind === 'read-failed', '宿主方法抛错时折成 read-failed')
  check(t && !JSON.stringify(t).includes('/Users/x/secret'), '抛错的原文不上送给手机')

  const slow = make({ tree: () => new Promise(() => {}), timeoutMs: 40 })
  const s: any = await slow.channel.call('tree', { sessionId: 's' })
  check(s && s.ok === false && s.error.kind === 'timeout', '读超时折成 timeout，不无限等')

  const shapes: Array<[string, any]> = [
    ['undefined', undefined], ['null', null], ['字符串', 'ok'], ['数组', []], ['空对象', {}],
    ['ok 是字符串', { ok: 'true' }], ['ok 为 true 但没有容器', { ok: true, sessionId: 's' }], ['容器不是数组', { ok: true, sessionId: 's', containers: 'x' }],
    ['没有 sessionId', { ok: true, containers: [] }], ['sessionId 与请求不一致（读到了别的会话）', { ok: true, sessionId: 'other', containers: [] }],
  ]
  let treeBad = true
  const treeWrong: string[] = []
  for (const [name, reply] of shapes) {
    const m = make({ tree: () => reply })
    const r: any = await m.channel.call('tree', { sessionId: 's' })
    if (!(r && r.ok === false && r.error.kind === 'bad-reply')) { treeBad = false; treeWrong.push(name) }
  }
  check(treeBad, '树读回包不成形状的十种情况（含缺 sessionId 与读到别的会话）全部折成 bad-reply', treeWrong.join(' | '))
  let ticketBad = true
  for (const reply of [undefined, null, {}, { ok: true, sessionId: 's' }, { ok: true, sessionId: 's', ticket: 'x' }, { ok: true, sessionId: 's', ticket: null }, { ok: true, sessionId: 's', ticket: [] }, { ok: true, ticket: { key: '1' } }, { ok: true, sessionId: 'other', ticket: { key: '1' } }]) {
    const m = make({ ticket: () => reply })
    const r: any = await m.channel.call('ticket', { sessionId: 's', key: '1' })
    if (!(r && r.ok === false && r.error.kind === 'bad-reply')) ticketBad = false
  }
  check(ticketBad, '票读回包不成形状的九种情况（含缺 sessionId 与读到别的会话）全部折成 bad-reply')

  const giant = 'x'.repeat(DECK_READ_LIMITS.maxProjectionBytes + 1024)
  const bigTree = make({ tree: () => ({ ok: true, sessionId: 's', containers: [{ key: 'c', title: giant }] }) })
  const bt: any = await bigTree.channel.call('tree', { sessionId: 's' })
  check(bt && bt.ok === false && bt.error.kind === 'oversized' && !('containers' in bt), '树回包超过字节护栏时在读通道再挡一次，且不回半份')
  const bigTicket = make({ ticket: () => ({ ok: true, sessionId: 's', ticket: { key: '1', body: giant } }) })
  const bk: any = await bigTicket.channel.call('ticket', { sessionId: 's', key: '1' })
  check(bk && bk.ok === false && bk.error.kind === 'oversized' && !('ticket' in bk), '票回包超过字节护栏时在读通道再挡一次，且不回半份')
  const edge = make({ tree: () => ({ ok: true, sessionId: 's', workspaceRoot: '/w', backendId: 'github', containers: [], truncated: false, padding: 'p'.repeat(2000) }) })
  const eg: any = await edge.channel.call('tree', { sessionId: 's' })
  check(eg && eg.ok === true, '信封上的少量字段不会让正常回包被误伤')
  const bigEnvelope = make({ tree: () => ({ ok: true, sessionId: 's', workspaceRoot: '/w', backendId: 'github', containers: [], fallbackReason: giant }) })
  const be: any = await bigEnvelope.channel.call('tree', { sessionId: 's' })
  check(be && be.ok === false && be.error.kind === 'oversized', '信封上的字段把整个回包撑过字节护栏时同样失败（量整个回包，不只量正文那一格）')
}

// —— 八、日志：沿用既有事件，成功与失败各一行，不记原文 ——
{
  const { channel, logs } = make()
  await channel.call('tree', { sessionId: 'SECRET-SESSION-ID' })
  const ok = logs.filter((l) => l.event === 'host.call')
  check(ok.length === 1 && ok[0].level === 'info' && ok[0].fields.method === 'deck.panel.read' && ok[0].fields.ok === true && ok[0].fields.kind === 'deck-read' && typeof ok[0].fields.latencyMs === 'number', '成功记一行既有事件 host.call，method 固定、带耗时')
  const bad = make({ tree: () => ({ ok: false, error: { kind: 'session', message: 'nope SECRET-SESSION-ID' } }) })
  await bad.channel.call('tree', { sessionId: 'SECRET-SESSION-ID' })
  const fail = bad.logs.filter((l) => l.event === 'host.call.fail')
  check(fail.length === 1 && fail[0].level === 'warn' && fail[0].fields.method === 'deck.panel.read' && fail[0].fields.kind === 'deck-read' && typeof fail[0].fields.errorHash === 'string', '失败记一行既有事件 host.call.fail，原因只记散列')
  check(!JSON.stringify(logs).includes('SECRET-SESSION-ID') && !JSON.stringify(bad.logs).includes('SECRET-SESSION-ID'), '两条路径的日志里都没有 sessionId 原文')
}

// —— 九、日志口坏了不挡读 ——
{
  const channel = createDeckReadChannel({
    loadTree: async () => ({ handleTree: async () => ({ ok: true, sessionId: 's', containers: [] }) }),
    loadTicket: async () => ({ handleTicket: async () => ({ ok: true, sessionId: 's', ticket: { key: '1' } }) }),
    logCtx: { fire: () => { throw new Error('log down') } },
  })
  const r: any = await channel.call('tree', { sessionId: 's' })
  check(r && r.ok === true, '日志口抛错时读照旧成功')
}

printGateResult('verify-74-deck-read-channel', total, failed)
