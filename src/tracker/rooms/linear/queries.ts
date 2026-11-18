/**
 * src/tracker/rooms/linear/queries.ts —— Linear 房的 GraphQL 文档（读侧）
 *
 * 文档里的每个字段名都来自 research/13-linear-write-mutations.md 引的那份 schema
 * （@linear/sdk 内置的 schema.graphql），不是照记忆写的。写侧文档在下一个切片加。
 */

/** 各处共用的一张票的字段集合（对应研究笔记 §4.4 的 IssueCore，多了 parent 与 description）。 */
export const ISSUE_CORE = `fragment LinearIssueCore on Issue {
  id
  identifier
  number
  title
  description
  url
  createdAt
  updatedAt
  state { name type }
  team { key name }
  parent { identifier }
  assignee { name displayName }
  labels { nodes { name color } }
}`

/** 身份探针：预检靠它回答「这枚凭据是谁、在哪个工作区」。 */
export const IDENTITY_QUERY = `query LinearIdentity {
  viewer { id name displayName email organization { id name urlKey } }
}`

/** 一页最多要几张：schema 的连接参数上限是 250，默认 50。 */
export const MAX_PAGE = 250

/**
 * 「谁阻塞我」的选择集：这张票的 inverseRelations（Linear 只有 blocks 一种阻塞关系，方向见 relations.ts 的头注释），
 * 每条只取关系 id 与类型、另一端票的标识符、标题与状态类型，再加 pageInfo.hasNextPage 说明这一页有没有被截断。
 * `first` 必须写出来，不能靠默认：连接默认取 50 条，而 Linear 按「每个连接乘以它的 first（缺省 50）」算复杂度，单次查询超过 10000 点整条被拒
 * （https://linear.app/developers/rate-limiting 的 Understanding query complexity，2026-11-18 核对；tests/lib/linear-complexity.ts 按这条规则估算，
 * 门禁用它卡住每条查询的上限）。写在一个函数里，是为了单票读（取满 250）与列表读（每票取少量）用同一份字段，只有页大小不同。
 */
export function blockersSelection(first: number): string {
  return 'inverseRelations(first: ' + first + ') { pageInfo { hasNextPage } nodes { id type issue { identifier title state { type } } } }'
}

/** 单票：`id` 既收 UUID 也收 ENG-123 这种标识符（schema 的 Mutation/Query 都这么收）。带阻塞者，取满一页（250），因为这是一张票。 */
export const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) { ...LinearIssueCore ${blockersSelection(MAX_PAGE)} }
}
${ISSUE_CORE}`

/**
 * 一次要这么多条评论：评论连接的页大小上限，也是宿主面板能看到的最多条数（宿主 COMMENTS_MAX 也是 200）。
 * 为什么永远取满而不是只取宿主要的那 50 条：宿主每次都从 0 要到「已加载 + 50」再切掉已加载的，需要的正是最旧的 N 条；
 * 一次请求取满，也比每点一次「加载更多」就多发一次便宜。
 * 为什么用 last 而不是 first（PR #47 评审）：Linear 的评论连接默认按创建时间、最新的在前（Orca 的集成同样这么读），
 * first: 200 取到的是最新的 200 条，超过 200 条的票就会少掉最旧的那些，而且这个窗口会随新评论移动，
 * 宿主按偏移翻页时会漏掉一条。last: 200 取列表末尾的 200 条，也就是最旧的 200 条：新评论落在另一头，窗口不动，翻页稳定。
 * 评论不超过 200 条时两种写法拿到的是同一批，所以这只改变超过 200 条的票。
 * 没有核对过的一点：「默认最新在前」来自 Orca 的注释，不是 Linear 文档（文档只说默认按 createdAt 排序，没写方向）；
 * 若方向其实相反，只有超过 200 条评论的票会拿到最新的 200 条，与改前行为相同。
 */
export const COMMENTS_FETCH_CAP = 200

/**
 * 单票带评论：与 ISSUE_QUERY 同一份票面字段，再加评论连接。评论节点只问 commentCreate 回包里已经在用的那几格
 * （id、body、createdAt、updatedAt、user 的 name 与 displayName），不多问没核对过的字段（见 normalize.ts 的 LinearCommentNode）。
 * pageInfo.hasPreviousPage 说明窗口之前还有没有评论（用 last 取时「更多」就在这一头），房间据此决定能不能报评论总数。
 */
export const ISSUE_WITH_COMMENTS_QUERY = `query LinearIssueWithComments($id: String!, $last: Int!) {
  issue(id: $id) {
    ...LinearIssueCore
    ${blockersSelection(MAX_PAGE)}
    comments(last: $last) {
      nodes { id body createdAt updatedAt user { name displayName } }
      pageInfo { hasPreviousPage }
    }
  }
}
${ISSUE_CORE}`

/** 团队键 → 团队 id 与状态表；写侧关票/重开要用状态表，读侧先拿它做归属。 */
export const TEAM_QUERY = `query LinearTeam($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { id key name states { nodes { id name type position } } }
  }
}`

/** 一页票；filter 由调用方按团队与状态拼（见 read.ts 的 buildIssuesFilter）。 */
export const ISSUES_QUERY = `query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { ...LinearIssueCore }
    pageInfo { hasNextPage endCursor }
  }
}
${ISSUE_CORE}`

/**
 * 列表每一行最多带几条「谁阻塞我」。故意取小：Linear 把嵌套连接按它的 first 乘进复杂度，单次查询超过 10000 点整条被拒，
 * 那等于面板整张列表空白。按 Linear 公布的算法（属性 0.1、对象 1、连接乘 first，缺省 50；tests/lib/linear-complexity.ts 实现，
 * 并用文档里的三个例子校准）量出来，一页 50 张：不带关系 3327 点；每行取 10 条 5132 点；每行取 25 条 7757 点；每行取 30 条 8632 点；
 * 取 50 条（或者不写 first，缺省也是 50）12132 点，会被整条拒绝。所以是 10，留出一半的余量，而且门禁会量。
 * 这些是按公布的算法估的，不是 Linear 回的 X-Complexity 响应头：真账号上看一次那个头，才是最后的证据。
 * 一行的关系超过这个数（有下一页）就不返回 blockedBy：残缺的名单被当成完整的名单读，会对一张其实被挡着的票说「可以接」。
 * 那一张票的详情里有完整的一页（250 条），所以只是地图上的卡片暂时按「不知道」处理。
 */
export const LIST_BLOCKERS_PER_TICKET = 10

/**
 * 带阻塞者的一页票：地图的子票来自快照读的这一份列表（Linear 房没有按需取子票的读），所以卡片要靠它才知道谁被挡着。
 * 与 ISSUES_QUERY 分开写，是为了不动多账号收件箱（account-read.ts）还在用的那一份：那一条不需要关系，也不该多付这份复杂度。
 */
export const ISSUES_WITH_BLOCKERS_QUERY = `query LinearIssuesWithBlockers($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { ...LinearIssueCore ${blockersSelection(LIST_BLOCKERS_PER_TICKET)} }
    pageInfo { hasNextPage endCursor }
  }
}
${ISSUE_CORE}`
