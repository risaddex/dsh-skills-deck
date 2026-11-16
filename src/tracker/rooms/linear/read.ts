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
 * 这一版翻不动的筛选格（返回字段名）；空数组表示整份条件都翻成了 Linear 的 filter。
 *
 * 为什么要单独列出来：契约的 ListFilter 有七格，这一版只翻得动「状态」和「更新时间窗口」。
 * 翻不动的格子如果照旧发一个不带它的查询，回来的名单就是**没筛过**的，而调用方会当成
 * 「按我说的筛过了」—— 错的名单比失败更贵（PR #26 review 的 P2）。所以翻不动就整体报
 * unsupported，让调用方看见「这一版还不支持这个条件」，而不是拿到一堆不相关的票。
 */
export function unsupportedFilters(filter: ListFilter | undefined): string[] {
  if (!filter) return []
  const out: string[] = []
  if (filter.type) out.push('type')
  // 空数组与省略同义（#1183：都是不过滤），所以只有非空才算要求了标签。
  if (Array.isArray(filter.labels) && filter.labels.length > 0) out.push('labels')
  // null 在契约里是「只要根票」，不是「不过滤」—— 这一版两种都还拼不出来。
  if (filter.parentKey !== undefined) out.push('parentKey')
  if (Array.isArray(filter.keys) && filter.keys.length > 0) out.push('keys')
  // Linear 里没有拉取请求，`false`（只要非拉取请求）恒成立，只有 `true` 是无法满足的要求。
  if (filter.isPullRequest === true) out.push('isPullRequest')
  return out
}

/**
 * 把契约的 ListFilter 拼成 Linear 的 IssueFilter。
 *
 * 只拼翻得动的两格（状态、更新时间窗口）；其余格子由 unsupportedFilters 先挡掉，
 * 所以走到这里的条件一定是能表达的，不会出现「发了查询但筛没生效」。
 */
export function buildIssuesFilter(filter: ListFilter | undefined): Record<string, unknown> | undefined {
  if (!filter) return undefined
  const conditions: Record<string, unknown> = {}
  if (filter.state === 'open') conditions.state = { type: { nin: CLOSED_STATE_TYPES } }
  if (filter.state === 'closed') conditions.state = { type: { in: CLOSED_STATE_TYPES } }
  // 增量窗口：只要「更新时间不早于这个时刻」的票；服务端能筛就别每拍全量翻。
  if (filter.since) conditions.updatedAt = { gte: String(filter.since) }
  return Object.keys(conditions).length > 0 ? conditions : undefined
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
  // 先把翻不动的条件挡在门外：带着它们发查询，回来的名单会像「筛过了」一样交出去。
  const missing = unsupportedFilters(filter)
  if (missing.length > 0) {
    return {
      ok: false,
      error: linearError(
        ERROR_KIND.UNSUPPORTED,
        'this room cannot filter by ' + missing.join(', ') + ' yet; asking without it would answer with tickets nobody filtered',
      ),
    }
  }

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
