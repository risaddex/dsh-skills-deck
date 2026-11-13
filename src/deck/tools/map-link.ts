// src/deck/tools/map-link.ts —— deck_map_link（#713 第六批；#1019 换到新树、#1035 转 TypeScript）
//
// 给**已经存在**的票补边或改边：父子和阻塞两种，逐条做、逐条校验。
// 「每条边在返回里标出落点」就落在这里：写完之后读回一次那张票，按它自己的结构字段与正文判，
// 判不出来就说「说不好」，绝不默认写成「原生层级」（判据与反证方向见 edge-landing.ts 的 classifyEdgeLanding）。
// 校验用计数：改完按父票列一遍子票 / 再读一次依赖，把「要几条、实际几条」对一次，对不上就说 partial。
import { createDeckShell, DECK_STATUS, REFUSAL_REASONS } from '../shell/call-shell.js'
import { MD_SCOPE_LOCATE, applyMdScope, mdScopeNote } from './md-scope.js'
import { sessionContextOfAsync } from '../shell/session-workdir.js'
import { callDeckSession, openDeckSession } from './tracker-session.js'
import { classifyEdgeLanding, edgeEvidence, failureFields, statusOfItems, applyParentEdge, applyBlockEdges, precheckBlockBatch } from '../shell/edge-landing.js'
// #1799：非 ok 回执的 reason 只从 receipt-reason 来；逐项保留映射码与后端 kind/stage 证据。
import { worstReason } from '../shell/receipt-reason.js'
import type { LocalFailureCause } from '../shell/receipt-reason.js'
import { estimateToolCost, toolCostInputFrom } from '../../refresh/kernel/tool-call-budget.js'
import { withCallScope } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'
import { withKeyLock } from '../shell/write-mutex.js'
// 超时住中央 YAML，调时间改 config/timeouts.yaml。
import { DECK_SANDBOX_TIMEOUT_MS } from '../../shared/time-config/src/values.js'
import { withCap } from '../shell/capped-wait.js'

/** 数字型参数的统一收口：正的有限数才要（取整），其余一律当「没给」，由调用方退自己的默认。 */
function numOpt(v: unknown): number | undefined { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : undefined }
// 沙箱许可等待上限见 ../shell/capped-wait.ts（#1114 第二批）：到点就按「没等到」处理并清掉等待定时器；
// 超时按缺席走老路（不限权），与既有 catch null 同形。

/**
 * 装配层注入的依赖袋。壳要用的键原样透传（没列的键也一律接受：壳自己还没标类型，这一层不替它把关）；
 * 列出来的是本工具自己会读的那几个，缺席时各自退默认：没有沙箱策略就跳过那一步等待，没有时钟就用 Date.now。
 */
export interface DeckMapLinkDeps {
  readonly [key: string]: unknown
  /** 沙箱许可策略：给工作区与会话，回这一轮的策略快照；两个值原样传，可能还没有。 */
  sandboxPolicyFor?: (arg: { cwd: string | undefined; sessionId: string | undefined }) => Promise<unknown>
  /** 时钟旁路：测试里换假时钟用，缺省 Date.now。 */
  now?: () => number
}

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_map_link',
  description: 'The ISSUE and map management of the dsh-skills-deck plugin; it only handles the repo of the current workspace. Before touching an ISSUE, call deck_context to confirm the workspace and backend, and stop if it says there is no backend. Add parent or blockedBy edges to an existing ISSUE; after writing, read back and mark the landing of each edge.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The ticket to change (a sub-issue)' },
      parentKey: { type: 'string', description: 'The parent ticket to attach to; leave it out to leave the parent unchanged' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'Which tickets block this ticket (replaces the whole set)' },
      edges: {
        type: 'array',
        description: 'Change the edges of several tickets at once; use either this or key/parentKey/blockedBy',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, parentKey: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'string' } } },
          required: ['key'],
          additionalProperties: false,
        },
      },
      ...MD_SCOPE_LOCATE,
    },
    additionalProperties: false,
  },
}

/** 把一处边目标列出来：不是数组就当空表，逐项转成字符串并丢掉空值（读的是运行时真值，形状不细究）。 */
function asList(v: unknown) {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []
}

/**
 * 一条阻塞边写完之后读回来的结果：landed 是读回来的全集，after 是读回的原文（给重复项补明细用），
 * failed 非空表示写这一步就没成，readOk 说「写后读回这一步自己成没成」——读失败时 landed 是空的，
 * 但那是「没读到」，不是「读回来了、里面没有」，给重复项补明细时必须照它分开说（#790）。
 */
type EdgeReadback = {
  landed: unknown[]
  after: { issue: unknown; dependencies: unknown }
  failed: { kind?: string; ok?: boolean; text?: string } | null
  readOk: boolean
  /** 写这一步失败时那一条的映射证据（重复项补明细时照抄，别让同一批里两种说法）。 */
  code?: string
  errorKind?: string
  stage?: string
}

/**
 * 同一张票那一组边做完之后攒下来的东西。items / notes / touched 里装的都是运行时真值
 * （每一行的形状由下面各处现拼，这里不细究），readback 是那条阻塞边写完之后读回来的结果，
 * 没写过就是 null。
 */
type EdgeGroupOut = {
  items: Array<Record<string, unknown>>
  notes: string[]
  touched: string[]
  done: number
  readback: EdgeReadback | null
}

/**
 * 装配层调一次，拿到这对 { definition, run }。deps 是宿主注入的依赖袋（见 DeckMapLinkDeps），
 * 什么都不给也能跑：壳与这里的每一处都各自退默认。
 */
export function createDeckMapLink(deps?: DeckMapLinkDeps) {
  const d: DeckMapLinkDeps = deps || {}
  const shell = createDeckShell(Object.assign({}, d, {
    estimate: d.estimate || estimateToolCost,
    costInputFrom: d.costInputFrom || toolCostInputFrom,
  }))

  /**
   * 跑一次：exec 是 DSH 给的执行上下文（会话与沙箱都从它取），args 是模型填的参数。
   * 参数先当「未知」再逐项收口（key / edges / effort / feature 下面各收一次），回执形状由壳统一渲染。
   * exec 上只声明本文件真正会读的那个字段（取消信号），其余字段一律不碰、照旧整只交给壳，
   * 所以下面取 signal 的地方不必写一串断言。
   */
  async function run(exec: { signal?: unknown } | null | undefined, args: Record<string, unknown>): Promise<unknown> {
    // 预算起算点：入口前耗时（会话归一、选后端、探沙箱）也要算进预算（#1195）。
    const toolEntryAt = (typeof d.now === 'function') ? d.now() : Date.now()
    const a: Record<string, unknown> = args || {}
    const est = shell.estimateFor('deck_map_link', a)
    if (Object.prototype.hasOwnProperty.call(a, 'workRouteDetail') && a.workRouteDetail !== undefined) return shell.unsupported('deck_map_link', REFUSAL_REASONS.BAD_ARGS, 'The workRouteDetail parameter is retired (#1561): the work board no longer comes back inside write receipts; to see it, call deck_work_route (by default it only covers work from the last 24 hours; pass includeStale:true for the last 30 days). Nothing was done this time: no backend was selected, no points were spent, and nothing was written to disk.', { cost: { estimated: est } })
    const s = await sessionContextOfAsync(exec, { canonicalKey: d.canonicalKey, workspaceKeyOf: d.workspaceKeyOf })
    // 会话没解析出来时回的是「为什么」那一支。编译器分不出两支（ok 在会话壳里是运行时布尔，
    // 那一层还没标类型，见 #1040），所以这里按形状取 reason —— 取到的值与老写法逐字相同。
    if (!s.ok) return shell.unsupported('deck_map_link', (s as { reason: string }).reason, s.text, { cost: { estimated: est } })
    const jobs = Array.isArray(a.edges) && a.edges.length ? a.edges : (a.key ? [a] : [])
    if (!jobs.length) return shell.unsupported('deck_map_link', REFUSAL_REASONS.BAD_ARGS, 'Which ticket edges to change: give key (optionally with parentKey / blockedBy), or give an edges list.', { cost: { estimated: est } })
    const pick = await openDeckSession({ deps: d, exec: exec, session: s, estimate: est, tool: 'deck_map_link', kind: 'write' })
    if (!pick.ok) return shell.unsupported('deck_map_link', pick.reason, pick.text, { workspace: { root: s.cwd, key: s.workspaceKey }, cost: { estimated: est } })
    const repo = shell.repoOf(pick, s)
    const scope = applyMdScope(repo, a)
    if (!scope.ok) return shell.unsupported('deck_map_link', REFUSAL_REASONS.BAD_ARGS, scope.message, { cost: { estimated: est } })

    // exec 上那个取消信号。契约层还没给 exec 标形状（见 #1040），三处 exec.signal 各按纯类型断言收口：
    // 取值表达式一字不动，所以转译出来的 JS 与转换前逐字节一致。
    return callDeckSession({ deps: d, opened: pick, session: s, repo: repo, estimate: est, tool: 'deck_map_link', sandbox: (await (async function () { try { if (typeof d.sandboxPolicyFor !== 'function') return null; const raced = await withCap(d.sandboxPolicyFor({ cwd: s.cwd, sessionId: s.sessionId }), DECK_SANDBOX_TIMEOUT_MS); return (raced && raced.ok === true) ? raced.value : null } catch (eS) { return null } })()), signal: (exec && exec.signal && typeof exec.signal === 'object') ? exec.signal : undefined }, async (c: unknown) => {
      const sc = withCallScope(c, exec, { timeoutMs: numOpt(d.toolTimeoutMs), marginMs: numOpt(d.toolMarginMs), startedAt: toolEntryAt, now: (typeof d.now === 'function') ? d.now : Date.now })
      // 走到这里 tracker 一定在（预算壳自己的约定：能进这一段就是选好后端了）；
      // 断言只为让编译器安静，运行时一个字节都不动 —— 真为空时下面那句照样抛 TypeError 走 backend-threw。
      const t = sc.tracker!
      const opCtx = sc.opCtx
      // 逐条明细与给 AI 看的注记：装的都是运行时真值（每一行的形状由下面各处现拼，这里不细究）。
      const items: Array<Record<string, unknown>> = []
      const notes: string[] = []
      if (scope.effortId) notes.push(mdScopeNote(scope.scene, scope.effortId))
      const touched: string[] = []
      let done = 0
      // #898：设置阻塞边是整批替换语义，同一个票号在一次调用里出现多次时，
      // 先把它的阻塞目标合并成完整集合再写一次，否则后一次写会删掉前一次的边。
      // 跨次调用仍按整批替换：以每一次调用的完整集合为准。
      const mergedBlocked = new Map()
      for (const job of jobs) {
        if (job.blockedBy !== undefined && job.blockedBy !== null) {
          const k = String((job && job.key) || '').trim()
          if (!k) continue
          if (!mergedBlocked.has(k)) mergedBlocked.set(k, [])
          const arr = mergedBlocked.get(k)
          for (const target of asList(job.blockedBy)) if (arr.indexOf(target) < 0) arr.push(target)
        }
      }
      // 同一张票的边组内逐条写（同时写同一张票会丢一次改动），不同票的组同时写。
      const keyOrder = []
      const jobsByKey = new Map()
      for (const job of jobs) {
        const k = String((job && job.key) || '').trim()
        if (!k) { items.push(Object.assign({ key: '', status: 'failed', reason: 'One item in edges has no key.' }, failureFields(null, 'write', 'input'))); continue }
        if (!jobsByKey.has(k)) { jobsByKey.set(k, []); keyOrder.push(k) }
        jobsByKey.get(k).push(job)
      }
      // #929：写任何一条边之前先整批过一遍成环预检。逐组的写前检查读的是已经落盘的图，看不见同批里
      // 还没落盘的边 —— 两条互指的边同批发出时两边都会通过、盘上留下环（已用真件复现）。
      // 预检只读一次整图、串行算完；下面那份组间并行一个字不动。被拒的票只跳过阻塞边，父子边照旧做。
      const pre = mergedBlocked.size ? await precheckBlockBatch(t, repo, opCtx, keyOrder, mergedBlocked) : { ok: true, refused: new Map() }
      if (!pre.ok) notes.push('The whole-batch cycle precheck for this batch did not read the whole graph (the list did not come back), so only each group has its own cycle check: edges that point at each other inside the batch may still all pass.')
      const perKey = await Promise.all(keyOrder.map(async (key) => {
        const out: EdgeGroupOut = { items: [], notes: [], touched: [], done: 0, readback: null }
        // 同票分组持锁 serial：同票并发补边不再丢一次改动；不同票分组照旧并行。
        // 锁只保证“同一组内逐条”不被别笔穿插，组间并行一个字不动。
        const lockTimeoutMs = numOpt(d.keyLockTimeoutMs)
        const held = await withKeyLock(repo, key, async () => {
          for (const job of jobsByKey.get(key)) {
            if (sc.outOfBudget()) { out.items.push(Object.assign({ key: key, status: 'failed', reason: 'There is not enough quota left to send this call, so the edges of this ticket were not touched: call again with the same parameters.' }, failureFields(null, 'write', 'budget'))); continue }
          if (job.parentKey !== undefined && job.parentKey !== null) {
            const r = await applyParentEdge(t, repo, opCtx, key, String(job.parentKey))
            out.items.push(r.item)
            if (r.applied) { out.done += 1; out.touched.push(key) }
          }
          if (job.blockedBy !== undefined && job.blockedBy !== null) {
            if (pre.refused.has(key)) {
              // 整批预检说这一组边会让图成环：这条边不写，逐条如实报失败（别让 AI 当成建好了）。
              for (const target of asList(job.blockedBy)) {
                out.items.push(Object.assign({ key: key, status: 'failed' }, edgeEvidence('block', target, { kind: 'unknown', ok: false, text: 'The cycle precheck before writing refused this group of edges, so this one was not written: it wanted to add #' + target + ' to the blockedBy of ticket #' + key + ' (that is, ticket #' + key + ' blocked by #' + target + '). Precheck words: ' + String(pre.refused.get(key) || '(no reason given)') }), failureFields(null, 'write', 'input')))
              }
              continue
            }
            if (out.readback) {
              // 同一票号的阻塞边已按合并后的完整集合写过并读回过，这一重复项不再重写，
              // 按当时的读回结果为它自己的目标逐个补明细（写失败时同样逐个补失败）。
              for (const target of asList(job.blockedBy)) {
                // readOk 分开看：读失败时只能说「没读回来，判不了」，绝不许说成「这条依赖没出现在票上」（#790）。
                const hit = out.readback.readOk && !out.readback.failed && out.readback.landed.indexOf(target) >= 0
                const e2 = out.readback.failed ? out.readback.failed
                  : !out.readback.readOk ? { kind: 'unknown', ok: false, text: 'The write call returned success, but ticket ' + key + ' was not read back after the write, so the blockedBy of ' + key + ' cannot be judged: it may or may not hold ' + target + '. This group of edges was written once as the merged full set, but the read-back did not succeed, so do not treat this edge as built and do not treat it as not built (the backend words are in the first detail of this group).' }
                  : hit ? classifyEdgeLanding('block', target, out.readback.after, key)
                  : { kind: 'unknown', ok: false, text: 'Read-back after the write: ticket ' + key + ' does not hold ' + target + ' (what came back was ' + (out.readback.landed.join(', ') || 'empty') + ')' }
                // 重复项也要带证据：同一批里第一条明细有分类、后面几条只有「判不了」会让人不知道该信哪条。
                let ev: Record<string, string> | undefined
                if (!hit) {
                  // 失败对象就在手边，重新过一遍同一张映射表；不抄现成码、也不猜默认码。
                  if (out.readback.failed) ev = failureFields(out.readback.failed, 'write')
                  else if (!out.readback.readOk) ev = failureFields(null, 'read', 'unconfirmed')
                  else ev = failureFields(null, 'write', 'verify')
                }
                out.items.push(Object.assign({ key: key, status: hit ? 'ok' : 'failed' }, edgeEvidence('block', target, e2), ev))
                if (e2.ok) { out.done += 1; out.touched.push(key) }
              }
            } else {
              const want = mergedBlocked.get(key) || asList(job.blockedBy)
              const r = await applyBlockEdges(t, repo, opCtx, key, want, asList(job.blockedBy))
              if (r.failed) {
                // 整批写失败时 r.failed 是这次失败的原对象：过同一张映射表出证据，不抄第一项、也不猜默认码。
                const ev = failureFields(r.failed, 'write')
                out.items.push(Object.assign({ key: key, status: 'failed' }, edgeEvidence('block', want.join(', '), r.failed), ev))
                out.readback = { landed: [], after: { issue: null, dependencies: null }, failed: r.failed, readOk: false, code: ev.code, errorKind: ev.errorKind, stage: ev.stage }
              } else {
                for (const item of r.items) {
                  out.items.push(item)
                  if (item.status === 'ok') { out.done += 1; out.touched.push(key) }
                }
                const extra = r.landed.filter((k) => want.indexOf(k) < 0)
                if (extra.length) out.notes.push('Ticket ' + key + ' also has blocking edges that were not planned: ' + extra.join(', ') + ' (setBlockedBy replaces the whole set, yet the backend kept them; read it back and check once).')
                out.readback = { landed: r.landed, after: r.after, failed: null, readOk: r.readOk }
              }
            }
          }
          }
          }, { timeoutMs: lockTimeoutMs })
          if (held && held.ok === false && held.timedOut) {
            // 锁没等到：这组一条没动，逐条诚实记（形状与预检拒绝同形，调用方照既有路续跑）。
            const lockText = 'Ticket ' + key + ' is being changed by another call right now, so nothing was changed: call again with the same parameters in a moment.'
            for (const job of jobsByKey.get(key)) {
              if (job.parentKey !== undefined && job.parentKey !== null) {
                out.items.push(Object.assign({ key: key, status: 'failed' }, edgeEvidence('parent', String(job.parentKey), { kind: 'unknown', ok: false, text: lockText }), failureFields(null, 'write', 'lock')))
              }
              for (const target of asList(job.blockedBy)) {
                out.items.push(Object.assign({ key: key, status: 'failed' }, edgeEvidence('block', target, { kind: 'unknown', ok: false, text: lockText }), failureFields(null, 'write', 'lock')))
              }
            }
          }
          return out
        }))
      for (const r of perKey) {
        for (const i of r.items) items.push(i)
        for (const n of r.notes) notes.push(n)
        for (const k of r.touched) touched.push(k)
        done += r.done
      }
      const status = statusOfItems(items)
      if (status !== DECK_STATUS.OK) notes.push('Some edges were not built; the reason for each is in the items above: do not treat them as built.')
      // #1799：顶层 reason 由逐条失败项的映射码汇总（取最该先告诉人的那一个），不是「有失败就一律 backend-unsupported」。
      const failedItems = items.filter((i) => i && i.status !== 'ok') as Array<{ code?: unknown }>
      // 每个失败项都带 code（上面逐条用 evidenceOf / failureFields 记下的映射码），所以这里不再手写兜底字面量：
      // 真有哪条漏了证据，宁可回空串让门禁暴露，也不把「不知道」写成 backend-unsupported。
      const reason = status === DECK_STATUS.OK ? '' : worstReason(failedItems.map((i) => String((i && i.code) || '')))
      // #790：顶层一句话要带失败摘要，不只报计数。原因原文仍在逐条 items 的 evidence 里，这里只摘要。
      let text = 'This call asked for ' + items.length + ' edges, and ' + done + ' were built.'
      const failed = items.filter((i) => i && i.status !== 'ok')
      if (failed.length) {
        const sums = failed.map((i) => {
          const t = String((i && i.target) || '')
          const e = String((i && i.evidence) || (i && i.reason) || '')
          return String((i && i.key) || '?') + '→' + t + ': ' + e.slice(0, 120)
        })
        text += ' ' + failed.length + ' edges failed: ' + sums.join('; ').slice(0, 800)
      }
      return {
        value: {
          status: status,
          reason: reason,
          text: text,
          data: { requested: items.length, done: done, jobs: jobs },
          items: items,
          notes: notes,
          touched: touched,
        },
        claimed: { requests: est.requests, points: est.points },
      }
    })
  }

  return { definition: definition, run: run }
}
