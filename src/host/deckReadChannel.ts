/**
 * src/host/deckReadChannel.ts —— 把「树读」与「票读」两个宿主方法暴露给远程宿主的读通道服务（#74，规格 #70）。
 *
 * 一句话说清它做什么：DSH Remote 这类远程宿主插件要替手机读 deck 时，只能通过本文件发布的一个服务
 * （deckPanelRead）调用，且只能调 `tree` 与 `ticket` 两个操作；它还告诉对方「deck.panel.read.v1 这个功能现在
 * 是不是真的可用」。其它任何东西（写、评论、别的宿主方法、别的读）这里一概没有。
 *
 * 为什么发布一个服务，而不是再开一条 HTTP 路由或让对方直接转发 /api/dsws（维护者在本票上选的）：
 * /api/dsws 背后挂着一百多个宿主方法，其中有写；让对方「只转发其中两个」等于把「只有两个操作」的承诺押在
 * 对方的白名单上。服务口只有两个操作，承诺由 deck 自己守，且不新增任何网络入口。
 *
 * 六条不能改的约定：
 * 1. 只有两个操作：操作名按「整串逐字等于」认（不去空白、不忽略大小写、不信原型链上的名字），认不出的
 *    一律 operation-not-allowed，且一条读都不发。
 * 2. 请求形状收得很紧：参数必须是对象，只许带这个操作约定的键（树读只有 sessionId，票读是 sessionId 加 key），
 *    多一个键就拒 —— 尤其不许带 cwd / path 这类自由路径：工作区只由宿主按 sessionId 解析（规格 #70）。
 *    交给宿主方法的是重新拼出来的新对象，不是调用方那个对象本身。
 * 3. 失败一律拒绝放行、不编数据：读失败、读抛错、读超时、回包不成形状、回包过大都折成 ok:false 加一个机器可读
 *    kind。失败话术是本文件按 kind 写死的一句，读自己的失败话术与抛错原文都不上送：读那一层把后端抛错折成话术时
 *    会带上错误原文（里面可能有路径与仓库名），手机不需要它，宿主日志里只留散列。
 * 4. 「可用」要两个读都在且都加载得起来：缺一个就整个功能不可用，连另一个读也拒（不放行半个通道），
 *    因为手机面板是按「树 + 票」一起设计的，只有半边会得到一个读不全的面板。探测是按需的：每次问现取现算，
 *    不缓存、不起定时器。「可用」只证明两个读能被加载，不证明后端此刻连得上 —— 后端连不上是某一次读的失败。
 * 5. 一次调用只有一个期限：加载与读合起来共用同一个等待上限，不叠加；回包的 sessionId 必须与请求一致
 *    （读错工作区比读失败更糟）；整个回包（不只树或票那一格）再过一遍字节护栏，数字与量法都复用宿主方法
 *    那一套（契约层的 DECK_READ_LIMITS 与 deckReadSession 的 oversizedFailureOf）。宿主方法自己已经挡过一次，
 *    这里再挡一次是为了它将来改坏时读通道仍然拒绝放行。
 * 6. 发布晚于启动：服务是在宿主入口动态加载本文件之后才发布的，所以远程宿主必须按「可选注入、服务出现时再响应」
 *    的方式取它，不能假定启动那一刻就在。
 *
 * 日志：沿用既有事件 host.call / host.call.fail，method 固定 deck.panel.read，kind 固定 deck-read，
 * 不新增事件名；原因只记散列，sessionId、票号、路径、错误原文一律不记。
 */

import { STEP_WAIT_MS } from '../shared/time-config/src/values.js'
import { DECK_READ_LIMITS } from '../tracker/contract/deck-read.js'
import { validDeckStandaloneIssues, validDeckTicketActions } from '../shared/deck-read-reply.js'
import { oversizedFailureOf } from './deckReadSession.js'

/** 协商时对外报的功能名；远程宿主以它决定要不要给手机亮出面板。 */
export const DECK_READ_FEATURE = 'deck.panel.read.v1'
/** 服务在宿主上下文里的名字：远程宿主插件按这个名字注入。 */
export const DECK_READ_SERVICE = 'deckPanelRead'

/**
 * 读通道自己会回的失败原因。写成联合类型，是为了让编译器把代码与 ADR 里列的那张清单连在一起：
 * 新增或改名一个原因，调用它的每一处都会报错。读自己的 kind（session、not-found、parse 等）另算，原样带出去。
 */
type ChannelFailKind = 'operation-not-allowed' | 'bad-request' | 'unavailable' | 'timeout' | 'read-failed' | 'bad-reply' | 'oversized'

/**
 * 两个操作各自的约定，放在一张表里：每个操作允许哪些参数键、成功回包里哪一格是正文、给人看的名字。
 * 为什么一张表：这三样原来散在校验、回包检查、调用三处各判一次 tree / ticket，加第三个操作要改三处；
 * 现在加操作只改这里（本通道按规格只有两个操作，加第三个本身要先改规格）。
 */
const OPERATION_SPECS = Object.freeze({
  tree: Object.freeze({ keys: Object.freeze(['sessionId']), payload: 'containers', label: 'deck tree', needsArray: true }),
  ticket: Object.freeze({ keys: Object.freeze(['sessionId', 'key']), payload: 'ticket', label: 'deck ticket', needsArray: false }),
})
type Operation = keyof typeof OPERATION_SPECS

/** 窄口只认的两个操作名（顺序固定：树在前，票在后）。 */
const OPERATIONS: readonly Operation[] = Object.freeze(['tree', 'ticket'] as Operation[])

/** sessionId 最长多少个字符：这是本通道自己定的护栏（真会话号远短于它），不是某个外部系统的上限。 */
const MAX_SESSION_ID_CHARS = 512
/** 票号最长多少个字符：Linear 的 OMB-923、GitHub 的 74 都远低于它，更长的只会是误用。 */
const MAX_TICKET_KEY_CHARS = 200
/** 读自己的失败原因能原样带出去的形状：短的小写机器码；别的形状一律改叫 read-failed。 */
const SAFE_KIND = /^[a-z0-9][a-z0-9-]{0,39}$/

/** 读通道回给调用方的失败：kind 是机器可读原因，message 是本文件按 kind 写死的一句话。 */
export type DeckReadChannelFailure = { ok: false; error: { kind: string; message: string } }
/** 可用性探测的答案：不可用时 reason 是机器可读短码（不含路径或错误原文）。 */
export type DeckReadAvailability = { available: true } | { available: false; reason: string }

/** 读通道对外的形状：整个对象冻结，别的插件拿到手也改不了它。 */
export interface DeckReadChannel {
  readonly feature: typeof DECK_READ_FEATURE
  readonly operations: readonly Operation[]
  available(): Promise<DeckReadAvailability>
  call(operation: unknown, params: unknown): Promise<any>
}

/** 日志口：只用 fire，坏了也不许影响读。 */
type LogCtx = { fire(level: string, event: string, fields: Record<string, unknown>): void } | null | undefined
/** 宿主计时器口（只要 timeout）：没有时退回页面自己的 setTimeout。 */
type TimerPort = { timeout(fn: () => void, ms: number): unknown } | null | undefined

/** 读通道的依赖：两个宿主方法都以「懒加载」形式递进来（装配点不许静态引用，见 src/host/index.ts）。 */
export type DeckReadChannelDeps = {
  /** 取树读：回 { handleTree }；加载失败应抛错或回没有 handleTree 的东西。 */
  loadTree: () => Promise<{ handleTree?: unknown } | null | undefined>
  /** 取票读：回 { handleTicket }。 */
  loadTicket: () => Promise<{ handleTicket?: unknown } | null | undefined>
  logCtx?: LogCtx
  timer?: TimerPort
  /** 一次调用（含加载）最多等多久；缺省取全仓统一的「一步等待」STEP_WAIT_MS，不在这里另写一个数。 */
  timeoutMs?: number
}

/** 把原因收成 8 位散列：日志里只留指纹，不留原文。 */
function hash8(text: unknown): string {
  // 操作名来自远程那一头，什么形状都可能有（例如没有原型的对象，String() 会抛）：量不出来就记全零，拒绝的路上不许再抛。
  try {
    let h = 5381
    const t = String(text === null || text === undefined ? '' : text)
    for (let i = 0; i < t.length; i++) h = (((h << 5) + h + t.charCodeAt(i)) >>> 0)
    return ('0000000' + h.toString(16)).slice(-8)
  } catch (e) {
    return '00000000'
  }
}

/** 超时哨兵：与任何宿主方法的真回包都不会撞。 */
const TIMED_OUT = Symbol('deck-read-timed-out')

/**
 * 在期限内等一件事：先到的是它就交它的结果，先到的是期限就交 TIMED_OUT（并不去打断那件事本身 ——
 * 后端读不能被强行取消，只是这次不再等它）。
 *
 * 为什么按形状撤销计时：宿主计时器交回的句柄是函数，页面自己的 setTimeout 交回数字/对象，
 * 拿全局 clearTimeout 撤宿主句柄是静默无效（见 tests/verify-1115-timer-handle.ts）。读完了必须把这笔等待撤掉，
 * 否则每次成功的读都会在宿主上留一笔 30 秒后才触发的空等待。
 */
async function within<T>(work: Promise<T>, ms: number, timer: TimerPort): Promise<T | typeof TIMED_OUT> {
  let handle: unknown
  let timed = false
  const giveUp = new Promise<typeof TIMED_OUT>((resolve) => {
    const fire = () => { timed = true; resolve(TIMED_OUT) }
    try {
      if (timer && typeof timer.timeout === 'function') { handle = timer.timeout(fire, ms); return }
    } catch (e) { /* 宿主计时器起不来就退回下面那一档 */ }
    // 退回档不 unref：有人正在等这一笔，让它按时触发才是它存在的意义；读完时下面的 finally 会把它撤掉。
    handle = setTimeout(fire, ms)
  })
  try {
    return await Promise.race([work, giveUp])
  } finally {
    if (!timed) {
      try {
        if (typeof handle === 'function') (handle as () => void)()
        else if (handle !== undefined && handle !== null) clearTimeout(handle as any)
      } catch (e) { /* 撤不掉只是多一笔空等待，不影响这次的结果 */ }
    }
  }
}

function hasOwn(rec: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key)
}

/** 校验并拼出交给宿主方法的参数；形状不对回 null，由调用方折成 bad-request。 */
function argsFor(operation: Operation, params: unknown): { sessionId: string; key?: string | number } | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const rec = params as Record<string, unknown>
  const allowed = OPERATION_SPECS[operation].keys
  if (!Object.keys(rec).every((k) => allowed.indexOf(k) >= 0)) return null
  if (!hasOwn(rec, 'sessionId')) return null
  const sid = rec.sessionId
  if (typeof sid !== 'string' || sid.trim() === '' || sid.length > MAX_SESSION_ID_CHARS) return null
  if (operation === 'tree') return { sessionId: sid }
  if (!hasOwn(rec, 'key')) return null
  const key = rec.key
  if (typeof key === 'string') {
    if (key.trim() === '' || key.length > MAX_TICKET_KEY_CHARS) return null
    return { sessionId: sid, key }
  }
  // 数字票号也收：GitHub 与 GitLab 的票号天然是整数，手机那头不必先转成字符串；0、负数、小数、超出安全整数范围的都不是票号。
  if (typeof key === 'number' && Number.isSafeInteger(key) && key > 0) return { sessionId: sid, key }
  return null
}

/**
 * 把宿主方法的回包收成读通道的回包。回 null 表示「回包不成形状」，由调用方折成 bad-reply。
 * 失败回包只留 kind 并换成写死的话术；成功回包要过三道检查（形状、sessionId 与请求一致、整个回包的字节）后才原样交出。
 */
function replyFor(operation: Operation, requestSessionId: string, reply: unknown): any | null {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null
  const rec = reply as Record<string, any>
  if (rec.ok === false) {
    const raw = rec.error && typeof rec.error === 'object' ? rec.error.kind : ''
    const kind = typeof raw === 'string' && SAFE_KIND.test(raw) ? raw : 'read-failed'
    return { ok: false, error: { kind, message: 'The deck read failed (' + kind + ')' } }
  }
  if (rec.ok !== true) return null
  const spec = OPERATION_SPECS[operation]
  const payload = rec[spec.payload]
  if (spec.needsArray ? !Array.isArray(payload) : (payload === null || typeof payload !== 'object' || Array.isArray(payload))) return null
  if (operation === 'tree' && !validDeckStandaloneIssues(rec, payload, DECK_READ_LIMITS)) return null
  if (operation === 'ticket' && !validDeckTicketActions(payload, DECK_READ_LIMITS)) return null
  // 回包必须说明它读的是哪次会话，且就是请求的那一次：宿主方法回的是 trim 之后的 sessionId，所以按 trim 比。
  if (typeof rec.sessionId !== 'string' || rec.sessionId !== requestSessionId.trim()) return null
  // 量整个回包而不只是正文那一格：信封上的 workspaceRoot、fallbackReason 等也是会过通道的字节。
  return oversizedFailureOf(rec, spec.label) || rec
}

/** 造读通道。依赖全部显式传入；本函数不读任何闭包外的东西，也不起定时器。 */
export function createDeckReadChannel(deps: DeckReadChannelDeps): DeckReadChannel {
  const logCtx = deps.logCtx || null
  const timer = deps.timer || null
  const budgetMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0 ? deps.timeoutMs : STEP_WAIT_MS

  function fireOk(ms: number): void {
    try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('info', 'host.call', { method: 'deck.panel.read', latencyMs: ms, ok: true, kind: 'deck-read' }) } catch (e) { /* 日志坏了不挡读 */ }
  }
  function fireFail(reason: string): void {
    try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('warn', 'host.call.fail', { method: 'deck.panel.read', kind: 'deck-read', errorHash: hash8(reason) }) } catch (e) { /* 日志坏了不挡读 */ }
  }
  /** 折一次读通道自己的失败：记一行日志，再回写死话术的失败。reason 进散列，不进回包。 */
  function fail(kind: ChannelFailKind, message: string, reason: string): DeckReadChannelFailure {
    fireFail(reason)
    return { ok: false, error: { kind, message } }
  }

  /** 取两个读；两个都拿到才算「在」。原因是机器可读短码，不含路径与错误原文。 */
  async function resolveReads(): Promise<{ ok: true; tree: (a: any) => Promise<any>; ticket: (a: any) => Promise<any> } | { ok: false; reason: string }> {
    let loaded: any
    try {
      loaded = await Promise.all([deps.loadTree(), deps.loadTicket()])
    } catch (e) {
      return { ok: false, reason: 'load-failed' }
    }
    const treeMod: any = loaded[0]
    const ticketMod: any = loaded[1]
    if (!treeMod || typeof treeMod.handleTree !== 'function') return { ok: false, reason: 'tree-read-missing' }
    if (!ticketMod || typeof ticketMod.handleTicket !== 'function') return { ok: false, reason: 'ticket-read-missing' }
    return { ok: true, tree: (a: any) => treeMod.handleTree(a), ticket: (a: any) => ticketMod.handleTicket(a) }
  }

  async function available(): Promise<DeckReadAvailability> {
    const reads = await within(resolveReads(), budgetMs, timer)
    if (reads === TIMED_OUT) return { available: false, reason: 'load-timeout' }
    return reads.ok ? { available: true } : { available: false, reason: reads.reason }
  }

  /** 一次读的全程（加载 + 读 + 回包检查）：整段共用一个期限，由调用方包 within。 */
  async function run(operation: Operation, args: { sessionId: string; key?: string | number }): Promise<any> {
    const reads = await resolveReads()
    if (!reads.ok) return fail('unavailable', 'The deck read channel is not available on this host', 'unavailable:' + reads.reason)
    let settled: any
    try {
      settled = await (operation === 'tree' ? reads.tree : reads.ticket)(args)
    } catch (e) {
      // 抛错原文不上送也不进日志（可能含路径），只记原因散列。
      return fail('read-failed', 'The deck read failed', 'threw:' + hash8((e && (e as any).message) || e))
    }
    const out = replyFor(operation, args.sessionId, settled)
    if (out === null) return fail('bad-reply', 'The deck read returned a reply that could not be understood', 'bad-reply:' + operation)
    if (out.ok === false) fireFail('failed:' + operation + ':' + out.error.kind)
    return out
  }

  async function call(operation: unknown, params: unknown): Promise<any> {
    const t0 = Date.now()
    if (operation !== 'tree' && operation !== 'ticket') {
      return fail('operation-not-allowed', 'Only the deck tree read and the deck ticket read are available over this channel', 'operation-not-allowed:' + hash8(operation))
    }
    const args = argsFor(operation, params)
    if (!args) return fail('bad-request', 'The request does not have the shape this read takes', 'bad-request:' + operation)

    const out = await within(run(operation, args), budgetMs, timer)
    if (out === TIMED_OUT) return fail('timeout', 'The deck read did not finish in time', 'timeout:' + operation)
    if (out && out.ok === true) fireOk(Date.now() - t0)
    return out
  }

  return Object.freeze({
    feature: DECK_READ_FEATURE,
    operations: OPERATIONS,
    available,
    call,
  }) as DeckReadChannel
}

/** 宿主上下文里发布服务要用的那一小块：provide 缺席时回 false，不抛。 */
type ProvideCtx = { provide?: (name: string, value: unknown) => unknown }

/**
 * 把读通道发布成宿主上下文里的服务 deckPanelRead。
 *
 * 写法依据：已装的 ds-harness-remote 与 dsh-gitea 都用同一个两参数写法 `ctx.provide(name, value)` 发布不是服务类的值，
 * 且都先判 `typeof ctx.provide === 'function'`；这里照同一个口径。
 * 为什么不抛：发布失败只是「远程宿主看不到这个功能」，deck 自己的面板与工具一概不受影响，
 * 所以失败只记日志（method 为 deck.panel.read.provide）并回 false，绝不能拖垮启动。
 * 只加不改：本函数不动 deck 已有的任何注册（面板、工具、宿主方法）。
 */
export function provideDeckReadChannel(ctx: ProvideCtx | null | undefined, channel: DeckReadChannel, logCtx?: LogCtx): boolean {
  const t0 = Date.now()
  try {
    if (!ctx || typeof ctx.provide !== 'function') throw new Error('provide-missing')
    ctx.provide(DECK_READ_SERVICE, channel)
    try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('info', 'host.call', { method: 'deck.panel.read.provide', latencyMs: Date.now() - t0, ok: true, kind: 'deck-read' }) } catch (e) { /* 日志坏了不挡发布 */ }
    return true
  } catch (e) {
    try { if (logCtx && typeof logCtx.fire === 'function') logCtx.fire('warn', 'host.call.fail', { method: 'deck.panel.read.provide', kind: 'deck-read', errorHash: hash8((e && (e as any).message) || e) }) } catch (e2) { /* 日志坏了不挡发布 */ }
    return false
  }
}

export default { createDeckReadChannel, provideDeckReadChannel, DECK_READ_FEATURE, DECK_READ_SERVICE }
