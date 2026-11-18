/**
 * src/tracker/rooms/linear/paging.ts —— 数票、按页取票、读预算（契约的 counts / listPage / readBudget）
 *
 * ── 为什么这三条住在一份里 ────────────────────────────────────────────────────────
 * 三条读都只回答「有多少／下一页是什么／还剩多少额度」：不返回正文、不发写请求、不写远端。
 * 它们共用的东西只有三样：Linear 连接的形状（`nodes` 加 `pageInfo`）、本房的状态与标签筛选
 * （`read.ts` 的 `buildIssuesFilter` 与 `unsupportedFilters`，#49 起标签也在其中）、以及契约那条
 * 「拿不全就整体失败」。
 *
 * ── 数票为什么要把连接翻到底，而不是数手上这一页 ───────────────────────────────────
 * 契约写得很硬：`counts` 拿不到完整的数就整体失败，**不许猜一个数**（`contract/results.ts`
 * 的 `Counts`：「任何一个拿不到就整体失败，不许猜一个数出来（界面上猜出来的数与真数长得
 * 一模一样）」）。Linear 的连接看不到 `totalCount`：它自己的 pagination 文档（2026-11-17
 * 核对 https://linear.app/developers/pagination.md）通篇只讲 `pageInfo` 的 `hasNextPage` 与
 * `endCursor`，研究笔记 §9 从 schema 摘下的 `PageInfo` 也只有四个游标字段（`endCursor`、
 * `hasNextPage`、`hasPreviousPage`、`startCursor`）；向 schema 索取一个它没有的字段，换来的是
 * 整个查询被拒，所以本房不赌这一格。于是「Linear 自己的总数」
 * 只剩一条路：沿 `pageInfo` 翻到 `hasNextPage === false` 的那一页，那时数到的就是这一份筛选
 * 口径下的全部票 —— 它与 `list` 翻到底拿到的名单是同一批，数字不会与名单打架。
 * 翻不动（有下一页却不给游标）、翻到本房的页数上限、任何一页失败，都整条失败：少报一个数
 * 等于把「不知道」写成「这么多」，比不给更糟。
 * 若某台实例的连接回包里带了非负整数的 `totalCount`（本房今天没法向 schema 索取这一格，
 * 所以正常不会出现），那是 Linear 自己的总数，直接采信、不再翻页。
 *
 * ── 按页取票为什么把排序键写死创建时间倒序 ────────────────────────────────────────
 * 契约定的（`contract/results.ts` 的 `PageResult` 头注释）：翻页期间有票被更新时，按更新时间
 * 排会让票在页与页之间挪位置、真漏掉一张；创建时间写下来就不动。Linear 的 `orderBy: createdAt`
 * 就是「新造的在前」，方向没有第二档可配。
 *
 * ── 游标原样进、原样出 ──────────────────────────────────────────────────────────
 * `nextCursor` 就是 Linear 给的 `endCursor`：本房不解析、不改写、不拼装（契约：调用方只负责
 * 原样回传）。没有下一页时给 `null`，不给空串 —— 空串会被读成「有一个游标」。
 *
 * ── 这三条不挂 provenance ────────────────────────────────────────────────────────
 * `ReadProvenance` 的组装住在 GitHub 房（`rooms/github/routing/read-result.ts`），跨房 import
 * 会被 `cross-room-import` 判红；Linear 房今天所有读都不挂这一格，这三条与它们一致。
 */
import type { Issue } from '../../contract/entities.js'
import type { ListFilter, PageOpts } from '../../contract/inputs.js'
import type { OpContext } from '../../contract/contexts.js'
import type {
  BudgetResult,
  Counts,
  CountsResult,
  PageResult,
  ReadPageResult,
  TrackerError,
} from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type GqlResult, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { MAX_PAGE } from './queries.js'
import { buildIssuesFilter, unsupportedFilters } from './read.js'
import { PAGINATION } from '../../contract/pagination.js'

/** 一页缺省几张：Linear 不传 `first` 时自己也回 50（研究笔记 §9），契约的分页口径缺省也是 50。 */

/**
 * 一次计数最多翻几页：40 页 × 250 张 = 10000 张。到这个数还翻不完就整条失败 ——
 * 少报一个数会被当成真数，而调用方（面板顶上那几个数字）没有任何办法把它与真数分开。
 */

/**
 * 按页取票的字段集：与 `queries.ts` 的 `ISSUE_CORE` 是同一份清单 **去掉 `description`**。
 * 契约说页里的行是薄片段（`PageResult`：「不带正文、不带评论」），而一张票的正文常常是整份
 * 回包里最大的一块 —— 画列表一行用不到它，点开单票详情时另有那一次取数。
 * 为什么不复用它：正文那一个字段两条路不同，共用一份就得让列表也带上它（另两房同样各留一份）。
 */
const PAGE_CORE = `fragment LinearPageCore on Issue {
  id
  identifier
  number
  title
  url
  createdAt
  updatedAt
  state { name type }
  team { key name }
  parent { identifier }
  assignee { name displayName }
  labels { nodes { name color } }
}`

/** 数一页：只问「这一页有几张、还有没有下一页」，一个正文都不取。 */
const COUNT_PAGE_QUERY = `query LinearCountPage($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes { id }
    pageInfo { hasNextPage endCursor }
  }
}`

/** 取一页：行是薄片段，游标与「还有没有下一页」跟着同一份回包回来。 */
const ISSUE_PAGE_QUERY = `query LinearIssuePage($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, orderBy: createdAt, filter: $filter) {
    nodes { ...LinearPageCore }
    pageInfo { hasNextPage endCursor }
  }
}
${PAGE_CORE}`

/** 连接回包里本文件读到的三格（计数与取票共用同一份读法，免得两处对回包的理解走样）。 */
interface ConnectionReply {
  nodes?: LinearIssueNode[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null
  /** 本房今天索取不到这一格（见文件头）；回包里真带了就采信，没带就靠 pageInfo 翻到底。 */
  totalCount?: unknown
}

/** 内层子读的结论：数出来了，或者为什么数不出来。 */
type Counted = { ok: true; count: number } | { ok: false; error: TrackerError }

/** 只认「非负整数」这一种形状：缺格、字符串、NaN、负数一律当成没拿到，绝不用别的数顶上。 */
function countOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) return null
  return value
}

/** filter.state 归一：只有 `open` / `closed` 两种收窄，其余（含缺失、认不出的值）都是「两种状态都要」（契约同一句）。 */
function narrowedState(filter: ListFilter | undefined): 'open' | 'closed' | '' {
  const state = filter && typeof filter.state === 'string' ? filter.state.trim() : ''
  return state === 'open' || state === 'closed' ? state : ''
}

/**
 * 翻不动的筛选格先挡在门外：带着它们数出来／列出来的那批票不是调用方要的那批
 * （与 `list` 同一张表 `read.ts` 的 `unsupportedFilters`，所以计数的范围和列举的范围永远一致）。
 */
function refusedFilters(missing: string[]): { ok: false; error: TrackerError } {
  return {
    ok: false,
    error: linearError(
      ERROR_KIND.UNSUPPORTED,
      'this room cannot count or page by ' + missing.join(', ') + ' yet; answering without it would answer about tickets nobody filtered',
    ),
  }
}

/**
 * 沿一条连接翻到底，数出一共有多少张（理由见文件头）。
 * `condition` 是已经拼好的 Linear IssueFilter：本函数不认状态，谁要数哪一种状态由调用方拼好递进来，
 * 这样计数与列举用的是同一个拼法（`buildIssuesFilter`），两处的名单不会漂移。
 */
async function countConnection(
  ctx: OpContext,
  account: LinearAccount,
  condition: Record<string, unknown> | undefined,
): Promise<Counted> {
  let after: string | null = null
  let counted = 0
  for (let page = 0; page < PAGINATION.linear.countMaxPages; page += 1) {
    const replied: GqlResult<{ issues?: ConnectionReply | null }> = await gql<{ issues?: ConnectionReply | null }>(ctx, account, {
      query: COUNT_PAGE_QUERY,
      variables: { first: Math.min(MAX_PAGE, PAGINATION.linear.connectionMax), after, filter: condition ?? null },
      bucket: 'read',
    })
    if (!replied.ok) return { ok: false, error: replied.error }
    const conn: ConnectionReply | null = replied.data ? replied.data.issues || null : null
    if (!conn) {
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'counts: the reply has no issues connection, so there is no number to read') }
    }
    const own = countOrNull(conn.totalCount)
    if (own !== null) return { ok: true, count: own }
    if (!Array.isArray(conn.nodes)) {
      return {
        ok: false,
        error: linearError(ERROR_KIND.PARSE, 'counts: the connection carried no nodes array, so the tickets in this page cannot be counted'),
      }
    }
    counted += conn.nodes.length
    const info: { hasNextPage?: boolean; endCursor?: string | null } | null | undefined = conn.pageInfo
    if (!info || typeof info.hasNextPage !== 'boolean') {
      return {
        ok: false,
        error: linearError(
          ERROR_KIND.PARSE,
          'counts: the connection carried no pageInfo.hasNextPage, so whether this page is the last one is unknown (refusing to answer with a partial count)',
        ),
      }
    }
    if (!info.hasNextPage) return { ok: true, count: counted }
    const nextAfter: string = String(info.endCursor || '')
    if (!nextAfter) {
      return {
        ok: false,
        error: linearError(ERROR_KIND.PARSE, 'counts: Linear says there is a next page but gave no cursor (refusing to answer with a partial count)'),
      }
    }
    after = nextAfter
  }
  return {
    ok: false,
    error: linearError(
      ERROR_KIND.UNSUPPORTED,
      'counts: this room walked ' + PAGINATION.linear.countMaxPages * MAX_PAGE + ' tickets and Linear still reports more; refusing to answer with a number that is only a lower bound',
    ),
  }
}

/**
 * 数票：只回数字不回行（契约的 counts）。
 *
 * 口径与另外两房一致：给了 `filter.state` 就只数那一种状态（另一种的数在这里是 0，不是「没读到」，
 * `total` 就是这一种的数）；没给就是「打开 + 关闭 = 全部」。两种状态是同一批票的一个划分
 * （关闭的那三个 workflow state 类型只有 `normalize.ts` 那一份清单），所以相加既不重复也不漏。
 * 两个数分两趟数：一趟数一种状态，回包与游标各走各的，不会把两批票的游标搅在一起。
 */
export async function countsOf(ctx: OpContext, account: LinearAccount, filter: ListFilter | undefined): Promise<CountsResult> {
  const missing = unsupportedFilters(filter)
  if (missing.length > 0) return refusedFilters(missing)
  const state = narrowedState(filter)
  const base = filter || {}
  if (state === 'open' || state === 'closed') {
    const only = await countConnection(ctx, account, buildIssuesFilter({ ...base, state }))
    if (!only.ok) return { ok: false, error: only.error }
    const data: Counts = state === 'closed'
      ? { open: 0, closed: only.count, total: only.count }
      : { open: only.count, closed: 0, total: only.count }
    return { ok: true, data }
  }
  const open = await countConnection(ctx, account, buildIssuesFilter({ ...base, state: 'open' }))
  if (!open.ok) return { ok: false, error: open.error }
  const closed = await countConnection(ctx, account, buildIssuesFilter({ ...base, state: 'closed' }))
  if (!closed.ok) return { ok: false, error: closed.error }
  const data: Counts = { open: open.count, closed: closed.count, total: open.count + closed.count }
  return { ok: true, data }
}

/**
 * 这一次要几行：调用方按契约算好（缺省 50、上限 200）交进来，本房再夹进自己这条连接的硬约束
 * 1..250（Linear 每个连接的上限，见 `queries.ts` 的 `MAX_PAGE`）。两条都守，是因为调用方的毛病
 * 不该变成一条会被 Linear 拒绝的查询：越界不报错，按边界给（契约：「要多了不报错，按上限给」）。
 */
/**
 * 这一次要几行：契约的缺省与上限（共享表的 limitDefault / limitMax）先夹一次，再夹进本房这条连接
 * 的硬上限 `MAX_PAGE`。`opts.limit` 是调用方真正要的行数 —— 传了就用它，不看它就会出现
 * 「要 3 行拿回 50 行、要 200 行也只拿 50 行」（PR #32 review 的 P2）。
 */
function pageSizeOf(opts: PageOpts | undefined): number {
  const asked = opts && typeof opts.limit === 'number' ? opts.limit : NaN
  const wanted = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : PAGINATION.linear.limitDefault
  // 两层上限各管一件事：对外按契约的 200 封顶，对内再收进这条连接的硬上限。
  return Math.min(wanted, PAGINATION.linear.limitMax, PAGINATION.linear.connectionMax, MAX_PAGE)
}

/**
 * 游标失效的那一句：Linear 用自己的话拒绝一个不认得的 `after`，而它的错误词表不封闭
 * （研究笔记 §9 的「Unverified」一节只点名过 `RATELIMITED` 一个），所以这里只做一件很窄的事 ——
 * 报错里提到游标时把档位换成 `not-found` 并明说「请重新加载」，让翻到第 5 页的人知道该丢掉游标
 * 重来，而不是「稍后重试」。没有游标、或报错与游标无关时原样交回。
 * 它只在失败之间换档位，永远不会把失败变成成功。
 */
function cursorFailure(cursor: string, error: TrackerError): TrackerError {
  if (!cursor || !/cursor/i.test(error.message)) return error
  return linearError(ERROR_KIND.NOTFOUND, 'listPage: the cursor is no longer valid, please reload (' + error.message + ')')
}

/**
 * 按页取票：一页行数据 + 同一口径下的总数（契约的 listPage）。
 *
 * 总数由 `countsOf` 这个子读给，不另拼一套数法：契约要求 `total` 与这一页同一个筛选口径，
 * 两处各写一份判定迟早走样（GitLab 房同一条做法）。它没拿成就没有总数，失败类别原样透传 ——
 * 一份「本页 20 张、共 ? 张」的半份回包没有读者。
 * 代价如实说：Linear 没有 totalCount，数一次就是把这一份筛选翻到底，所以每翻一页都多一趟计数；
 * 本房不缓存（缓存层在编排层）。
 */
export async function listPageOf(
  ctx: OpContext,
  account: LinearAccount,
  filter: ListFilter | undefined,
  opts: PageOpts | undefined,
): Promise<ReadPageResult> {
  const missing = unsupportedFilters(filter)
  if (missing.length > 0) return refusedFilters(missing)
  const first = pageSizeOf(opts)
  const cursor = opts && typeof opts.cursor === 'string' ? opts.cursor : ''
  const replied = await gql<{ issues?: ConnectionReply | null }>(ctx, account, {
    query: ISSUE_PAGE_QUERY,
    variables: { first, after: cursor ? cursor : null, filter: buildIssuesFilter(filter) ?? null },
    bucket: 'read',
  })
  if (!replied.ok) return { ok: false, error: cursorFailure(cursor, replied.error) }
  const conn = replied.data ? replied.data.issues : null
  if (!conn || typeof conn !== 'object') {
    return { ok: false, error: linearError(ERROR_KIND.PARSE, 'listPage: the reply has no issues connection, so there is no page to read') }
  }
  if (!Array.isArray(conn.nodes)) {
    return { ok: false, error: linearError(ERROR_KIND.PARSE, 'listPage: the connection carried no nodes array (the remote did not return the shape of this query)') }
  }
  const info = conn.pageInfo
  if (!info || typeof info.hasNextPage !== 'boolean') {
    return {
      ok: false,
      error: linearError(
        ERROR_KIND.PARSE,
        'listPage: the connection carried no pageInfo.hasNextPage, so whether there is a next page is unknown (refusing to claim either answer)',
      ),
    }
  }
  const hasNext = info.hasNextPage === true
  const endCursor = String(info.endCursor || '')
  if (hasNext && !endCursor) {
    return {
      ok: false,
      error: linearError(ERROR_KIND.PARSE, 'listPage: Linear says there is a next page but gave no cursor (refusing to pretend the last page was reached)'),
    }
  }
  const items: Issue[] = conn.nodes.map((node) => issueOf(node))
  const counted = await countsOf(ctx, account, filter)
  if (!counted.ok) return { ok: false, error: counted.error }
  const page: PageResult = { items, nextCursor: hasNext ? endCursor : null, total: counted.data.total }
  return { ok: true, data: page }
}

/**
 * 读预算：本房今天只能诚实说「没量过」。
 *
 * 为什么不是一个数：模块声明的口径是「只计请求」（`index.ts` 的 `budget`），要读的数是
 * `X-RateLimit-Requests-Limit` / `-Remaining` / `-Reset` 这三个响应头（研究笔记 §9 的 S4 一节）。
 * 而本房唯一的请求出口 `client.ts` 只把回包正文交回来、不交响应头；要读头就得在这里另写一层
 * 请求，那一笔出站与房间其余读走的不是同一条路，也没有任何人为它记账。
 *
 * 为什么不能顺手量一下：`readBudget` 是唯一一条被刻意放在裁决与记账之外的操作
 * （`contract/operations.ts`：「记账则等于『看额度这件事自己花额度』」）。它自己发的请求没人记账，
 * 用一次看不见的花费换一个看得见的数字，比不给数字更不诚实。
 *
 * 为什么是 `not-measured` 而不是 0、也不是 `unavailable`：0 会被裁决读成「额度用完」而拦下写操作；
 * `unavailable` 意思是「量了、失败了」，这一条根本没量。Linear 的花费以 complexity 表达
 * （响应上的 `X-Complexity`，一次查询花掉多少点），不是一个本房读得到的配额数，所以点数这一桶
 * 本房根本不记账 —— 模块声明里的 `countsPoints: false` 说的就是这件事。
 *
 * 与契约 `Tracker.readBudget(ctx)` 同一形状：读数不针对某个仓库，也不针对某一本账，所以不收仓库引用；
 * 它也刻意不收账号 —— 今天一个请求都不发，收一个账号只会让人以为这里偷偷量过。
 */
export async function readBudgetOf(_ctx: OpContext): Promise<BudgetResult> {
  return { ok: true, data: { known: false, reason: 'not-measured' } }
}
