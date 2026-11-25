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
import { CLOSED_STATE_TYPES, commentOf, issueOf, type LinearCommentNode, type LinearIssueNode } from './normalize.js'
import { COMMENTS_FETCH_CAP, ISSUE_QUERY, ISSUE_WITH_COMMENTS_QUERY, ISSUES_WITH_BLOCKERS_QUERY, MAX_PAGE } from './queries.js'
import { incomingBlocks, refOf, type RelationConnection } from './relations.js'


/**
 * 这一趟要几张：契约的 ListFilter 不带页大小，页大小由房间自己定。
 * 取 schema 的默认值 50（研究笔记 §9：不传 first 时默认 50），并且不越过连接上限 250。
 */
const PAGE_SIZE = Math.min(50, MAX_PAGE)

/** 本房里一张票成为地图的唯一依据是这个标签；契约的 `type: 'map'` 翻成它（#89，见 labelNamesOf）。 */
const MAP_TYPE_LABEL = 'wayfinder:map'

/**
 * 这一版翻不动的筛选格（返回字段名）；空数组表示整份条件都翻成了 Linear 的 filter。
 *
 * 为什么要单独列出来：契约的 ListFilter 有七格，这一版翻得动「状态」「标签」和「更新时间窗口」。
 * 翻不动的格子如果照旧发一个不带它的查询，回来的名单就是**没筛过**的，而调用方会当成
 * 「按我说的筛过了」—— 错的名单比失败更贵（PR #26 review 的 P2）。所以翻不动就整体报
 * unsupported，让调用方看见「这一版还不支持这个条件」，而不是拿到一堆不相关的票。
 *
 * 标签（#49）已经从这张表里拿掉：它由 `buildIssuesFilter` 翻成 Linear 自己的 `labels` 条件，
 * 列表、计数与按页取票走同一个拼法，所以不会再出现「发了查询但标签筛没生效」。
 */
export function unsupportedFilters(filter: ListFilter | undefined): string[] {
  if (!filter) return []
  const out: string[] = []
  // `type: 'map'` 能翻成标签条件（#89，见 MAP_TYPE_LABEL），所以不在此列；别的类型（spec 要读正文标记，issue 是「其余」）仍翻不动，照旧整体拒绝。
  if (filter.type && filter.type !== 'map') out.push('type')
  // null 在契约里是「只要根票」，不是「不过滤」—— 这一版两种都还拼不出来。
  if (filter.parentKey !== undefined) out.push('parentKey')
  if (Array.isArray(filter.keys) && filter.keys.length > 0) out.push('keys')
  // Linear 里没有拉取请求，`false`（只要非拉取请求）恒成立，只有 `true` 是无法满足的要求。
  if (filter.isPullRequest === true) out.push('isPullRequest')
  return out
}

/**
 * 契约的 `labels` 归一成「要带的标签名」：去掉首尾空白、丢掉空名、按大小写不敏感去重，保持原顺序
 * （同一个名字写两种大小写不会变成两条条件，发出去的是第一次出现的写法）。
 * 空数组、省略、全是空名，都归一成空名单，也就是「不筛标签」（契约：空数组与省略相同，#1183）。
 */
function labelNamesOf(filter: ListFilter): string[] {
  const asked: unknown[] = Array.isArray(filter.labels) ? [...filter.labels] : []
  // `type: 'map'` 就是地图标签（#89）：本房里「是不是地图」只由标签决定（normalize.ts 的 issueTypeOf；只有 spec 才读正文），
  // 所以要 `type: 'map'` 与要这个标签是同一个问题。并进同一份名单，下面的去重保证调用方已经带了同一标签时不会拼出重复条件。
  // 反例：对 `spec`、`issue` 不成立（那两种由 unsupportedFilters 继续拒绝），别照这个写法给它们也加翻译。
  if (filter.type === 'map') asked.push(MAP_TYPE_LABEL)
  if (asked.length === 0) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of asked) {
    const name = String(raw === undefined || raw === null ? '' : raw).trim()
    const folded = name.toLowerCase()
    if (!name || seen.has(folded)) continue
    seen.add(folded)
    names.push(name)
  }
  return names
}

/**
 * 把标签名单翻成 Linear 的 `IssueFilter.labels` 条件。
 *
 * 多个标签是「必须同时带上」（契约的 `ListFilter.labels` 写明的口径，GitLab 房也是把标签交给远端按 AND 筛）：
 * 所以多个标签写成 `labels.and` 下的多条 `some`，每条 `some` 各自命中一个标签。Linear 的 schema 明说
 * 「Different some branches can be satisfied by different labels」。**不能**写成一条 `some.name.in`：
 * `in` 是「命中任何一个」，会把只带其中一个标签的票也算进来，名单就比调用方要的宽。
 * 名字用 `eqIgnoreCase` 比，与本房账号读（`account-read.ts`，按小写比）一致，不让大小写写法决定一张票进不进名单。
 */
function labelsCondition(names: string[]): Record<string, unknown> {
  const some = (name: string) => ({ some: { name: { eqIgnoreCase: name } } })
  return names.length === 1 ? some(names[0]) : { and: names.map(some) }
}

/**
 * 把契约的 ListFilter 拼成 Linear 的 IssueFilter。
 *
 * 拼三格：状态、标签、更新时间窗口。列表、计数、按页取票都从这一个函数拿条件，
 * 所以一次计数与它所描述的那一页永远指同一批票；其余格子由 unsupportedFilters 先挡掉，
 * 所以走到这里的条件一定是能表达的，不会出现「发了查询但筛没生效」。
 */
export function buildIssuesFilter(filter: ListFilter | undefined): Record<string, unknown> | undefined {
  if (!filter) return undefined
  const conditions: Record<string, unknown> = {}
  if (filter.state === 'open') conditions.state = { type: { nin: CLOSED_STATE_TYPES } }
  if (filter.state === 'closed') conditions.state = { type: { in: CLOSED_STATE_TYPES } }
  // 增量窗口：只要「更新时间不早于这个时刻」的票；服务端能筛就别每拍全量翻。
  if (filter.since) conditions.updatedAt = { gte: String(filter.since) }
  // 标签只在归一后非空时才带上：远端对空条件的反应各版本不一（契约同一句）。
  const names = labelNamesOf(filter)
  if (names.length > 0) conditions.labels = labelsCondition(names)
  return Object.keys(conditions).length > 0 ? conditions : undefined
}

/**
 * 把「谁阻塞我」挂到契约的票上（#45）。三种结局要分清：
 *  · 回包里没有关系连接（这次没问，或旧回包）：不写 blockedBy，是「不知道」，不是「没有阻塞者」；
 *  · 有连接且这一页就是全部：写 blockedBy，没有阻塞者时是空数组（知道是空）；
 *  · 有连接但被页大小截断（pageInfo.hasNextPage）：同样不写。残缺的名单被当成完整的名单读，会对一张其实被挡着的票说「可以接」，
 *    比不知道更糟；不知道至少诚实。单票读取满 250，所以只有关系多到 250 条以上的票才会走到这里。
 * 只认 blocks 类型、标题与状态按读到的真值给，这些规则住在 relations.ts 的 incomingBlocks 与 refOf（写侧共用同一份，不再抄第二份）。
 * 导出是为了 sub-issues.ts（#50）：按父票取子票读的是同一种带阻塞者的票节点，三种结局的判法只许有这一份。
 */
export function withBlockers(issue: Issue, node: { inverseRelations?: RelationConnection | null }): Issue {
  const conn = node.inverseRelations
  if (!conn) return issue
  if (conn.pageInfo && conn.pageInfo.hasNextPage === true) return issue
  issue.blockedBy = incomingBlocks(node).map(refOf)
  return issue
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
  // 契约的 opts.comments.first 是「要几条」；没要（缺省、0、不是正数）就不问评论，票上也不挂 comments 字段：
  // 缺字段是「没读」，空数组才是「读了、没有」，面板据此分得清「评论加载中」与「没有评论」。
  const wanted = opts && opts.comments && typeof opts.comments.first === 'number' ? Math.floor(opts.comments.first) : 0
  const withComments = wanted > 0
  const result = await gql<{ issue: (LinearIssueNode & { inverseRelations?: RelationConnection | null; comments?: { nodes?: LinearCommentNode[] | null; pageInfo?: { hasPreviousPage?: boolean } | null } | null }) | null }>(ctx, account, {
    query: withComments ? ISSUE_WITH_COMMENTS_QUERY : ISSUE_QUERY,
    variables: withComments ? { id: trimmed, last: COMMENTS_FETCH_CAP } : { id: trimmed },
    bucket: 'read',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const node = result.data.issue
  if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no ticket ' + trimmed) }
  const issue = withBlockers(issueOf(node), node)
  if (!withComments) return { ok: true, data: issue }
  // Linear 回的是最新的在前；宿主要的是「最旧的 N 条、按时间升序」（它每次从 0 取到 N 再切掉已加载的），与 linear.app 的显示也一致。
  // 时间是 ISO 字符串，同一时区下按字符串比就是按时间比；同一时刻的两条保持 Linear 给的相对顺序（Array.sort 稳定）。
  const nodes = (node.comments && Array.isArray(node.comments.nodes) ? node.comments.nodes : []).filter(function (c) { return !!c })
  const all = nodes.slice().sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) })
  issue.comments = all.slice(0, wanted).map(commentOf)
  // 总数只在「这一批就是全部」时才报：Linear 说窗口之前还有评论（超过取满的 200 条）就不报，面板不会把一个下限当成总数。
  // 「还有更多」这个事实照实传下去（commentsHasMore），不传数字：宿主据此在总数未知时仍给出「加载更多」，又不会把下限当总数。
  // 窗口是最旧的 200 条（见 queries.ts 的 COMMENTS_FETCH_CAP），所以这一批的内容不随新评论变化，宿主按偏移翻页是稳的。
  if (node.comments && node.comments.pageInfo && node.comments.pageInfo.hasPreviousPage === true) issue.commentsHasMore = true
  else issue.commentCount = all.length
  return { ok: true, data: issue }
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
    issues: { nodes?: (LinearIssueNode & { inverseRelations?: RelationConnection | null })[]; pageInfo?: { hasNextPage?: boolean } }
  }>(ctx, account, {
    query: ISSUES_WITH_BLOCKERS_QUERY,
    variables: { first, filter: buildIssuesFilter(filter) ?? null },
    bucket: 'read',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const nodes = result.data.issues?.nodes || []
  // 每一行带它自己的阻塞者（页大小见 queries.ts 的 LIST_BLOCKERS_PER_TICKET）；关系比这一页还多的行不带 blockedBy，见 withBlockers。
  const issues: Issue[] = nodes.map((node) => withBlockers(issueOf(node), node))
  const truncated = result.data.issues?.pageInfo?.hasNextPage === true
  return truncated ? { ok: true, data: issues, truncated } : { ok: true, data: issues }
}
