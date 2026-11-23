// src/deck/tools/issue-report.ts —— deck_issue_report（#775 落地；#1019 换到新树、#1035 转 TypeScript）
//
// AI 主动上报自己在办哪张票：票号必填、可选带一句备注；上报成功后只记一笔工作路线，
// 要看在办表就调 deck_work_route；三后端诚实失败。
// #1352 起 progress 参数退役：上报只表达「在办／办完」，进度一律写到票面（deck_issue_patch 的 progress）。
// 定义里不再广告这个参数；但宿主不替工具挡参数（规格 #1106 写明多传即拒是宿主的责任），run 仍可能
// 收到它，所以收到就按 bad-args 明确拒绝并指路，不悄悄当没有——旧习惯的调用要能立刻看懂该改去哪。
//
// 薄壳四条照旧（shell.js）：过闸、走注册表选后端、只从会话取工作区、永不抛。
// 工作路线由工具壳在成功收口处统一记（#1261 起步、#1262 铺满五个写工具：动作 report、
// 来源 reported；去重键是 (会话, 票)，同一会话同一票后来居上）。本工具自己不再记。
// 票存在性经 tracker.get 校验一遍：读不到就诚实失败，不记路线。
// 本地后端多工作单元时用 effort 或 feature 指到那一个目录（探索地图用 effort、规格体系用 feature）；远端后端忽略它。
// #1086 加一支释放：参数 release=true 时，票照样先读回来证明它存在，然后尝试把本会话对这张票的
// 一条误报工作条目删掉（不记任何动作，票本身的状态与认领人一个字不动）。#1349 起只撤销误报：
// 建过、改过、关过、建过计划或挂过边的票不能释放；不再带这个参数就是老行为。
import { createDeckShell, DECK_STATUS, REFUSAL_REASONS } from '../shell/call-shell.js'
import { evidenceFields, failureOf, reasonForFailure } from '../shell/receipt-reason.js'
import { MD_SCOPE_LOCATE, applyMdScope, mdScopeNote } from './md-scope.js'
import { sessionContextOfAsync } from '../shell/session-workdir.js'
import { TEXT_TICKET_KEY } from '../shell/work-path-receipt-read.js'
import { callDeckSession, openDeckSession } from './tracker-session.js'
import { withCallScope } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'
import { estimateToolCost, toolCostInputFrom } from '../../refresh/kernel/tool-call-budget.js'
// 超时住中央 YAML，调时间改 config/timeouts.yaml。
import { DECK_SANDBOX_TIMEOUT_MS } from '../../shared/time-config/src/values.js'
import { withCap } from '../shell/capped-wait.js'

/** 失败回执里的「下一步做什么」：reason 已经回答了下一步，text 要跟它指向同一件事。
 *  只给本工具判断得了的几种码补一句；其余（后端说做不到等）保持原话，不替后端发明退路。 */
function nextStepText(reason: string): string {
  if (reason === REFUSAL_REASONS.BAD_ARGS) return 'The ticket number may be wrong: check with deck_issue_list or deck_issue_get that this ticket exists, then retry.'
  if (reason === REFUSAL_REASONS.BACKEND_TIMEOUT) return 'Call again in a moment: both report and release have to read the ticket first, and reading has no side effects.'
  if (reason === REFUSAL_REASONS.BACKEND_THREW) return 'Reading a ticket has no side effects, so the same call can be made again.'
  if (reason === REFUSAL_REASONS.OVER_CAP) return 'Call again shortly.'
  return ''
}

/** 数字型参数的统一收口：正的有限数才要（取整），其余一律当「没给」，调用方退自己的默认。 */
function numOpt(v: unknown): number | undefined { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : undefined }
/**
 * #1352：progress 参数已退役，工具定义里也不再声明它。但宿主不替工具挡参数时（规格 #1106 写明
 * 多传即拒是宿主在调用入口按定义做的事），run 仍可能收到这个键，夹具也会直接调用 run；
 * 所以这里检查原始参数：只要这次调用真的带了 progress（值为 undefined 不算），就明确拒绝并指路，
 * 不悄悄当没有——否则旧调用会以为「这次上报带了进度」，而票面上什么也没有。
 */
function retiredProgressGiven(a: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(a, 'progress') && a.progress !== undefined
}
// 沙箱许可等待上限见 ../shell/capped-wait.ts（#1114 第二批）：到点就按「没等到」处理并清掉等待定时器；
// 超时按缺席走老路（不限权），与既有 catch null 同形。
// 执行层失败与后端诚实失败的分界（见 issue-create.ts 同名注释）：前者抛给壳走
// backend-threw（可重试），后者走 BACKEND_UNSUPPORTED。钳制只管超时，不改判。
// 超时单列一支（kind 'timeout'）：它也是执行层失败，但机器可读的原因码走独立的
// backend-timeout（#1195），不再与真正的抛错共用 backend-threw。
const TRANSPORT_KINDS: readonly string[] = ['backend-threw', 'aborted', 'over-budget']
/** 后端回包在契约层还没建模：这里只按本工具真正会读的那一个字段收口，调用处拿断言喂进来（断言不产码）。 */
type TransportResult = { error?: { kind?: string; message?: unknown } } | null | undefined
/** 后端回包里「执行层失败」的原话；不是执行层失败（后端诚实地说做不到）就回 null，一个字不改判。 */
function transportMessage(result: TransportResult): string | null {
  const e = result && result.error
  if (e && TRANSPORT_KINDS.indexOf(e.kind as string) >= 0) return String(e.message || 'the execution layer gave no answer')
  return null
}
/** 超时那一支的原话（kind 'timeout'）：调用处直接回独立原因码，不抛给壳。 */
function timeoutMessage(result: TransportResult): string | null {
  const e = result && result.error
  if (e && e.kind === 'timeout') return String(e.message || 'the execution layer gave no answer')
  return null
}

/**
 * 装配层注入的依赖袋。壳要用的键原样透传（没列的键也一律接受：壳自己还没标类型，这一层不替它把关）；
 * 列出来的是本工具自己会调到的那几个，缺席时各自退默认：没有沙箱策略就跳过那一步等待，没有时钟就用 Date.now。
 */
export interface DeckIssueReportDeps {
  readonly [key: string]: unknown
  /** 沙箱许可策略：给工作区与会话，回这一轮的策略快照；等不到就当没有（不拦事）。
   *  两个值都按会话壳给的原样传（工作区没定下来时可能还没有），不许在这里补空串或假目录。 */
  sandboxPolicyFor?: (arg: { cwd: string | undefined; sessionId: string | undefined }) => Promise<unknown>
  /** 时钟旁路：测试里换成假时钟用，缺省 Date.now。 */
  now?: () => number
}

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_issue_report',
  description: 'The ISSUE and map management of this plugin; it only handles the repo of the current workspace. Call deck_context first to confirm the workspace and backend. It must be called when starting, switching or finishing an ISSUE: report once before starting, and once more when closing. Division of labour: deck_issue_patch changes content, deck_issue_report reports the handling relationship; closing through the former does not mean it has been reported. Put the ISSUE number to report in key; effort or feature is needed only on the local backend (effort for a map, feature for a spec, both are directory names under `.scratch/`), and the remote backend ignores it. To withdraw a wrong report, pass release=true (it only deletes the row of this session; a ticket that was created, changed, closed, planned or linked cannot be released).',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The number of the ISSUE you are reporting' },
      note: { type: 'string', description: 'Optional short note (only echoed back, not added to the chain)' },
      ...MD_SCOPE_LOCATE,
      release: { type: 'boolean', description: 'Optional: pass true to try withdrawing a wrong report this session made for this ticket (it can only be deleted when this ticket has never actually been handled; a ticket that was created, changed, closed, planned or linked cannot be released and its path stays; this does not change the ticket: neither the state nor the assignees move); leave it out or pass false for a normal report' },
    },
    required: ['key'],
    additionalProperties: false,
  },
}

/**
 * 票号归一：去掉开头的 #、丢掉前导零。数字票号照旧只认 1 到 10 位；文本票号（Linear 的 `OMB-923`）
 * 原样放行，怎么解析归房间，和 `deck_issue_patch` / `deck_issue_get` 同一口径（#76：以前这里只认数字，
 * Linear 工作区一次也报不上账）。别的形状（含没给）一律当空。
 *
 * 导出给门禁 `verify-76-report-text-key` 直接用；工具内部只此一处调用。
 */
export function normKey(raw: unknown): string {
  const t = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^#/, '')
  if (!t) return ''
  if (/^\d{1,10}$/.test(t)) return t.replace(/^0+(?=\d)/, '')
  if (TEXT_TICKET_KEY.test(t)) return t
  return ''
}

/**
 * 装配层调一次，拿到这对 { definition, run }。deps 是宿主注入的依赖袋（见 DeckIssueReportDeps），
 * 什么都不给也能跑：壳与这里的每一处都各自退默认。
 */
export function createDeckIssueReport(deps?: DeckIssueReportDeps) {
  const d: DeckIssueReportDeps = deps || {}
  const shell = createDeckShell(Object.assign({}, d, {
    estimate: d.estimate || estimateToolCost,
    costInputFrom: d.costInputFrom || toolCostInputFrom,
  }))

  /**
   * 跑一次：exec 是 DSH 给的执行上下文（会话与沙箱都从它取），args 是模型填的参数。
   * 参数先当「未知」再逐项收口（key / effort / feature / note 下面各收一次），回执形状由壳统一渲染。
   */
  async function run(exec: unknown, args: Record<string, unknown>): Promise<unknown> {
    // 预算起算点：入口前耗时（会话归一、选后端、探沙箱）也要算进预算（#1195）。
    const toolEntryAt = (typeof d.now === 'function') ? d.now() : Date.now()
    const a: Record<string, unknown> = args || {}
    const key = normKey(a.key)
    const est = shell.estimateFor('deck_issue_report', a)
    // #1352：progress 已退役。检查放在最前面（比读会话、比选后端都早）：不花点数、不碰后端、不写盘，
    // 回执形状与别的参数错一样是六格。
    if (retiredProgressGiven(a)) return shell.unsupported('deck_issue_report', REFUSAL_REASONS.BAD_ARGS, 'The progress parameter is retired (#1352): a report only says "in progress / done"; write progress on the ticket instead — pass { percent, note } through the progress parameter of deck_issue_patch, and the tool writes it into the "## 进度" section of that ticket. Nothing was done this time: no backend was selected, no points were spent, and nothing was written to disk.', { cost: { estimated: est } })
    if (Object.prototype.hasOwnProperty.call(a, 'workRouteDetail') && a.workRouteDetail !== undefined) return shell.unsupported('deck_issue_report', REFUSAL_REASONS.BAD_ARGS, 'The workRouteDetail parameter is retired (#1561): the work board no longer comes back inside write receipts; to see it, call deck_work_route (by default it only covers work from the last 24 hours; pass includeStale:true for the last 30 days). Nothing was done this time: no backend was selected, no points were spent, and nothing was written to disk.', { cost: { estimated: est } })
    const s = await sessionContextOfAsync(exec, { canonicalKey: d.canonicalKey, workspaceKeyOf: d.workspaceKeyOf })
    // 会话没解析出来时回的是「为什么」那一支。编译器分不出两支（ok 在会话壳里是运行时布尔，
    // 那一层还没标类型，见 #1040），所以这里按形状取 reason —— 取到的值与老写法逐字相同。
    if (!s.ok) return shell.unsupported('deck_issue_report', (s as { reason: string }).reason, s.text, { cost: { estimated: est } })
    if (!key) return shell.unsupported('deck_issue_report', REFUSAL_REASONS.BAD_ARGS, 'Which ticket to report: put the ticket number in key (for example 775).', { cost: { estimated: est } })
    const note = typeof a.note === 'string' ? a.note.trim().slice(0, 200) : ''
    // #1086 释放标记：只认显式 true（传字符串 'true'、1 之类一律当没带，照旧正常上报）。
    const release = a.release === true

    const pick = await openDeckSession({ deps: d, exec: exec, session: s, estimate: est, tool: 'deck_issue_report', kind: 'write' })
    if (!pick.ok) return shell.unsupported('deck_issue_report', pick.reason, pick.text, { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    const repo = shell.repoOf(pick, s)
    const scope = applyMdScope(repo, a)
    if (!scope.ok) return shell.unsupported('deck_issue_report', REFUSAL_REASONS.BAD_ARGS, scope.message, { cost: { estimated: est } })
    const effortId = scope.effortId
    // 沙箱策略的快照：等不到（超时、对方失败、没注入）一律按「没有」往下走，与老口径同形。
    let sandbox: unknown = null
    try {
      if (typeof d.sandboxPolicyFor === 'function') {
        const raced = await withCap(d.sandboxPolicyFor({ cwd: s.cwd, sessionId: s.sessionId }), DECK_SANDBOX_TIMEOUT_MS)
        sandbox = (raced && raced.ok === true) ? raced.value : null
      }
    } catch (eS) { sandbox = null }

    return callDeckSession({ deps: d, opened: pick, session: s, repo: repo, estimate: est, tool: 'deck_issue_report', sandbox: sandbox }, async (c: unknown) => {
      const sc = withCallScope(c, exec, { timeoutMs: numOpt(d.toolTimeoutMs), marginMs: numOpt(d.toolMarginMs), startedAt: toolEntryAt, now: (typeof d.now === 'function') ? d.now : Date.now })
      // 走到这里 tracker 一定在（预算壳自己的约定：能进这一段就是选好后端了）；
      // 断言只为让编译器安静，运行时一个字节都不动 —— 真为空时下面那句照样抛 TypeError 走 backend-threw。
      const t = sc.tracker!
      const opCtx = sc.opCtx
      const notes = []
      if (scope.effortId) notes.push(mdScopeNote(scope.scene, scope.effortId))
      if (note) notes.push('The note is only echoed back and does not go into the work route (each entry on the route keeps only the ticket key, the time and the action kind).')
      const got = typeof t.get === 'function' ? await t.get(repo, key, { comments: { first: 0 } }, opCtx) : null
      const gotTimeout = timeoutMessage(got as TransportResult)
      if (gotTimeout) return {
        value: {
          status: DECK_STATUS.UNSUPPORTED,
          reason: reasonForFailure({ kind: 'timeout', phase: 'read' }),
          text: release
            ? 'This ticket was not released this time (timed out: the backend did not answer within the time limit, so whether the release landed is unclear; just call again).'
            : 'This ticket was not reported this time (timed out: the backend did not answer within the time limit, so whether it was recorded is unclear; just call again).',
          data: { key: key, backendId: pick.backendId, effortId: effortId, error: { kind: 'timeout', message: gotTimeout.slice(0, 300) } },
          notes: notes,
        },
        claimed: { requests: 1, points: 3 },
      }
      const gotTransport = transportMessage(got as TransportResult)
      if (gotTransport) throw new Error(gotTransport)
      if (!got || got.ok !== true) {
        const msg = String((got && got.error && got.error.message) || 'the backend did not give a reason').slice(0, 300)
        // #1799：这一支失败的是「读票确认它存在」那一次读（写动作——记路线或释放——都还没发生），
        // 所以按读阶段映射：票不存在归 bad-args，读侧网络/解析失败可原样重试，别按写阶段劝人先读回。
        const ev = failureOf(got, 'read')
        return {
          value: {
            status: DECK_STATUS.UNSUPPORTED,
            reason: ev.code,
            text: (release
              ? 'This ticket was not released (ticket ' + key + ' did not come back; a release has to confirm that the ticket really exists first, so nothing was done. Backend words: ' + msg + ').'
              : 'This ticket was not reported (ticket ' + key + ' did not come back; backend words: ' + msg + ').') + nextStepText(ev.code),
            data: { key: key, backendId: pick.backendId, effortId: effortId, error: Object.assign({ message: msg }, evidenceFields(ev)) },
            notes: notes,
          },
          claimed: { requests: 1, points: 3 },
        }
      }
      const issue = got.data || {}
      // 工作路线由工具壳在成功收口处统一记（#1262：五个写工具都记；本工具的动作 report、来源 reported），本工具不再显式记。
      const title = typeof issue.title === 'string' ? issue.title.slice(0, 80) : ''
      if (release) {
        // #1086 释放一支：票读回来就证明它确实存在，交壳把本会话那一条删掉。
        // 值顶层的 release:true 是工具与壳之间的内部信号，信封只拷固定那几格，不会漏进回执。
        return {
          value: {
            status: DECK_STATUS.OK,
            release: true,
            text: 'Ticket ' + key + ' was not reported this time but released: it tried to delete this wrong entry from the work route of this session (the state and assignees of the ticket itself were not changed). Only a ticket that was never actually handled can be deleted; whether it was deleted is in the receipt notes.',
            data: {
              key: key, title: title, state: issue.state || '', url: issue.url || '',
              backendId: pick.backendId, effortId: effortId || (issue.effortId !== undefined ? issue.effortId : ''),
              note: note,
            },
            notes: notes,
            touched: [],
          },
          claimed: { requests: 1, points: 3 },
        }
      }
      return {
        value: {
          status: DECK_STATUS.OK,
          text: 'Ticket ' + key + ' reported (' + (title || 'could not read the title') + ')' + (note ? ': ' + note.slice(0, 80) : '') + '. To see the work board, call deck_work_route.',
          data: {
            key: key, title: title, state: issue.state || '', url: issue.url || '',
            backendId: pick.backendId, effortId: effortId || (issue.effortId !== undefined ? issue.effortId : ''),
            note: note,
          },
          notes: notes,
          touched: [],
        },
        claimed: { requests: 1, points: 3 },
      }
    })
  }

  return { definition: definition, run: run }
}
