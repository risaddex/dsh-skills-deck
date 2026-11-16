/**
 * src/tracker/rooms/linear/read.ts —— 读侧两个操作：取一张票、列一页票
 *
 * 这一层只管「问什么、怎么拼」；发请求在 client.ts，翻译在 normalize.ts。
 * 两件事在这里刻意不做：
 *   · 不把失败当空结果 —— 契约要求拿不全就整体失败，不许猜；
 *   · 不自己判额度 —— 出站名额与冷却在通道与闸那一层，这里只说这一次是读。
 */
import type { Issue } from '../../contract/entities.js'
import type { IssueDetailResult, IssueListResult } from '../../contract/results.js'
import type { GetOpts, ListFilter } from '../../contract/inputs.js'
import type { OpContext } from '../../contract/contexts.js'
import { gql, type LinearAccount } from './client.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { linearError } from './errors.js'
import { CLOSED_STATE_TYPES, issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_QUERY, ISSUES_QUERY, MAX_PAGE } from './queries.js'


/**
 * 这一趟要几张：契约的 ListFilter 不带页大小，页大小由房间自己定。
 * 取 schema 的默认值 50（研究笔记 §9：不传 first 时默认 50），并且不越过连接上限 250。
 */
const PAGE_SIZE = Math.min(50, MAX_PAGE)

/**
 * 把契约的 ListFilter 拼成 Linear 的 IssueFilter。
 *
 * 只翻「状态」这一格：其余条件（标签、指派人、关键字）等对应读路径实现时再加，
 * 现在硬塞一个猜出来的映射，读回来的名单会悄悄不对。
 */
export function buildIssuesFilter(filter: ListFilter | undefined): Record<string, unknown> | undefined {
  const state = filter && filter.state
  if (state === 'open') return { state: { type: { nin: CLOSED_STATE_TYPES } } }
  if (state === 'closed') return { state: { type: { in: CLOSED_STATE_TYPES } } }
  return undefined
}

/** 取一张票。key 既可以是 UUID，也可以是 ENG-123 这种标识符（Linear 两者都收）。 */
export async function getIssue(
  ctx: OpContext,
  account: LinearAccount,
  key: string,
  opts?: GetOpts,
): Promise<IssueDetailResult> {
  const trimmed = String(key || '').trim()
  if (!trimmed) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'no ticket key was given') }
  const result = await gql<{ issue: LinearIssueNode | null }>(ctx, account, {
    query: ISSUE_QUERY,
    variables: { id: trimmed },
    bucket: 'read',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const node = result.data.issue
  if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no ticket ' + trimmed) }
  // 评论要单独一条连接去读；opts.comments 这一格等评论读路径实现时再兑现，现在如实不挂 commentCount。
  return { ok: true, data: issueOf(node) }
}

/** 列一页票。这一版只翻一页：翻页要游标，等 listPage 落地时统一做，别在这里各写一套。 */
export async function listIssues(
  ctx: OpContext,
  account: LinearAccount,
  filter?: ListFilter,
): Promise<IssueListResult> {
  const first = PAGE_SIZE
  const result = await gql<{
    issues: { nodes?: LinearIssueNode[]; pageInfo?: { hasNextPage?: boolean } }
  }>(ctx, account, {
    query: ISSUES_QUERY,
    variables: { first, filter: buildIssuesFilter(filter) ?? null },
    bucket: 'read',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const nodes = result.data.issues?.nodes || []
  const issues: Issue[] = nodes.map((node) => issueOf(node))
  const truncated = result.data.issues?.pageInfo?.hasNextPage === true
  return truncated ? { ok: true, data: issues, truncated } : { ok: true, data: issues }
}
