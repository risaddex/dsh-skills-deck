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

/** 单票：`id` 既收 UUID 也收 ENG-123 这种标识符（schema 的 Mutation/Query 都这么收）。 */
export const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) { ...LinearIssueCore }
}
${ISSUE_CORE}`

/**
 * 一次要这么多条评论：评论连接的页大小上限，也是宿主面板能看到的最多条数（宿主 COMMENTS_MAX 也是 200）。
 * 为什么永远取满而不是只取宿主要的那 50 条：Linear 的评论连接没有升序参数，回来的是最新的在前，
 * 「最旧的 N 条」只能从整批里挑；宿主每次都从 0 要到「已加载 + 50」再切掉已加载的，需要的正是最旧的 N 条。
 * 一次请求取满，也比每点一次「加载更多」就多发一次便宜。
 */
export const COMMENTS_FETCH_CAP = 200

/**
 * 单票带评论：与 ISSUE_QUERY 同一份票面字段，再加评论连接。评论节点只问 commentCreate 回包里已经在用的那几格
 * （id、body、createdAt、updatedAt、user 的 name 与 displayName），不多问没核对过的字段（见 normalize.ts 的 LinearCommentNode）。
 * pageInfo.hasNextPage 说明有没有比这一批更多的评论，房间据此决定能不能报评论总数。
 */
export const ISSUE_WITH_COMMENTS_QUERY = `query LinearIssueWithComments($id: String!, $first: Int!) {
  issue(id: $id) {
    ...LinearIssueCore
    comments(first: $first) {
      nodes { id body createdAt updatedAt user { name displayName } }
      pageInfo { hasNextPage }
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

/** 一页最多要几张：schema 的连接参数上限是 250，默认 50。 */
export const MAX_PAGE = 250
