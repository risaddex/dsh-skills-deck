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
