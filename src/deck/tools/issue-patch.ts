// src/deck/tools/issue-patch.ts —— deck_issue_patch（#713 第六批；#1019 换到新树、#1035 转 TypeScript；#1091 加维护者原话）
//
// 一次调用改一张票：评论 / 标签流转 / 认领 / 关闭重开 / 标题正文 / 进度区 / 维护者原话区。
// 只做调用方点名的那几件事，没点名的字段一个字都不碰（改票最怕「顺手改了别的东西」）。
// 做完的每一步都单独记一条 item：哪一步成、哪一步没成、后端原话是什么。
// 返回值就是写后的真状态（能读回就读回一次），AI 不必再读一次确认。
//
// #1298 T7 的口径（规格容器的自动关闭权限）：这个工具只允许「关」，不允许「重开」——重开只由人在后端做。
// 关规格之前有三道闸，全在同一次调用里判，判不过就一个字都不动地拒绝：实施票必须全部关闭；
// 必须带一条收口核对评论（逐张核对结论）；规格下面连实施票都没有时不算核对通过。
// 没有「看到子票都关了顺手关」的旁路：唯一的触发条件就是收口核对通过，而这条评论本身就是核对通过的证据。
import { createDeckShell, DECK_STATUS, REFUSAL_REASONS } from '../shell/call-shell.js'
import { applyMdScope, mdScopeNote } from './md-scope.js'
import { claimNoteOf } from './assignee-note.js'
import { sessionContextOfAsync } from '../shell/session-workdir.js'
import { callDeckSession, openDeckSession } from './tracker-session.js'
import { statusOfItems, failureFields } from '../shell/edge-landing.js'
import { specCloseGuard } from '../shell/spec-close-guard.js'
import { withCallScope } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'
import { withKeyLock } from '../shell/write-mutex.js'
import { ensureBody } from '../shell/minimal-spec.js'
// #1195：执行层失败（抛错 / 中止 / 超时 / 预算耗尽）的收口从两个写工具里抽出来共用，判据一字未改。
import { must, numOpt, timeoutMessage, withCap } from '../shell/backend-transport.js'
import type { TransportResult } from '../shell/backend-transport.js'
// #1799：非 ok 回执的 reason 只从 receipt-reason 来（它回答「下一步做什么」）；失败项同时保留 kind/stage 证据。
import { failureOf, reasonForFailure, reasonForItems } from '../shell/receipt-reason.js'
import type { LocalFailureCause } from '../shell/receipt-reason.js'
// #1090：进度区的读、写、核对统一走 shared 层的那一份口径（读与写共用同一份写法，不再各留一份正则）。
// #1091：维护者原话区同理；两块一起写时的组合与写后核对住在 body-write。
import { PROGRESS_BODY_LIMIT } from '../../shared/issue-file/src/progress.js'
import type { ProgressEntry } from '../../shared/issue-file/src/progress.js'
import { progressEntryFromArg, stampNow } from '../../shared/issue-file/src/progress-tool.js'
import type { OriginalWordsEntry } from '../../shared/issue-file/src/original-words.js'
import { originalWordsFromArg } from '../../shared/issue-file/src/original-words-tool.js'
import { planBodyWrite, moveLeadingSectionBelowTitle } from '../shell/body-write.js'
import type { BodyWritePlan } from '../shell/body-write.js'
import { bodyDigest as bodyDigestOf } from '../shell/body-digest.js'
import { textWriteVerify } from '../shell/text-write-verify.js'
import { estimateToolCost, toolCostInputFrom } from '../../refresh/kernel/tool-call-budget.js'
// 超时住中央 YAML，调时间改 config/timeouts.yaml。
import { DECK_SANDBOX_TIMEOUT_MS } from '../../shared/time-config/src/values.js'
// #1790 缺陷 A：状态冲突的预检、归一与拒绝回执住在 issue-patch-status（本文件有效行贴着每文件 350 行的上限）。
import { guardStatus, namesOf } from './issue-patch-status.js'
import { runLabelsStep } from './issue-patch-labels.js'
// #1832：一张票最多一枚 triage 状态；addLabels 一次给两枚以上时在选后端之前整笔拒绝。
import { triageStateProblem } from '../rules/triage-state.js'

/**
 * 装配层注入的依赖袋。壳要用的键原样透传（没列的键也一律接受：壳自己还没标类型，这一层不替它把关）；
 * 列出来的是本工具自己会读的那几个，缺席时各自退默认：没有沙箱策略就跳过那一步等待，没有时钟就用 Date.now。
 */
export interface DeckIssuePatchDeps {
  readonly [key: string]: unknown
  /** 沙箱许可策略：给工作区与会话，回这一轮的策略快照；等不到就当没有（不拦事）。两个值原样传，可能还没有。 */
  sandboxPolicyFor?: (arg: { cwd: string | undefined; sessionId: string | undefined }) => Promise<unknown>
  /** 时钟旁路：测试里换假时钟用，缺省 Date.now。 */
  now?: () => number
}

// 工具定义搬到了单独一份（本文件有效行贴着每文件 350 行的上限，定义是一段纯数据、与运行逻辑没有耦合）。
// 对外形状不变：装配层（agent-row）与这里都从同一份定义出路由、参数名与给 AI 看的说明。
import { definition } from './issue-patch-definition.js'
export { definition }

/**
 * 装配层调一次，拿到这对 { definition, run }。deps 是宿主注入的依赖袋（见 DeckIssuePatchDeps），
 * 什么都不给也能跑：壳与这里的每一处都各自退默认。
 */
export function createDeckIssuePatch(deps?: DeckIssuePatchDeps) {
  const d: DeckIssuePatchDeps = deps || {}
  const shell = createDeckShell(Object.assign({}, d, {
    estimate: d.estimate || estimateToolCost,
    costInputFrom: d.costInputFrom || toolCostInputFrom,
  }))

  /**
   * 跑一次：exec 是 DSH 给的执行上下文（会话与沙箱都从它取），args 是模型填的参数。
   * 参数先当「未知」再逐项收口（key / effort / feature 与下面那几件要改的事各收一次），回执形状由壳统一渲染。
   * exec 上只声明本文件真正会读的那个字段（取消信号），其余字段一律不碰、照旧整只交给壳，
   * 所以下面取 signal 的地方不必写一串断言。
   */
  async function run(exec: { signal?: unknown } | null | undefined, args: Record<string, unknown>): Promise<unknown> {
    // 预算起算点：入口前耗时（会话归一、选后端、探沙箱）也要算进预算（#1195）。
    const toolEntryAt = (typeof d.now === 'function') ? d.now() : Date.now()
    const a: Record<string, unknown> = args || {}
    const key = String(a.key === undefined || a.key === null ? '' : a.key).trim()
    const est = shell.estimateFor('deck_issue_patch', a)
    if (Object.prototype.hasOwnProperty.call(a, 'workRouteDetail') && a.workRouteDetail !== undefined) return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, 'The workRouteDetail parameter is retired (#1561): the work board no longer comes back inside write receipts; to see it, call deck_work_route (by default it only covers work from the last 24 hours; pass includeStale:true for the last 30 days). Nothing was done this time: no backend was selected, no points were spent, and nothing was written to disk.', { cost: { estimated: est } })
    const s = await sessionContextOfAsync(exec, { canonicalKey: d.canonicalKey, workspaceKeyOf: d.workspaceKeyOf })
    // 会话没解析出来时回的是「为什么」那一支。编译器分不出两支（ok 在会话壳里是运行时布尔，
    // 那一层还没标类型，见 #1040），所以这里按形状取 reason —— 取到的值与老写法逐字相同。
    if (!s.ok) return shell.unsupported('deck_issue_patch', (s as { reason: string }).reason, s.text, { cost: { estimated: est } })
    if (!key) return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, 'Which ticket to change: put the ticket number in key.', { cost: { estimated: est } })
    // #1298 ⑧：AI 工具面上只允许关、不允许重开。重开是「人才能做的动作」，不属于这个工具的权限，
    // 所以这一支在选后端之前就拒掉，连后端都不连、一个字都不动。机器可读的原因码沿用 ai-tool-refused
    // （与额度用尽同一个码：两种都是「AI 这一侧不许做这件事」，文案里说清是哪一种）。
    if (a.close === false) {
      return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.OVER_CAP, 'Reopening is not on this AI tool surface: this tool only allows closing, not reopening; to reopen, a person has to do it in the backend by hand (the ticket page on GitHub, or the ticket file under the local .scratch directory). Nothing was changed this time.', { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    }
    // #1832：triage 状态是切换而不是叠加，一次只能给一枚。addLabels 里出现两枚以上状态时整笔拒绝，
    // 并且在选后端之前拒 —— 连后端都不连、一个字都不动（与上面「重开」同一档收口）。
    const addLabels = namesOf(a.addLabels)
    const removeLabels = namesOf(a.removeLabels)
    const labelStateProblem = triageStateProblem(addLabels, 'addLabels')
    if (labelStateProblem) return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, labelStateProblem + ' Nothing was changed this time: no backend was selected, no points were spent, and nothing was written to disk.', { cost: { estimated: est } })

    const pick = await openDeckSession({ deps: d, exec: exec, session: s, estimate: est, tool: 'deck_issue_patch', kind: 'write' })
    if (!pick.ok) return shell.unsupported('deck_issue_patch', pick.reason, pick.text, { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    const repo = shell.repoOf(pick, s)
    const scope = applyMdScope(repo, a)
    if (!scope.ok) return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, scope.message, { cost: { estimated: est } })
    // 索引签名只为让下面按 key 过滤时能取用；键名、值的算法与个数一个字没改。
    const wants: Record<string, boolean> = {
      comment: typeof a.comment === 'string' && a.comment.trim() !== '',
      labels: addLabels.length > 0 || removeLabels.length > 0,
      assignees: Array.isArray(a.assignees),
      text: typeof a.title === 'string' || typeof a.body === 'string' || (a.progress !== undefined && a.progress !== null) || (a.originalWords !== undefined && a.originalWords !== null),
      state: typeof a.close === 'boolean',
    }
    // #1495：关闭原因单独成参，不复用 comment：comment 是讨论，closeReason 是结论；地图子票要进 Answer、实施票要进评论，两边不能混。只带原因不带关票时拒写，免得原因没地方落。
    const rawCloseReason = typeof a.closeReason === 'string' ? a.closeReason.trim() : ''
    if (a.closeReason !== undefined && a.closeReason !== null && typeof a.closeReason !== 'string') {
      return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, 'The close reason has to be written as text: closeReason can only be a string, used together with close:true. Nothing was changed this time.', { cost: { estimated: est } })
    }
    if (rawCloseReason !== '' && a.close !== true) {
      return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, 'A close reason without closing: closeReason must be used together with close:true; on its own it does not say which ticket to close. Nothing was changed this time.', { cost: { estimated: est } })
    }
    if (!wants.comment && !wants.labels && !wants.assignees && !wants.text && !wants.state) {
      return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, 'This call did not say what to change: name at least one thing (comment / addLabels / removeLabels / assignees / title / body / progress / originalWords / close).', { cost: { estimated: est } })
    }
    // #1090：进度参数按结构化收口，时间由这里盖（测试用 deps.now 的假时钟）。收不成时整笔拒绝，
    // 不把一段自由文字塞进正文让读的人再猜一遍写法。
    let progressEntry: ProgressEntry | null = null
    if (a.progress !== undefined && a.progress !== null) {
      const parsed = progressEntryFromArg(a.progress)
      if (parsed.entry === null) {
        return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, parsed.problem + ' Nothing was changed this time.', { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
      }
      progressEntry = { percent: parsed.entry.percent, note: parsed.entry.note, updatedAt: stampNow(toolEntryAt) }
    }
    // #1091：维护者原话按 {text, source} 收口，收不成一样整笔拒绝——原话是一字不改的东西，
    // 宁可不写，也不替调用方补一个猜出来的出处。
    let originalWords: OriginalWordsEntry | null = null
    if (a.originalWords !== undefined && a.originalWords !== null) {
      const parsed = originalWordsFromArg(a.originalWords)
      if (parsed.entry === null) {
        return shell.unsupported('deck_issue_patch', REFUSAL_REASONS.BAD_ARGS, parsed.problem + ' Nothing was changed this time.', { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
      }
      originalWords = parsed.entry
    }

    // exec 的形状由 DSH 给（会话壳那批还没标类型，见 #1040），三处 exec.signal 各按纯类型断言收口：
    // 取值表达式一字不动，所以转译出来的 JS 与转换前逐字节一致。
    return callDeckSession({ deps: d, opened: pick, session: s, repo: repo, estimate: est, tool: 'deck_issue_patch', sandbox: (await (async function () { try { if (typeof d.sandboxPolicyFor !== 'function') return null; const raced = await withCap(d.sandboxPolicyFor({ cwd: s.cwd, sessionId: s.sessionId }), DECK_SANDBOX_TIMEOUT_MS); return (raced && raced.ok === true) ? raced.value : null } catch (eS) { return null } })()), signal: (exec && exec.signal && typeof exec.signal === 'object') ? exec.signal : undefined }, async (c: unknown) => {
      const sc = withCallScope(c, exec, { timeoutMs: numOpt(d.toolTimeoutMs), marginMs: numOpt(d.toolMarginMs), startedAt: toolEntryAt, now: (typeof d.now === 'function') ? d.now : Date.now })
      // 走到这里 tracker 一定在（预算壳自己的约定：能进这一段就是选好后端了）；
      // 断言只为让编译器安静，运行时一个字节都不动 —— 真为空时下面那句照样抛 TypeError 走 backend-threw。
      const t = sc.tracker!
      const opCtx = sc.opCtx
      const items: Array<Record<string, unknown>> = []
      const notes: string[] = []
      if (scope.effortId) notes.push(mdScopeNote(scope.scene, scope.effortId))
      const touched = [key]
      // 锁内超时的传话格：锁回调里不能直接回整笔回执（那只会结束锁回调），超时原话先记在这里，
      // 锁出来以后统一回 timeoutReply；每次进锁前清零。
      let lockTimeout: string | null = null
      // result 是后端回包（形状是运行时真值，契约层还没建模）：参数就地收窄成「只读 error.message」，
      // 下面那句读的还是原来那个 result，字段名与默认值一个字没改。
      // #1799：一处失败记一条 item —— reason 是给人看的原话，code/errorKind/stage 是「下一步做什么」与原始分类的证据。
      // result 是后端回包（本地闸门、写后核对这类失败没有后端回包，传 null）；local 是 deck 本地这一环的失败来源；
      // message 是调用方自己的话（有它就不用后端原话，例如正文指纹对不上）。同一个映射函数管所有回执的顶层 reason。
      const fail = (step: string, result: unknown, local?: LocalFailureCause, message?: string) => {
        const err = (result && typeof result === 'object' && (result as { error?: unknown }).error && typeof (result as { error?: unknown }).error === 'object') ? (result as { error: { message?: unknown } }).error : {}
        const msg = String(message || (err && err.message) || 'the backend did not give a reason').slice(0, 200)
        items.push(Object.assign({ key: key, step: step, status: 'failed', reason: msg }, failureFields(result, 'write', local)))
      }
      // 剩余额度不够时停发新调用：与 deck_map_link 同一句话，逐项诚实报失败，不硬撑。
      // 这一环是「这次没发出去」，不是「AI 不许做」，所以下一步是稍后重试（backend-threw），不是 ai-tool-refused。
      const over = (step: string) => fail(step, null, 'budget', 'There is not enough quota left to send this call, so this step was not done: call again with the same parameters.')
      // 超时整笔回：执行层超时不是某一项没做成，整笔直接回独立原因码（可重试），不抛给壳。
      const timeoutReply = (msg: string) => ({
        value: {
          status: DECK_STATUS.UNSUPPORTED,
          // 执行层超时 = 这次调用没等到后端回话（可能已生效），下一步先读回确认；同一个映射函数给码。
          reason: reasonForFailure({ kind: 'timeout', phase: 'write' }),
          text: 'This change did not go through (timed out: the backend did not answer within the time limit, so whether the change landed is unclear; read the current state once and then continue, do not replay directly).',
          data: { key: key, backendId: pick.backendId, error: { kind: 'timeout', message: String(msg || '').slice(0, 300) } },
        },
        claimed: { requests: est.requests, points: est.points },
      })
      // 同票并发写互斥：等不到锁就诚实记一笔，不硬挤（单次原子写不拿锁，只有读改写序列拿）。
      const lockOpts = { timeoutMs: numOpt(d.keyLockTimeoutMs) }
      const lockedOut = (step: string) => fail(step, null, 'lock', 'This ticket is being changed by another call right now, so nothing was changed: call again with the same parameters in a moment.')

      // #1298 ⑤⑥⑦：关规格的前置闸。规格不是普通票：它只有在「收口核对通过」之后才允许自动关闭，
      // 而核对通过的证据就是同一次调用里那条评论（逐张核对结论）；实施票没全关时，关规格必须失败并说清缺哪几张。
      // 三道闸的判定与读取都住在 spec-close-guard（一个深模块），这里只把结果翻成回执。
      // 这道闸放在所有写动作之前：宁可一个字都不动地拒绝，也不要先发一条评论、再把关闭拦下来。
      let specClose = false
      if (wants.state && a.close === true) {
        // 拒绝回执：判不过就整笔停下，所有写动作都没开始，所以 items 是空的（一步都没走）。
        // reads 只用于记账：这次读了几次（读这张票 1 次，读了子票清单再加 1 次）。
        const refuseSpecClose = (rule: string, text: string, extra: Record<string, unknown>, reads: number) => ({
          value: {
            status: DECK_STATUS.UNSUPPORTED,
            reason: REFUSAL_REASONS.OVER_CAP,
            text: text,
            data: Object.assign({ key: key, rule: rule }, extra),
          },
          claimed: { requests: reads, points: 3 },
        })
        const gate = await specCloseGuard({ tracker: t, repo: repo, key: key, opCtx: opCtx, hasComment: wants.comment })
        if (gate.kind === 'timeout') return timeoutReply(gate.message)
        if (gate.kind === 'refuse') return refuseSpecClose(gate.rule, gate.text, gate.data, gate.reads)
        specClose = gate.kind === 'ok'
      }

      // #1790 缺陷 A：先看这张票的可见 Status 行与隐藏 triage 标签是否各说各话。
      // 真冲突时整次不写（半写比不写更糟），调用方给了 resolveStatus 时先归一；判定与回执住在 issue-patch-status。
      const statusGuard = await guardStatus({
        args: a, key: key, repo: repo, tracker: t, opCtx: opCtx, estimate: est,
        items: items, outOfBudget: () => sc.outOfBudget(), fail: fail, over: over,
        timeoutReply: timeoutReply, lockedOut: lockedOut, lockOpts: lockOpts,
        // 这次还点了改标签时，归一交给标签那一步合并写（同一批标签 + 同一个状态只写一次盘）。
        deferToLabels: wants.labels,
      })
      if (!statusGuard.ok) return statusGuard.reply
      // 三格含义：chosen 是按 resolveStatus 选定的状态（无冲突或没给 resolveStatus 时为空）；
      // conflict 是读侧报的那一份冲突（没有就是空）；guardStatusValue 是这次读回来的当前状态（非 Markdown 后端为空）。
      const chosen = statusGuard.chosen
      const conflict = statusGuard.conflict
      const guardStatusValue = statusGuard.status
      const guardStatusModel = statusGuard.statusModel

      // #1790 缺陷 A：状态冲突已由上面的闸处理完（没有冲突时 chosen、conflict 都是空）。
      // 标签步骤排在评论前面：它最可能被后端驳回（这次带的显式状态与 resolveStatus 选的那一侧对不上），
      // 排第一时驳回就是整笔没写，不会留下「评论已经发出去了」的半写。这一步的序列住在 issue-patch-labels。
      if (wants.labels) {
        if (sc.outOfBudget()) over('labels')
        else {
          const labelsStep = await runLabelsStep({
            key: key, repo: repo, tracker: t, opCtx: opCtx, items: items, notes: notes,
            addLabels: addLabels, removeLabels: removeLabels,
            chosen: chosen, conflict: conflict, statusValue: guardStatusValue, statusModel: guardStatusModel,
            estimate: est, lockOpts: lockOpts, outOfBudget: () => sc.outOfBudget(),
            timeoutReply: timeoutReply, fail: fail, over: over, lockedOut: lockedOut,
          })
          if (labelsStep.kind === 'reply') return labelsStep.reply
        }
      }

      // 评论排在标签之后：前面每一步都可能整笔拒绝，评论一旦发出去就撤不回来（不留下半写）。
      if (wants.comment) {
        if (sc.outOfBudget()) over('comment')
        else {
          const rawComment = await t.comment(repo, key, a.comment, opCtx)
          const commentTimeout = timeoutMessage(rawComment as unknown as TransportResult)
          if (commentTimeout) return timeoutReply(commentTimeout)
          const r = must(rawComment)
          if (r && r.ok === true) items.push({ key: key, step: 'comment', status: 'ok' })
          else fail('comment', r)
        }
      }

      if (wants.assignees) {
        const want = Array.isArray(a.assignees) ? a.assignees.map((x) => String(x)) : []
        if (sc.outOfBudget()) over('assignees')
        else {
          const rawAssign = await t.setAssignees(repo, key, want, {}, opCtx)
          const assigneesTimeout = timeoutMessage(rawAssign as unknown as TransportResult)
          if (assigneesTimeout) return timeoutReply(assigneesTimeout)
          const r = must(rawAssign)
          if (r && r.ok === true) {
            // 「回了 ok」不等于「认领人记上了」：本地 Markdown 把认领人写进文件头隐藏注释，写后读回才看得见；别的后端各有各的落盘方式。
            // 判据只取写后读回这一次（后端的回答本身），不取写动作自己的回包 —— GitHub 房会把回包里的
            // 认领人覆盖成刚提交的那一份（issues-write.ts 的 setAssignees），拿它当证据等于自问自答，
            // 于是「写命令成功、认领人没记上」会被报成 ok（#790 同一类）。
            const canRead = typeof t.get === 'function' && !sc.outOfBudget()
            const after = canRead ? await t.get(repo, key, {}, opCtx) : null
            const readOk = !!(after && after.ok === true)
            // 索引签名只为让下面按字段名读认领人能过编译（读法与默认值一字未改）。
            const back: Record<string, unknown> = readOk ? (after.data || {}) : {}
            const got = Array.isArray(back.assignees) ? back.assignees.map((x) => (x && x.login) || String(x)) : []
            const missing = want.filter((w) => got.indexOf(w) < 0)
            if (!readOk) {
              fail('assignees', canRead ? after : null, 'unconfirmed', 'The write call returned success, but the read-back after the write did not come back (' + (canRead ? 'backend words: ' + String((after && after.error && after.error.message) || 'no reason given').slice(0, 160) : 'not enough quota left to read back this result') + '): whether the assignees were recorded is unknown, do not assume they were.')
            } else if (want.length && missing.length) {
              fail('assignees', null, 'verify', 'The backend returned ok, but the ticket read back does not carry these assignees (' + missing.join(', ') + '): the assignees were not recorded, do not assume the assignment was recorded.')
            } else {
              items.push({ key: key, step: 'assignees', status: 'ok', assignees: want })
              // #1788：普通实施票与普通票的认领只记认领人、不动可见状态，这是正常的落盘方式 ——
              // 回执必须把这一点说清，否则读回执的人会以为可见状态也被改过。
              if (want.length) notes.push(claimNoteOf(back.body))
            }
          } else if (r && r.error && r.error.kind === 'unsupported') {
            fail('assignees', r, undefined, 'This backend cannot record assignees (backend words: ' + String(r.error.message || '').slice(0, 160) + ').')
          } else fail('assignees', r)
        }
      }

      // #1090 / #1091：正文写后核对。写动作回了 ok 不算数，要能读回才算写好：
      // 进度区第一条逐项相同、去掉进度区后其余正文逐字不变；原话逐字读得到、整份正文与计划的新正文逐字相同。
      // 比对与记账住在 shared 层与 body-write / text-write-verify，这里只给「怎么读回」。
      const verifyTextWrite = (plan: BodyWritePlan) => textWriteVerify({ key: key, plan: plan, outOfBudget: sc.outOfBudget(), read: () => t.get(repo, key, {}, opCtx) })

      if (wants.text) {
        // 正文读改写序列持同票锁（单次标题直写也一起 serial，保证与进度/原话回写不交错）。
        if (sc.outOfBudget()) over('text')
        else {
          lockTimeout = null
          const held = await withKeyLock(repo, key, async () => {
            // 索引签名只为让下面按字段名赋值、delete 与取键名能过编译；写进去的键与值一个字没改。
            const patch: Record<string, unknown> = {}
            let bodyProblem: string | null = null
            // #1799：正文这一路的失败原因不在后端回包里，另记「本地哪一环」与能拿到的后端失败回包，
            // 回执里的码才对得上下一步（改参数 / 重读再试 / 先读回确认）。
            let bodyProblemLocal: LocalFailureCause | undefined
            let bodyProblemFailure: unknown = null
            let beforeBase: string | null = null
            let bodyPlan: BodyWritePlan | null = null
            const explicitBody = typeof a.body === 'string'
            const wantDigest = typeof a.bodyDigest === 'string' ? String(a.bodyDigest).trim().toLowerCase() : ''
            if (typeof a.title === 'string') patch.title = a.title
            // 整段正文替换的乐观锁（#1562）：调用方先用 body='full' 读出全文与指纹，这次把指纹带来；
            // 这里先读当前正文算指纹，对不上就一个字不动——防止两边同时改正文时后写的把先写的覆盖掉。
            // 只改进度或原话（不传整段 body）时走下面的读改写，不用这把锁。
            if (explicitBody && wantDigest === '') { bodyProblem = 'Replacing the whole body needs bodyDigest first: read once with deck_issue_get(body=\'full\'), then pass back data.body.digest exactly as it came; this time the body was not changed.'; bodyProblemLocal = 'input' }
            else if (explicitBody && wantDigest !== '') {
              if (sc.outOfBudget()) { bodyProblem = 'Not enough quota left to read the old body and verify the digest: this time the body was not changed.'; bodyProblemLocal = 'budget' }
              else {
                const rawBase = await t.get(repo, key, {}, opCtx)
                const baseTimeout = timeoutMessage(rawBase as unknown as TransportResult)
                if (baseTimeout) { lockTimeout = baseTimeout; return }
                const baseCur = must(rawBase)
                const baseText = (baseCur && baseCur.ok === true && baseCur.data && typeof baseCur.data.body === 'string') ? baseCur.data.body : null
                if (baseText === null) { bodyProblem = 'The old body did not come back, so the digest cannot be verified before overwriting: the body was not written this time; wait until the old body can be read back and then write.'; bodyProblemFailure = baseCur }
                else if (bodyDigestOf(baseText) !== wantDigest) { bodyProblem = 'The body digest does not match: this ticket was changed by someone after your last read; read it again with deck_issue_get(body=\'full\') first, then write with the new digest. Nothing was changed this time.'; bodyProblemLocal = 'stale' }
              }
            }
            if (explicitBody && bodyProblem === null) patch.body = a.body
            // 点到了进度或原话时先拿到写前正文：传了整段 body 就用它，否则读回旧正文。
            if (progressEntry || originalWords) {
              if (explicitBody) beforeBase = a.body as string
              else if (sc.outOfBudget()) { bodyProblem = 'Not enough quota left to read the old body: this time the body was not changed.'; bodyProblemLocal = 'budget' }
              else {
                const rawCur = await t.get(repo, key, {}, opCtx)
                const currentTimeout = timeoutMessage(rawCur as unknown as TransportResult)
                if (currentTimeout) { lockTimeout = currentTimeout; return }
                const cur = must(rawCur)
                const base = (cur && cur.ok === true && cur.data && typeof cur.data.body === 'string') ? cur.data.body : null
                // 旧正文没读回来时不敢拿空正文覆盖：空写一次就会把整张票冲成只剩进度段（#908 亲历）。
                // 这次宁可报失败，让调用方等能读回再写，或改传整段 body。
                if (base === null) { bodyProblem = 'The old body did not come back, so a partial body will not be used to overwrite: the body was not written this time; wait until the old body can be read back and then write (if it is urgent, pass the whole body instead).'; bodyProblemFailure = cur }
                // 进度区要追加到正文里，先按最小骨架补出「## 进度」；原话区不补（它的位置规则自己管）。
                else beforeBase = progressEntry ? ensureBody(base, 'issue').body : base
              }
              // #1091：两块一起点时按「先进度、再原话」组合（组合规则住在 body-write）。
              // strictRoundTrip 只在「不是整份替换」那一路打开：传了整段 body 时后端会套标题、
              // 补文件头与字段行，读回来的整份正文本来就跟计划不一样，逐字比整份会误报。
              if (beforeBase !== null && bodyProblem === null) {
                const planned = planBodyWrite(beforeBase, progressEntry, originalWords, PROGRESS_BODY_LIMIT, !explicitBody)
                if (planned.plan === null) { bodyProblem = planned.problem; bodyProblemLocal = 'input' }
                else bodyPlan = planned.plan
                // #1486：本地票传上来的是整份文件；原话区被共享规则放到标题前时搬回字段行之后，
                // 否则标题前会多出一段 H2，父注释与字段行都跟着读不到（写后核对也会差一截）。
                if (bodyPlan && bodyPlan.originalWords) bodyPlan.next = moveLeadingSectionBelowTitle(bodyPlan.next)
              }
              // 幂等：同一段原话 + 同一出处已经在正文里，且这次没有别的正文改动，就不重写正文（只记账）。
              if (bodyProblem === null && bodyPlan !== null && bodyPlan.skipped && !explicitBody && typeof a.title !== 'string') {
                items.push({ key: key, step: 'text', status: 'ok', fields: ['originalWords'], originalWords: originalWords, skipped: true })
                return
              }
              // 计划出来的正文与自己一样时（幂等跳过、又传了整段 body）就别重复写：已经点过 body 的照样写它自己。
              if (bodyProblem === null && bodyPlan !== null) {
                if (explicitBody || bodyPlan.next !== beforeBase) patch.body = bodyPlan.next
                else delete patch.body
              }
            }
            if (bodyProblem !== null) {
              // 正文没写时标题照写；如果只点了正文，这次文字一个字不动，失败原因在这里记好。
              delete patch.body
              fail('text', bodyProblemFailure, bodyProblemLocal, bodyProblem)
            }
            if (Object.keys(patch).length > 0) {
              if (sc.outOfBudget()) over('text')
              else {
                const rawText = await t.update(repo, key, patch, opCtx)
                const textTimeout = timeoutMessage(rawText as unknown as TransportResult)
                if (textTimeout) { lockTimeout = textTimeout; return }
                const r = must(rawText)
                if (r && r.ok === true) {
                  if (bodyPlan !== null && Object.prototype.hasOwnProperty.call(patch, 'body')) items.push(await verifyTextWrite(bodyPlan))
                  else items.push({ key: key, step: 'text', status: 'ok', fields: Object.keys(patch) })
                } else fail('text', r)
              }
            }
          }, lockOpts)
          if (lockTimeout) return timeoutReply(lockTimeout)
          if (held && held.ok === false && held.timedOut) lockedOut('text')
        }
      }

      if (wants.state) {
        // #1298 ⑤⑦：规格的关闭必须带着同一次调用里的收口核对评论。评论那一步在上面已经跑了：
        // 它没成（被额度挡下、后端拒了）时，这里不许再调关闭 —— 没有核对评论的关闭算不合规。
        const commentOk = items.some((i) => i.step === 'comment' && i.status === 'ok')
        if (a.close === true && specClose && !commentOk) {
          fail('close', null, 'input', 'The closing check comment was not sent: by the rule a spec cannot be closed without that comment, so this step was not done. Send the comment first (pass comment in the same call), then close.')
        } else if (sc.outOfBudget()) over(a.close === true ? 'close' : 'reopen')
        else {
          const closeOpts = rawCloseReason !== '' ? { reason: rawCloseReason } : {}
          const rawState = a.close === true ? await t.close(repo, key, closeOpts, opCtx) : await t.reopen(repo, key, opCtx)
          const stateTimeout = timeoutMessage(rawState as unknown as TransportResult)
          if (stateTimeout) return timeoutReply(stateTimeout)
          const r = must(rawState)
          const stateStep = a.close === true ? 'close' : 'reopen'
          const wantState = a.close === true ? 'closed' : 'open'
          if (r && r.ok === true) {
            // 「回了 ok」不等于「这张票真的关/开了」：判据只取写后读回这一次（#790 同一类）。
            // 读回来的状态按契约是两态（三房都在归一里落成 open / closed），读不回来就不敢说已经改好。
            const canRead = typeof t.get === 'function' && !sc.outOfBudget()
            const after = canRead ? await t.get(repo, key, {}, opCtx) : null
            const readOk = !!(after && after.ok === true)
            const gotState = readOk ? String(((after.data || {}) as Record<string, unknown>).state || '').toLowerCase() : ''
            if (!readOk) {
              fail(stateStep, canRead ? after : null, 'unconfirmed', 'The write call returned success, but the read-back after the write did not come back (' + (canRead ? 'backend words: ' + String((after && after.error && after.error.message) || 'no reason given').slice(0, 160) : 'not enough quota left to read back this result') + '): whether this ticket is now ' + wantState + ' is unknown, do not assume it was changed.')
            } else if (!gotState) {
              fail(stateStep, null, 'verify', 'The write call returned success, but the ticket read back has no state field, so it cannot be judged whether this ticket is now ' + wantState + ': do not assume it was changed.')
            } else if (gotState !== wantState) {
              fail(stateStep, null, 'verify', 'The write call returned success, but the state read back is ' + gotState + ', not ' + wantState + ': do not assume it was changed.')
            } else items.push({ key: key, step: stateStep, status: 'ok' })
          } else fail(stateStep, r)
        }
      }

      // 写后真状态：能读回就读回一次，读不回来也如实说（别让 AI 以为已经确认过了）。
      // 诚实性由后端保证（本地后端在落盘前核对单例、坏了就返回失败，本层按逐项原样记失败）：本层不判后端，
      // 后端做不到的那一步在上面已经记成失败，顶层按逐项自然非成功。
      const back = (typeof t.get === 'function' && !sc.outOfBudget()) ? await t.get(repo, key, {}, opCtx) : null
      const readBack = (back && back.ok === true) ? back.data : null
      if (!readBack) notes.push('the read-back after the write did not come back (backend words: ' + String((back && back.error && back.error.message) || 'no reason given').slice(0, 160) + '): each step above was recorded from the backend answer.')
      // #1273：整票只装一份，放在 data.ticket（api 文档承诺「返回值就是写后的真状态」，工作路线也按它记账）；
      // 顶层 readBack 只放核对用的三格。以前顶层也塞整票，渲染层靠对象引用相等去重只在同进程成立，
      // 一旦经过连接、fetch 或 PTC 会话的 JSON 边界，同一张票就连正文带评论整份进上下文两遍。
      // 三格与 data.ticket 出自同一次写后回读，所以「readBack 说改成什么了」和「data.ticket 里是什么」始终一致。
      const readBackRecord = (readBack || {}) as Record<string, unknown>
      const readBackDigest = readBack ? { key: String(readBackRecord.key ?? key), state: readBackRecord.state == null ? null : String(readBackRecord.state), updatedAt: readBackRecord.updatedAt ?? null } : null
      const status = statusOfItems(items)
      if (status !== DECK_STATUS.OK) notes.push('Some steps did not go through; the reason for each is in the items above: do not treat a step that failed as already done.')
      // #1799：顶层 reason 取失败项里「最该先告诉人」的那个码（安全优先），text 说同一处，避免两处指向不同步骤。
      const failedItems = items.filter((i) => i.status !== 'ok') as Array<{ step?: string; reason?: string; code?: string }>
      const reason = status === DECK_STATUS.OK ? '' : reasonForItems(items)
      const leadFailure = failedItems.find((i) => i.code === reason) || failedItems[0] || null
      const firstFailureText = leadFailure
        ? ' The most important thing to say first is "' + String(leadFailure.step || '') + '": ' + String(leadFailure.reason || 'the backend did not give a reason').slice(0, 160)
        : ''
      return {
        value: {
          status: status,
          reason: reason,
          text: 'Ticket ' + key + ': this call covered ' + items.length + ' steps, ' + items.filter((i) => i.status === 'ok').length + ' went through.' + firstFailureText,
          data: { requested: Object.keys(wants).filter((k) => wants[k]), ticket: readBack },
          items: items,
          readBack: readBackDigest,
          notes: notes,
          touched: touched,
        },
        claimed: { requests: est.requests, points: est.points },
      }
    })
  }

  return { definition: definition, run: run }
}
