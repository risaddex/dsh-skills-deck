// src/deck/shell/spec-close-guard.ts —— 关规格前的三道闸（#1298 T7）
// 门禁归属: tests/verify-1298-spec-close.ts
//
// 规格（spec）是与探索地图同级的顶层容器：它自己不挂父票，下面挂着实施票。只有「收口核对通过」
// 之后才允许自动关闭。核对通过 = 实施票全部关闭 + 同一次调用里带一条逐张核对结论的评论。
// 所以关闭动作前先过三道闸：
//   1) 实施票必须全部关闭，没关的逐张报出来（票号、标题、当前状态），回执里写清缺哪几张；
//   2) 实施票全关之后还必须有收口核对评论，没有这条评论的关闭算不合规；
//   3) 一张实施票都没有的空规格不算核对通过：没有可核对的东西，不能按完成态关它。
// 三道闸之外还有两条兜底：读不回这张票、读不回子票清单时都整笔拒绝——判不了就不关，
// 宁可这次没关成，也不能凭一次读失败把规格当成可以关。
//
// 这里只判、只读，不做任何写动作；回执文案与状态码由调用方（issue-patch）按结果渲染。
// 判定放在这里而不是工具入口，是为了让三条规则只有一处实现，也让它们能脱离工具单独验证。
import { childrenOf } from './edge-landing.js'
import { markerKindInHeader } from '../../shared/issue-file/src/marker.js'

/** 契约层的一行返回：成不成、数据、失败原话。形状收窄到本文件真正会读的字段。 */
type ContractReply = { ok?: boolean; data?: unknown; error?: { message?: unknown; kind?: unknown } } | null | undefined

/** 本闸只用到后端的两件事：读一张票、按父票列子票。 */
export interface SpecCloseTracker {
  get(repo: unknown, key: string, opts: Record<string, unknown>, ctx: unknown): Promise<ContractReply>
  list(repo: unknown, filter: Record<string, unknown>, ctx: unknown): Promise<ContractReply>
}

/**
 * 判定结果。四种：不是规格（照常关）、是规格且三道闸全过（可以关）、执行层超时（整笔按超时回）、
 * 判不过（整笔拒绝，rule 是机器可读的原因码，reads 是这次已经读了几次、用于记账）。
 */
export type SpecCloseGuardResult =
  | { kind: 'not-spec' }
  | { kind: 'ok' }
  | { kind: 'timeout'; message: string }
  | { kind: 'refuse'; rule: string; text: string; data: Record<string, unknown>; reads: number }

/** 执行层超时的原话；不是超时就回 null，一个字不改判。 */
function timeoutOf(reply: ContractReply): string | null {
  const e = reply && reply.error
  if (e && e.kind === 'timeout') return String(e.message || 'the execution layer did not come back')
  return null
}

/** 后端失败的原话（截短到 200 字）：回执里要带，但不能让一句超长报错占满整条回执。 */
function errorText(reply: ContractReply): string {
  return String((reply && reply.error && reply.error.message) || 'the backend gave no reason').slice(0, 200)
}

export async function specCloseGuard(input: {
  tracker: SpecCloseTracker
  repo: unknown
  key: string
  opCtx: unknown
  hasComment: boolean
}): Promise<SpecCloseGuardResult> {
  const t = input.tracker
  const key = input.key
  const rawSelf = await t.get(input.repo, key, {}, input.opCtx)
  const selfTimeout = timeoutOf(rawSelf)
  if (selfTimeout) return { kind: 'timeout', message: selfTimeout }
  if (!rawSelf || rawSelf.ok !== true) {
    const msg = errorText(rawSelf)
    return { kind: 'refuse', rule: 'spec-close-unreadable', text: 'This ticket was not read back (the backend\'s exact words: ' + msg + '): I cannot tell whether it is a plain ticket or a spec, so it is not closed. Call again once it can be read back.', data: { error: { message: msg } }, reads: 1 }
  }
  const data: Record<string, unknown> = (rawSelf.data && typeof rawSelf.data === 'object') ? rawSelf.data as Record<string, unknown> : {}
  // 判「是不是规格」两个判据取或：三个后端的归一层都按正文文件头标记把 type 标成 spec（#1403 T1 读侧统一），
  // 所以 type 是主判据；markerKindInHeader 再兜一次，是因为远端回包可能只带原始正文、或老缓存里 type 还没归一。
  // 两边同一条判据（第一个标题之前、整行精确），不会互相打架，也不会有哪家把规格读成普通票。
  const isSpec = String(data.type || '') === 'spec' || markerKindInHeader(String(data.body || '')) === 'spec'
  if (!isSpec) return { kind: 'not-spec' }

  const rawKids = await t.list(input.repo, { parentKey: key }, input.opCtx)
  const kidsTimeout = timeoutOf(rawKids)
  if (kidsTimeout) return { kind: 'timeout', message: kidsTimeout }
  if (!rawKids || rawKids.ok !== true) {
    const msg = errorText(rawKids)
    return { kind: 'refuse', rule: 'spec-close-children-unreadable', text: 'The spec tickets under this spec could not be read (the backend\'s exact words: ' + msg + '): I cannot tell whether they are all closed, so it is not closed. Call again once the list of sub-issues can be read back.', data: { error: { message: msg } }, reads: 2 }
  }
  // 规格下面只该挂实施票（#1403 口径）：认正文文件头的 ticket 标记，或者父票就是这张规格。
  // 老票可能还没有文件头标记，靠父子边认；childrenOf 在清单不带父子信息时会把整批票原样回来，
  // 这一层过滤把父票不是本规格的行剔掉，免得整批回包里的无关票把关闭闸判错。
  const children = childrenOf(Array.isArray(rawKids.data) ? rawKids.data : [], key).children.filter((c) => {
    const row = (c && typeof c === 'object') ? c as Record<string, unknown> : {}
    if (markerKindInHeader(String(row.body || '')) === 'ticket') return true
    return row.parentKey !== undefined && row.parentKey !== null && String(row.parentKey) === String(key)
  })
  if (children.length === 0) {
    return { kind: 'refuse', rule: 'spec-close-no-children', text: 'This spec has no spec tickets under it yet: with no spec tickets there is nothing to check, so it cannot be closed as complete. Add the spec tickets first (run /to-tickets), then come back and close it.', data: {}, reads: 2 }
  }
  const openKids = children.filter((c) => String(c.state) !== 'closed')
  if (openKids.length > 0) {
    const missing = openKids.map((c) => ({ key: String(c.key || ''), title: String(c.title || ''), state: String(c.state || '') }))
    return { kind: 'refuse', rule: 'spec-close-children-open', text: 'This spec still has ' + missing.length + ' spec tickets open: ' + missing.map((m) => '#' + m.key + ' (' + (m.title || 'no title') + ', currently ' + (m.state || 'unknown') + ')').join('; ') + '. A spec cannot be closed while its spec tickets are not all closed: finish what is unfinished or explain it, then come back and run the close check.', data: { missing: missing }, reads: 2 }
  }
  if (!input.hasComment) {
    return { kind: 'refuse', rule: 'spec-close-no-comment', text: 'Closing a spec requires a comment that states the check result for each spec ticket: this call carried no comment, so the close was not done (the comment and the close must come in the same call). Write the check result of every spec ticket in comment first, then call again together with close:true.', data: {}, reads: 2 }
  }
  return { kind: 'ok' }
}