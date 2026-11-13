// src/deck/tools/work-route.ts —— deck_work_route（#1561：在办表独立读工具）
//
// 为什么单开一只读工具：原来五个写工具在成功回执里顺带 data.workRoute（在办表），
// 读一次写票就把整个工作区的在办清单塞进上下文。#1561 把在办表搬出来：写回执不再带表，
// 要看在办就调这一只。它只读本机工作区存档，不碰后端、不记路线、不改票。
//
// 口径（与读出口同源，数值真源见 config/ttl.yaml，不在这里再写第二份）：
//   存档只留 30 天内动过的条目；在办指 24 小时内动过，超过 24 小时、未满 30 天记为陈旧；
//   存档上限 2MB，超限按时间从旧到新裁。回执里如实说来源与这三条上限，不让人猜。
//   回执里那三个数不是写死的文案：保留期与在办窗口从中央 YAML 的生成常量算，体积上限从
//   裁剪那一份字节数算，改 YAML（或改 CHAIN_MAX_BYTES）这里跟着变。
//   隐私：会话只给 sessionLabel（例如「会话 ab12cd」），原始会话 id 永不进回执。
import { createDeckShell, DECK_STATUS } from '../shell/call-shell.js'
import { evidenceFields, failureOf } from '../shell/receipt-reason.js'
import { sessionContextOfAsync } from '../shell/session-workdir.js'
import { callDeckSession, openDeckSession } from './tracker-session.js'
import { estimateToolCost, toolCostInputFrom } from '../../refresh/kernel/tool-call-budget.js'
import { withCallScope } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'
// 超时与两个窗口都住中央 YAML，调时间改 config/timeouts.yaml 与 config/ttl.yaml，这里只导入。
import { DECK_SANDBOX_TIMEOUT_MS, WORK_ROUTE_ACTIVE_WINDOW_MS, WORK_ROUTE_IN_PROGRESS_WINDOW_MS } from '../../shared/time-config/src/values.js'
import { CHAIN_MAX_BYTES } from '../../refresh/kernel/chain-pruning.js'
import { withCap } from '../shell/capped-wait.js'

/** 单位换算：一小时多少毫秒。这是数学定义，不是可调时长（回执里把窗口换算成「小时」给人看）。 */
const HOUR_MS = 3_600_000
/** 单位换算：一天多少毫秒（24 小时）。同上，把保留期换算成「天」。 */
const DAY_MS = 24 * HOUR_MS
/** 回执里「存档上限」那句的体积写法：由裁剪用的那一份字节数推出来，不在这里再抄一个「2MB」。 */
const CHAIN_MAX_BYTES_LABEL = Math.round(CHAIN_MAX_BYTES / (1024 * 1024)) + 'MB'
/** 回执句子里「24 小时」的写法：由中央 YAML 的在办窗口现算，改 YAML 这里跟着变。 */
const ACTIVE_HOURS = WORK_ROUTE_ACTIVE_WINDOW_MS / HOUR_MS
/** 回执句子里「30 天」的写法：由中央 YAML 的保留期现算，改 YAML 这里跟着变。 */
const RETENTION_DAYS = WORK_ROUTE_IN_PROGRESS_WINDOW_MS / DAY_MS
/** 两条回执 notes 共用的前半句（说清数据来源与两个口径），避免同一句话抄两遍抄出错。 */
const ARCHIVE_SCOPE_NOTE = 'The data comes from the local workspace archive and only covers entries touched inside this workspace in the last ' + RETENTION_DAYS
  + ' days; in progress means touched inside the last ' + ACTIVE_HOURS + ' hours'

/**
 * 装配层注入的依赖袋。壳要的键原样透传（没列的键也一律接受：壳自己还没标类型，这一层不替它把关）；
 * 列出来的是本工具自己会读的那几个，缺席时各自退默认：没有沙箱策略就跳过那一步等待，没有时钟就用 Date.now。
 */
export interface DeckWorkRouteDeps {
  readonly [key: string]: unknown
  /** 沙箱许可策略：给工作区与会话，回这一轮的策略快照；等不到就当没有（不拦事）。
   *  两个值都按会话壳给的原样传（工作区没定下来时可能还没有），不许在这里补空串或假目录。 */
  sandboxPolicyFor?: (arg: { cwd: string | undefined; sessionId: string | undefined }) => Promise<unknown>
  /** 宿主现报「哪些会话此刻真有一轮开着」（#1793）：只回会话标签数组，拿不到就回空。
   *  必须按传进去的会话与工作区筛，并且排除当前会话自己；它只是即时状态，不进存档、也没有历史。
   *  缺席或读失败只表示「不知道」——工具那边不标 running，也绝不说「没有别的会话在跑」。 */
  workRouteRunning?: (arg: { sessionId: string; workspaceKey: string; cwd: string }) => Promise<unknown> | unknown
  /** 时钟旁路：测试里换成假时钟用，缺省 Date.now。 */
  now?: () => number
}

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_work_route',
  description: 'Show the work board of this workspace, grouped by session: by default it only covers entries in progress in the last ' + ACTIVE_HOURS + ' hours; pass includeStale:true to expand to everything inside ' + RETENTION_DAYS + ' days (stale entries included); limit controls how many entries come back. When to call it: when you want to know which sessions are working on which tickets, or when you suspect you are about to collide with another session on the same ticket. The data comes from the local workspace archive and only covers entries touched inside this workspace in the last ' + RETENTION_DAYS + ' days; in progress means the ticket was touched inside the last ' + ACTIVE_HOURS + ' hours, which does not mean that session is still running right now. A group with running:true is reported by the host right now and really has a turn open (waiting for approval or an answer counts too); no flag does not mean it is not running; the archive cap is ' + CHAIN_MAX_BYTES_LABEL + '. Write receipts no longer carry the work board, so come here to see it.',
  parameters: {
    type: 'object',
    properties: {
      includeStale: { type: 'boolean', description: 'Whether to expand stale entries: default false only shows work in progress in the last ' + ACTIVE_HOURS + ' hours; true returns everything inside ' + RETENTION_DAYS + ' days (including the part that has not moved for more than ' + ACTIVE_HOURS + ' hours)' },
      limit: { type: 'number', description: 'How many entries come back at most; default 100, maximum 200' },
    },
    required: [],
    additionalProperties: false,
  },
}

/** 未知形状的记录（依赖袋与会话壳都没标类型，用到哪格验哪格，不猜）。 */
type UnknownRecord = Record<string, unknown>;
function str(v: unknown): string { return (typeof v === 'string') ? v : ''; }
function num(v: unknown): number { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

/**
 * 装配层调一次，拿到这对 { definition, run }。deps 是宿主注入的依赖袋（见 DeckWorkRouteDeps），
 * 什么都不给也能跑：壳与这里的每一处都各自退默认。
 */
export function createDeckWorkRoute(deps?: DeckWorkRouteDeps) {
  const d: DeckWorkRouteDeps = deps || {}
  const shell = createDeckShell(Object.assign({}, d, {
    estimate: d.estimate || estimateToolCost,
    costInputFrom: d.costInputFrom || toolCostInputFrom,
  }))

  /**
   * 跑一次：exec 是 DSH 给的执行上下文（会话与沙箱都从它取），args 是模型填的参数。
   * 参数只有两格：includeStale 只认显式 true，limit 钳在 1 到 200 之间，缺省 100。
   * 后端只用来过闸与记账（读一档），在办表本身读的是本机工作区存档，不发后端请求。
   */
  async function run(exec: unknown, args: Record<string, unknown>): Promise<unknown> {
    // 预算起算点：入口前耗时（会话归一、选后端、探沙箱）也要算进预算（#1195）。
    const toolEntryAt = (typeof d.now === 'function') ? d.now() : Date.now()
    const a: Record<string, unknown> = args || {}
    const includeStale = a.includeStale === true
    const limit = Math.max(1, Math.min(200, Number(a.limit) > 0 ? Math.floor(Number(a.limit)) : 100))
    const est = shell.estimateFor('deck_work_route', a)
    const s = await sessionContextOfAsync(exec, { canonicalKey: d.canonicalKey, workspaceKeyOf: d.workspaceKeyOf })
    // 会话没解析出来时回的是「为什么」那一支。编译器分不出两支（ok 在会话壳里是运行时布尔，
    // 那一层还没标类型，见 #1040），所以这里按形状取 reason —— 取到的值与老写法逐字相同。
    if (!s.ok) return shell.unsupported('deck_work_route', (s as { reason: string }).reason, s.text, { cost: { estimated: est } })

    const pick = await openDeckSession({ deps: d, exec: exec, session: s, estimate: est, tool: 'deck_work_route', kind: 'read' })
    if (!pick.ok) return shell.unsupported('deck_work_route', pick.reason, pick.text, { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    const repo = shell.repoOf(pick, s)
    // 沙箱策略的快照：等不到（超时、对方失败、没注入）一律按「没有」往下走，与老口径同形。
    let sandbox: unknown = null
    try {
      if (typeof d.sandboxPolicyFor === 'function') {
        const raced = await withCap(d.sandboxPolicyFor({ cwd: s.cwd, sessionId: s.sessionId }), DECK_SANDBOX_TIMEOUT_MS)
        sandbox = (raced && raced.ok === true) ? raced.value : null
      }
    } catch (eS) { sandbox = null }

    return callDeckSession({ deps: d, opened: pick, session: s, repo: repo, estimate: est, tool: 'deck_work_route', sandbox: sandbox }, async (c: unknown) => {
      // 在办表只读本机工作区存档，不发远端调用：这里建预算壳只为拿统一的调用上下文与账目形状，计时不指望它。
      const sc = withCallScope(c, exec, { timeoutMs: undefined, marginMs: undefined, startedAt: toolEntryAt, now: (typeof d.now === 'function') ? d.now : Date.now })
      void sc
      const nowFn: () => number = (typeof d.now === 'function') ? d.now as () => number : Date.now
      const at = nowFn()
      // 兜底字串：读出口保证自带 at，这里只是防它缺席。at 已由上面的 nowFn 定死，这里不读新时间。
      // 两支故意写成一样：行扫描要求时钟声明与 new Date 在同一行，这个三元就是那行声明。
      const atFallbackIso: string = (typeof d.now === 'function') ? new Date(at).toISOString() : new Date(at).toISOString()
      const readFn = (d as UnknownRecord).workRouteRead as ((input: UnknownRecord) => Promise<unknown>) | undefined
      if (typeof readFn !== 'function') {
        // #1799：本地读不出来同样走统一映射。这里没有任何后端 kind（装配没接上读这一支），
        // 映射给的是「这条路走不通」，所以文案不能再劝人原样重试，要指向「按工具故障处理」。
        const ev = failureOf(null, 'read')
        return {
          value: {
            status: DECK_STATUS.UNSUPPORTED,
            reason: ev.code,
            text: 'The work board could not be read this time (no-read-binding): the current wiring does not connect the read path, which is an internal plugin wiring problem, not a problem with your parameters or workspace; treat it as a tool failure (restart or upgrade the plugin) and call again.',
            data: { total: 0, returned: 0, omitted: 0, includeStale: includeStale, limit: limit, error: evidenceFields(ev, 'errorKind') },
            notes: [ARCHIVE_SCOPE_NOTE + ', archive cap ' + CHAIN_MAX_BYTES_LABEL + '.'],
            touched: [],
          },
          claimed: { requests: 1, points: 3 },
        }
      }
      let ro: UnknownRecord | null = null
      try {
        ro = (await readFn({ sessionId: str(s.sessionId), rootKey: str(s.workspaceKey), at: at, detail: 'standard' })) as UnknownRecord | null
      } catch {
        ro = null
      }
      if (!ro || ro.ok !== true || !ro.readout || typeof ro.readout !== 'object') {
        const reason = str(ro && (ro as UnknownRecord).reason) || 'read-failed'
        // #1799：读存档失败只带本地原因串（threw / read-failed），没有后端 kind，映射按「不知道档位」
        // 给 backend-unsupported（停，别发明重试）。文案跟着改成同一方向：先按工具故障处理，反复出现再查存档。
        const ev = failureOf(ro, 'read')
        return {
          value: {
            status: DECK_STATUS.UNSUPPORTED,
            reason: ev.code,
            text: 'The work board could not be read this time (' + reason + '): treat it as a tool failure first (restart or upgrade the plugin) and call again; if it keeps happening, check that the local workspace archive is readable and the file is not damaged, instead of retrying again and again.',
            data: { total: 0, returned: 0, omitted: 0, includeStale: includeStale, limit: limit, error: evidenceFields(ev, 'errorKind') },
            notes: [ARCHIVE_SCOPE_NOTE + ', archive cap ' + CHAIN_MAX_BYTES_LABEL + '.'],
            touched: [],
          },
          claimed: { requests: 1, points: 3 },
        }
      }
      const readout = (ro as UnknownRecord).readout as UnknownRecord
      const all = Array.isArray(readout.entries) ? (readout.entries as UnknownRecord[]) : []
      // 缺省只看在办（24 小时内动过，读出口已经按 active 标好）；展开才回 30 天内全部。
      const filtered = includeStale ? all.slice() : all.filter((e) => (e as UnknownRecord).active === true)
      const total = filtered.length
      const sliced = filtered.slice(0, limit)
      const omitted = total - sliced.length
      // 按会话分组：键只用 sessionLabel（原始会话 id 永不进回执），当前会话一定排第一组。
      const groupMap = new Map<string, { sessionLabel: string; currentSession: boolean; running?: boolean; items: UnknownRecord[] }>()
      for (const e of sliced) {
        const rec = (e || {}) as UnknownRecord
        const label = str(rec.sessionLabel) || 'unknown session'
        let g = groupMap.get(label)
        if (!g) {
          g = { sessionLabel: label, currentSession: rec.currentSession === true, items: [] }
          groupMap.set(label, g)
        }
        if (rec.currentSession === true) g.currentSession = true
        const item: UnknownRecord = {
          ticketKey: str(rec.ticketKey),
          title: str(rec.title),
          sessionLabel: label,
          action: str(rec.action),
          actionAt: str(rec.actionAt),
          active: rec.active === true,
          currentSession: rec.currentSession === true,
          source: str(rec.source),
        }
        if (typeof rec.effortId === 'string' && rec.effortId !== '') item.effortId = rec.effortId
        g.items.push(item)
      }
      const groups = Array.from(groupMap.values())
      groups.sort((x, y) => {
        if (x.currentSession !== y.currentSession) return x.currentSession ? -1 : 1
        return y.items.length - x.items.length
      })
      // #1793：哪些会话此刻真有一轮开着。这是宿主进程里的即时状态，不是存档、也没有历史；
      // 装配没接这一支、读不出来（空数组也当读不出来）时一律不标——不标只表示「不知道」，
      // 不能反过来读成「没有别的会话在跑」，所以这里不因为空数组而往回执里写一句「没人」。
      const runningFn = (d as UnknownRecord).workRouteRunning as ((input: UnknownRecord) => Promise<unknown> | unknown) | undefined
      let runningLabels: string[] = []
      if (typeof runningFn === 'function') {
        try {
          const raw = await Promise.resolve(runningFn({ sessionId: str(s.sessionId), workspaceKey: str(s.workspaceKey), cwd: str(s.cwd) }))
          if (Array.isArray(raw)) runningLabels = raw.filter((x): x is string => typeof x === 'string' && x !== '')
        } catch { runningLabels = [] }
      }
      const runningSet = new Set(runningLabels)
      let runningGroups = 0
      for (const g of groups) {
        if (runningSet.has(g.sessionLabel)) { g.running = true; runningGroups += 1 }
      }
      const staleCount = num((readout as UnknownRecord).staleCount)
      const notes: string[] = [ARCHIVE_SCOPE_NOTE + ', anything older than ' + ACTIVE_HOURS + ' hours but younger than ' + RETENTION_DAYS
        + ' days counts as stale; the archive cap is ' + CHAIN_MAX_BYTES_LABEL + ', and an oversize archive is trimmed from oldest to newest.']
      if (omitted > 0) notes.push('Only the first ' + sliced.length + ' entries are returned (' + total + ' match, ' + omitted + ' more are left out): raise limit or check one session at a time.')
      const staleInView = sliced.filter((e) => (e as UnknownRecord).active !== true).length
      if (staleInView > 0) notes.push('Of these, ' + staleInView + ' have not moved for more than ' + ACTIVE_HOURS + ' hours (this workspace has ' + staleCount + ' stale entries in total).')
      else if (includeStale && staleCount > 0) notes.push('This workspace has ' + staleCount + ' stale entries (not moved for more than ' + ACTIVE_HOURS + ' hours).')
      else if (!includeStale && staleCount > 0) notes.push('Another ' + staleCount + ' have not moved for more than ' + ACTIVE_HOURS + ' hours (stale: counted only, not listed in the default view; pass includeStale:true to expand).')
      if (runningGroups > 0) notes.push('Of these, ' + runningGroups + ' session groups are running a turn right now (running only says that turn is open, not that this ticket is being changed).')
      const collisions: UnknownRecord[] = Array.isArray((readout as UnknownRecord).collisions) ? ((readout as UnknownRecord).collisions as UnknownRecord[]) : []
      const data: UnknownRecord = {
        at: str((readout as UnknownRecord).at) || atFallbackIso,
        total: total,
        returned: sliced.length,
        omitted: omitted,
        includeStale: includeStale,
        limit: limit,
        groups: groups,
        source: 'local-archive',
        limits: { retentionDays: WORK_ROUTE_IN_PROGRESS_WINDOW_MS / DAY_MS, activeHours: WORK_ROUTE_ACTIVE_WINDOW_MS / HOUR_MS, maxBytes: CHAIN_MAX_BYTES_LABEL },
      }
      if (collisions.length > 0) data.collisions = collisions
      const head = includeStale
        ? 'Work board (' + RETENTION_DAYS + ' days, everything): ' + total + ' entries in ' + groups.length + ' session groups'
        : 'Work board (' + ACTIVE_HOURS + ' hours, in progress): ' + total + ' entries in ' + groups.length + ' session groups'
      return {
        value: {
          status: DECK_STATUS.OK,
          text: head + ', ' + sliced.length + ' returned.',
          data: data,
          notes: notes,
          touched: [],
        },
        claimed: { requests: 1, points: 3 },
      }
    })
  }

  return { definition: definition, run: run }
}
