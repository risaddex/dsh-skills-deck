// src/deck/tools/map-snapshot.ts —— deck_map_snapshot（#713 第六批；#1019 换到新树、#1035 转 TypeScript）
//
// 一张地图的全部子票 + 进度统计 + 五区块。进度统计不在这里自己数：它调共享层的 deriveDeck
// （src/tracker/deck-derive.ts，界面与快照用的是同一份投影），这样工具报的数字与面板上看到的
// 是同一套口径，不会出现「工具说 3 张未关闭、面板说 2 张」。
// 五区块（Destination / Notes / Decisions so far / Not yet specified / Out of scope）用共享层的
// parseMapBody 解析，同样是单源。
import { createDeckShell, DECK_STATUS, REFUSAL_REASONS } from '../shell/call-shell.js'
import { evidenceFields, failureOf } from '../shell/receipt-reason.js'
import { MD_SCOPE_LOCATE, applyMdScope, mdScopeNote } from './md-scope.js'
import { sessionContextOfAsync } from '../shell/session-workdir.js'
import { callDeckSession, openDeckSession } from './tracker-session.js'
import { childrenOf } from '../shell/edge-landing.js'
import { deriveDeck, parseProgress } from '../../tracker/deck-derive.js'
import { parseMapBody, parseOriginalWords, parseProgressDetail } from '../../tracker/body-parse.js'
import { estimateToolCost, toolCostInputFrom } from '../../refresh/kernel/tool-call-budget.js'
import { readCallTimeoutOf, withCallScope } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'
// 超时住中央 YAML，调时间改 config/timeouts.yaml。
import { DECK_SANDBOX_TIMEOUT_MS } from '../../shared/time-config/src/values.js'
import { withCap } from '../shell/capped-wait.js'

/** 失败回执里的「下一步做什么」：reason 已经回答了下一步，text 要跟它指向同一件事。
 *  只给本工具判断得了的几种码补一句；其余（后端说做不到等）保持原话，不替后端发明退路。 */
function nextStepText(reason: string): string {
  if (reason === REFUSAL_REASONS.BAD_ARGS) return 'The ticket number may be wrong: check with deck_issue_list or deck_issue_get that this map ticket exists, then read again.'
  if (reason === REFUSAL_REASONS.BACKEND_TIMEOUT) return 'Call again in a moment.'
  if (reason === REFUSAL_REASONS.BACKEND_THREW) return 'Reading has no side effects, so the same call can be made again.'
  if (reason === REFUSAL_REASONS.OVER_CAP) return 'Call again shortly.'
  if (reason === REFUSAL_REASONS.BACKEND_UNSUPPORTED) return 'This path does not work right now; treat it as a tool failure or switch to another backend and try again.'
  return 'Call again and look at the numbers.'
}

/** 数字型参数的统一收口：正的有限数才要（取整），其余一律当「没给」，由调用方退自己的默认。 */
function numOpt(v: unknown): number | undefined { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : undefined }
// 沙箱许可等待上限见 ../shell/capped-wait.ts（#1114 第二批）：到点就按「没等到」处理并清掉等待定时器；
// 超时按缺席走老路（不限权），与既有 catch null 同形。

/**
 * 装配层注入的依赖袋。壳要用的键原样透传（没列的键也一律接受：壳自己还没标类型，这一层不替它把关）；
 * 列出来的是本工具自己会读的那几个，缺席时各自退默认：没有沙箱策略就跳过那一步等待，没有时钟就用 Date.now。
 */
export interface DeckMapSnapshotDeps {
  readonly [key: string]: unknown
  /** 沙箱许可策略：给工作区与会话，回这一轮的策略快照；等不到就当没有（不拦事）。两个值原样传，可能还没有。 */
  sandboxPolicyFor?: (arg: { cwd: string | undefined; sessionId: string | undefined }) => Promise<unknown>
  /** 读调用整趟的总时限（毫秒）：缺省退 toolTimeoutMs，再退中央键。
   *  #1831：地图快照是读，必须比宿主 run_code 的 120 秒先收手，不能等满 5 分钟。 */
  readTimeoutMs?: number
  /** 时钟旁路：测试里换假时钟用，缺省 Date.now。 */
  now?: () => number
}

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_map_snapshot',
  description: 'The ISSUE and map management of the dsh-skills-deck plugin; it only handles the repo of the current workspace. Before touching an ISSUE, call deck_context to confirm the workspace and backend, and stop if it says there is no backend. Look at all child ISSUEs of a map, the progress stats and the five sections, to judge how far the map has got. detail=thin keeps thin rows so the list is not cut off (see the detail parameter).',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The ticket number of the map ticket' },
      frontierOnly: { type: 'boolean', description: 'Only return sub-issues that can be picked up (not closed, not assigned, blockers satisfied); by default all are returned' },
      detail: { type: 'string', enum: ['full', 'thin'], description: 'How detailed the sub-issue rows are. Default full: each row carries the progress from the body (a large response, cut off when there are many tickets). thin: only the key, title, state, labels, assignees and blockers (a small response, the list is not cut off; the stats and the progress table are computed exactly the same; for a body, read each ticket with deck_issue_get).' },
      ...MD_SCOPE_LOCATE,
    },
    required: ['key'],
    additionalProperties: false,
  },
}

/**
 * 一行子票的状态两格（#1790 缺陷 A 的 P4）：本地 Markdown 房返回的 Issue 已经算好 status 与 statusConflict。
 * status 有才给；statusConflict 是布尔、总是给（没有冲突就是 false）。与 deck_issue_list 的行字段同一口径。
 */
function statusRowFields(issue: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof issue.status === 'string' && issue.status !== '') out.status = issue.status
  out.statusConflict = !!issue.statusConflict
  return out
}
/**
 * 从后端回来的认领人清单里挑出名字：字符串直接用，对象取 login，两种混着来也认。
 * 取不到名字的记空串、最后去空：本地 Markdown 票面写着可见 Status: claimed、却没写认领人时，
 * 解析层会补一个 {login:''} 的占位对象，意思是「已认领、这份文件没记下是谁」，不是「未认领」；
 * 快照的两档行都按「没有名字可显示」处理，而不是把对象插值成 [object Object]（#1800）。
 * 与 issue-list.ts 里的 assigneeNames 同一口径；那一份是模块内私有，这里照写法各留一份，不跨工具文件 import。
 * full 与 thin 两档共用这一份，免得两处口径漂开。
 */
function assigneeNames(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.map((a) => {
    if (typeof a === 'string') return a
    if (a && typeof a === 'object') {
      const v = (a && a.login) || ''
      return String(v)
    }
    return ''
  }).map((s) => s.trim()).filter(Boolean)
}

/** 一行子票（full 档）。行的形状是后端回来的运行时真值（契约层没建模），按开放表收口。 */
function childRow(issue: Record<string, unknown>) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => (l && l.name) || String(l)) : []
  const assignees = assigneeNames(issue.assignees)
  const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy.map((r) => (r && r.key) || String(r)) : []
  // 进度直接从正文算（与汇总用的同一个函数，结果一致）：汇总那张表按池内身份存键，
  // 行里拿裸票号去查恒查不到，之前有子票的地图就整包被外层拒收（只读空地图能过）。
  // #1090：数字（progress）保留给面板与既有读法；另给 progressDetail 结构化那一条，
  // 里面含记录时间与说明，与 deck_issue_get 读回来的是同一份。
  return {
    key: issue.key, title: issue.title, state: issue.state, labels: labels, assignees: assignees, blockedBy: blockedBy,
    updatedAt: issue.updatedAt || '', progress: parseProgress(issue.body),
    progressDetail: parseProgressDetail(issue.body),
    // #1092：full 行也带上「维护者原话」的结构化读回，与 deck_issue_get 是同一份（同一函数、逐字）。
    // thin 行故意不加：薄行是「票多时只要清单」那一档，要原话的人应当逐张读 deck_issue_get。
    originalWords: parseOriginalWords(issue.body),
    // #1790 缺陷 A 的 P4：状态两格追加在行末，原有字段的顺序与含义一个都不动。
    ...statusRowFields(issue),
  }
}

// 薄行：只要画清单用得上的格，不要正文与进度（回包小、票多时不断；统计与进度表另有去处）。
function thinRow(issue: Record<string, unknown>) {
  const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => (l && l.name) || String(l)) : []
  const assignees = assigneeNames(issue.assignees)
  const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy.map((r) => (r && r.key) || String(r)) : []
  return { key: issue.key, title: issue.title, state: issue.state, labels: labels, assignees: assignees, blockedBy: blockedBy, updatedAt: issue.updatedAt || '', ...statusRowFields(issue) }
}

/**
 * 装配层调一次，拿到这对 { definition, run }。deps 是宿主注入的依赖袋（见 DeckMapSnapshotDeps），
 * 什么都不给也能跑：壳与这里的每一处都各自退默认。
 */
export function createDeckMapSnapshot(deps?: DeckMapSnapshotDeps) {
  const d: DeckMapSnapshotDeps = deps || {}
  const shell = createDeckShell(Object.assign({}, d, {
    estimate: d.estimate || estimateToolCost,
    costInputFrom: d.costInputFrom || toolCostInputFrom,
  }))

  /**
   * 跑一次：exec 是 DSH 给的执行上下文（会话与沙箱都从它取），args 是模型填的参数。
   * 参数先当「未知」再逐项收口（key / effort / feature / frontierOnly / detail 各收一次），回执形状由壳统一渲染。
   * exec 上只声明本文件真正会读的那个字段（取消信号），其余字段一律不碰、照旧整只交给壳，
   * 所以下面取 signal 的地方不必写一串断言。
   */
  async function run(exec: { signal?: unknown } | null | undefined, args: Record<string, unknown>): Promise<unknown> {
    // 预算起算点：入口前耗时（会话归一、选后端、探沙箱）也要算进预算（#1195）。
    const toolEntryAt = (typeof d.now === 'function') ? d.now() : Date.now()
    const a: Record<string, unknown> = args || {}
    const key = String(a.key === undefined || a.key === null ? '' : a.key).trim()
    const est = shell.estimateFor('deck_map_snapshot', a)
    const s = await sessionContextOfAsync(exec, { canonicalKey: d.canonicalKey, workspaceKeyOf: d.workspaceKeyOf })
    // 会话没解析出来时回的是「为什么」那一支。编译器分不出两支（ok 在会话壳里是运行时布尔，
    // 那一层还没标类型，见 #1040），所以这里按形状取 reason —— 取到的值与老写法逐字相同。
    if (!s.ok) return shell.unsupported('deck_map_snapshot', (s as { reason: string }).reason, s.text, { cost: { estimated: est } })
    if (!key) return shell.unsupported('deck_map_snapshot', REFUSAL_REASONS.BAD_ARGS, 'Which map to look at: put the ticket number of the map ticket in key.', { cost: { estimated: est } })

    const pick = await openDeckSession({ deps: d, exec: exec, session: s, estimate: est, tool: 'deck_map_snapshot', kind: 'read' })
    if (!pick.ok) return shell.unsupported('deck_map_snapshot', pick.reason, pick.text, { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    const repo = shell.repoOf(pick, s)
    const scope = applyMdScope(repo, a)
    if (!scope.ok) return shell.unsupported('deck_map_snapshot', REFUSAL_REASONS.BAD_ARGS, scope.message, { cost: { estimated: est } })

    // exec 的形状由 DSH 给（会话壳那批还没标类型，见 #1040），三处 exec.signal 各按纯类型断言收口：
    // 取值表达式一字不动，所以转译出来的 JS 与转换前逐字节一致。
    return callDeckSession({ deps: d, opened: pick, session: s, repo: repo, estimate: est, tool: 'deck_map_snapshot', sandbox: (await (async function () { try { if (typeof d.sandboxPolicyFor !== 'function') return null; const raced = await withCap(d.sandboxPolicyFor({ cwd: s.cwd, sessionId: s.sessionId }), DECK_SANDBOX_TIMEOUT_MS); return (raced && raced.ok === true) ? raced.value : null } catch (eS) { return null } })()), signal: (exec && exec.signal && typeof exec.signal === 'object') ? exec.signal : undefined }, async (c: unknown) => {
      // #1831：地图快照是读——没注入小预算时落到读调用总时限（90 秒），不等满 5 分钟。
      const sc = withCallScope(c, exec, { timeoutMs: readCallTimeoutOf(d), marginMs: numOpt(d.toolMarginMs), startedAt: toolEntryAt, now: (typeof d.now === 'function') ? d.now : Date.now })
      // 走到这里 tracker 一定在（预算壳自己的约定：能进这一段就是选好后端了）；
      // 断言只为让编译器安静，运行时一个字节都不动 —— 真为空时下面那句照样抛 TypeError 走 backend-threw。
      const t = sc.tracker!
      const opCtx = sc.opCtx
      // 地图与子票清单互相独立，同时取（两份读缓存的键不同，不会互相覆盖）
      const mapPromise = t.get(repo, key, {}, opCtx)
      const kidsPromise = t.list(repo, { parentKey: key }, opCtx)
      const gotMap = await mapPromise
      if (!gotMap || gotMap.ok !== true) {
        const msg = String((gotMap && gotMap.error && gotMap.error.message) || 'the backend did not give a reason').slice(0, 300)
        // #1799：reason 走统一映射（读地图也是读后端），失败证据留后端原档位与映射后的码。
        const ev = failureOf(gotMap, 'read')
        return {
          value: {
            status: DECK_STATUS.UNSUPPORTED,
            reason: ev.code,
            text: 'This map did not come back (backend words: ' + msg + ').' + nextStepText(ev.code),
            data: { key: key, error: Object.assign({ message: msg }, evidenceFields(ev)) },
          },
          claimed: { requests: 1, points: 3 },
        }
      }
      const map = gotMap.data || {}
      const kids = await kidsPromise
      const listed = (kids && kids.ok === true && Array.isArray(kids.data)) ? kids.data : []
      const picked = childrenOf(listed, key)
      const children = picked.children
      // 子票清单走没走降级也要摆出来：日志里按 opId 查 read.degraded 就是同一趟，不用再猜。
      const kidsFallback = String((kids as { fallback?: unknown } | null | undefined)?.fallback || '')
      const kidsFallbackReason = String((kids as { fallbackReason?: unknown } | null | undefined)?.fallbackReason || '')
      const opId = String(((opCtx as Record<string, unknown> | null | undefined) || {}).opId || '')
      const notes = []
      if (scope.effortId) notes.push(mdScopeNote(scope.scene, scope.effortId))
      if (!kids || kids.ok !== true) notes.push('The sub-issues were not all fetched (backend words: ' + String((kids && kids.error && kids.error.message) || '').slice(0, 200) + ', opId ' + (opId || 'unknown') + '): the progress below is computed from the tickets at hand and is optimistic.')
      else if (kidsFallback === 'rest') {
        if (kidsFallbackReason === 'quota') notes.push('The sub-issue list went through the REST fallback this time because the quota ran out (opId ' + (opId || 'unknown') + '): only what was already fetched is returned, the numbers are optimistic; narrow the query and check again.')
        else notes.push('The sub-issue list went through the REST fallback this time (reason ' + (kidsFallbackReason || 'other') + ', opId ' + (opId || 'unknown') + '; search read.degraded by opId in the log to find the same run): only what was already fetched is returned, the numbers are optimistic.')
      }
      if (picked.note) notes.push(picked.note)
      // 进度统计走共享层同一份投影：把它当成只有这一张地图的 deck 来算。
      const projection = deriveDeck({ maps: [Object.assign({}, map, { tickets: children })], issues: [] })
      const blocks = parseMapBody(String(map.body || ''))
      const partial = !kids || kids.ok !== true
      // #1799：子票没取全时，失败的那一次读也要按统一映射给 reason；没有 kind 就落 backend-unsupported，
      // 文案跟着换成同一方向，不能一边说「走不通」一边劝人原样重试。
      const kidsEv = partial ? failureOf(kids, 'read') : null
      // frontierOnly：在手上这批子票里按派生口径筛可接（未关闭、认领已知且空、阻塞已满足；
      // 图外阻塞按未知计为被阻塞，与派生视图的 NOT-FOUND 安全侧一致，不误判可接）。
      let shown = children
      let frontierNote = ''
      if (a.frontierOnly === true) {
        // 索引签名只为让下面按票号存、按票号取能过编译；键与值的算法一个字没改。
        const stateByKey: Record<string, unknown> = {}
        for (const t of children) if (t && typeof t.key === 'string') stateByKey[String(t.key)] = t.state
        shown = children.filter((t) => {
          if (!t || t.state !== 'open') return false
          if (!Array.isArray(t.assignees)) return false
          if (t.assignees.length > 0) return false
          const blockers = Array.isArray(t.blockedBy) ? t.blockedBy : []
          for (const b of blockers) {
            const k = String((b && b.key) || b || '')
            if (!k) continue
            if (stateByKey[k] !== 'closed') return false
          }
          return true
        })
        frontierNote = 'frontierOnly is on, so only the ' + shown.length + ' sub-issues that can be picked up are returned (out of ' + children.length + ').'
      }
      if (frontierNote) notes.push(frontierNote)
      // 行级明细缺省全量：只有显式传 thin 才变薄。统计、进度表、阻塞键都用全量行算好
      // 再薄行，数字与 full 一字不差；行里不带正文，回包小、票多时不断。
      // 远端传输量今天不变（瘦的是回包，不是这一趟的拉取），注记里如实说。
      // #1790 缺陷 A 的 P4：text 里的冲突数按这次回给调用方的行数（frontierOnly 筛过也照它数）。
      const statusConflictCount = shown.filter(function (t) { return !!t.statusConflict }).length
      const thin = String(a.detail || 'full').trim().toLowerCase() === 'thin'
      if (thin) notes.push('The sub-issue rows are thin (detail=thin: no body and no per-row progress, so the response stays small and the list is not cut off; the stats and the progress table are computed exactly the same; for a body, read each ticket with deck_issue_get; the remote fetch volume is the same as full today).')
      // labels 是后端回来的运行时真值（元素可能是名字串，也可能是带 name 的对象，契约层没建模），
      // 所以给 data.map 里那个回调参数就地标 any：取到的值、判据与顺序与老写法逐字相同。
      return {
        value: {
          status: partial ? DECK_STATUS.PARTIAL : DECK_STATUS.OK,
          reason: kidsEv ? kidsEv.code : '',
          text: partial ? 'Map ' + key + ': the sub-issues were not all fetched (the backend did not return all of them), so the ' + children.length + ' tickets at hand give optimistic numbers.' + nextStepText(kidsEv ? kidsEv.code : '') : 'Map ' + key + ': ' + children.length + ' sub-issues, ' + projection.stats.open + ' open, ' + projection.stats.closed + ' closed, ' + projection.stats.frontier + ' can be picked up, ' + projection.stats.blocked + ' blocked, of which ' + statusConflictCount + ' have a status conflict.',
          data: {
            map: { key: map.key, title: map.title, state: map.state, labels: Array.isArray(map.labels) ? map.labels.map((l: any) => (l && l.name) || String(l)) : [], updatedAt: map.updatedAt || '', url: map.url || '' },
            children: shown.map((t) => (thin ? thinRow(t) : childRow(t))),
            stats: partial ? null : projection.stats,
            truncated: partial,
            // 失败证据只在子票没取全时出现，成功回执的形状一字不动（金标准回执在 tests/tracker-contract/fixtures/golden-receipts/）。
            ...(kidsEv ? { kidsError: evidenceFields(kidsEv, 'errorKind') } : {}),
            labels: projection.labels,
            progressOf: projection.progressOf,
            blockedByKeys: projection.blockedByKeys,
            blocks: { destination: blocks.destination || '', notes: blocks.notes || [], decisions: blocks.decisions || [], fog: blocks.fog || [], outOfScope: blocks.outOfScope || [] },
          },
          notes: notes,
          touched: [],
        },
        claimed: { requests: 2, points: 5 },
      }
    })
  }

  return { definition: definition, run: run }
}
