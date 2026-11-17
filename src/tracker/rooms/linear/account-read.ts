/**
 * #14：按账号读取的独立入口；旧读入口保持不变。
 * 绑定、账号元数据与身份均按本次上下文读取，绝不把上一工作区的凭据缓存到实例。
 */
import type { OpContext } from '../../contract/contexts.js'
import type { AccountSeamEntry } from '../../contract/accounts.js'
import type { GetOpts, ListFilter } from '../../contract/inputs.js'
import type { Issue } from '../../contract/entities.js'
import type { IssueDetailResult, IssueListResult, OpResult, TrackerError } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { PAGINATION } from '../../contract/pagination.js'
import { readBinding, type LinearBinding } from './binding.js'
import { gql, type LinearAccount } from './client.js'
import { failLinear, linearError } from './errors.js'
import { CLOSED_STATE_TYPES, issueOf, type LinearIssueNode } from './normalize.js'
import { IDENTITY_QUERY, ISSUE_CORE, ISSUES_QUERY } from './queries.js'
import { buildIssuesFilter, unsupportedFilters } from './read.js'

export type AccountListFilter = ListFilter & { account?: string; scope?: 'assigned' | 'review' }
export type AccountGetOpts = GetOpts & { account?: string }
type AccountIssue = Issue & { account: string }
type AccountFailure = { account: string; error: TrackerError }
type AccountListResult = IssueListResult & { partial?: boolean; errors?: AccountFailure[] }
type ScopedNode = LinearIssueNode & { project?: { id?: string } | null }
type Ready = { account: LinearAccount; entry: AccountSeamEntry; binding: LinearBinding }

/** 回包身份与将被归一化的嵌套节点必须可读；畸形数据不能冒充空字段。 */
function validNode(value: unknown): value is ScopedNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const node = value as ScopedNode
  if (typeof node.id !== 'string' || !node.id || typeof node.identifier !== 'string' || !node.identifier) return false
  for (const field of [node.team, node.state, node.parent, node.assignee, node.project]) {
    if (field !== undefined && field !== null && (typeof field !== 'object' || Array.isArray(field))) return false
  }
  if (node.labels !== undefined && node.labels !== null) {
    if (typeof node.labels !== 'object' || !Array.isArray(node.labels.nodes) || node.labels.nodes.some(label => !label || typeof label !== 'object' || typeof label.name !== 'string')) return false
  }
  return true
}

// 查询字段来自 research/13-linear-write-mutations.md 引用的 SDK schema：
// ProjectFilter.name、IssueFilter.project、UserCollectionFilter.some 与 NullableUserFilter.id。
const PROJECT_QUERY = `query LinearAccountProject($filter: ProjectFilter!) {
  projects(first: 2, filter: $filter) { nodes { id } pageInfo { hasNextPage } }
}`
const ACCOUNT_ISSUE_QUERY = `query LinearAccountIssue($id: String!) {
  issue(id: $id) { ...LinearIssueCore project { id } }
}
${ISSUE_CORE}`
// 本入口永远有上限；调用方预算可再缩小，不能把零解释成无限读取。
const MAX_ACCOUNT_PAGES = PAGINATION.linear.accountListMaxPages
const PAGE_SIZE = PAGINATION.linear.listPageSize

/** 错误也是结果边界，不能让远端回显或 seam 抛错把可重放的凭据带出去。 */
function safeError(error: TrackerError, authorization = ''): TrackerError {
  const clean = (text: string) => {
    let value = String(text || '')
    if (authorization) value = value.split(authorization).join('[redacted]')
    const token = authorization.replace(/^Bearer\s+/i, '')
    if (token) value = value.split(token).join('[redacted]')
    return value.replace(/\b(?:lin_api_|lin_oauth_)[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
  }
  return { kind: error.kind, message: clean(error.message), raw: clean(error.raw) }
}
function seamError(status: string, _message: string): TrackerError {
  // 凭据还没成功解析，无法知道错误原文里哪一段是秘密；只保留状态，不回传异常原文。
  const auth = status === 'needs_auth' || status === 'identity_mismatch'
  return linearError(auth ? ERROR_KIND.AUTH : ERROR_KIND.ENV, auth ? 'the Linear account needs sign-in or identity confirmation' : 'the Linear account configuration could not be resolved')
}

/** 只交出公开字段；即使宿主桩误带 authorization，也不把它传到工具结果。 */
export async function listConfiguredAccounts(ctx: OpContext): Promise<OpResult<AccountSeamEntry[]>> {
  if (!await readBinding(ctx)) return failLinear(ERROR_KIND.ENV, 'this workspace has no Linear binding')
  if (!ctx.accounts || typeof ctx.accounts.list !== 'function') return failLinear(ERROR_KIND.ENV, 'the room has no account listing seam wired')
  try {
    const result = await ctx.accounts.list(ctx.signal)
    if (!result.ok) return { ok: false, error: seamError(result.status, result.message) }
    if (!Array.isArray(result.accounts)) return failLinear(ERROR_KIND.PARSE, 'the account seam returned no account list')
    const seen = new Set<string>()
    const data: AccountSeamEntry[] = []
    for (const entry of result.accounts) {
      if (!entry || typeof entry.alias !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.alias) || seen.has(entry.alias)) {
        return failLinear(ERROR_KIND.CONFLICT, 'the configured Linear account aliases are invalid or ambiguous')
      }
      if (!Array.isArray(entry.teams) || entry.teams.some(team => typeof team !== 'string' || !team.trim()) || typeof entry.reviewPattern !== 'string' || !['subscribed', 'team', 'assigned'].includes(entry.reviewScope)) {
        return failLinear(ERROR_KIND.ENV, 'the Linear account metadata is invalid for ' + entry.alias)
      }
      seen.add(entry.alias)
      data.push({ alias: entry.alias, ...(typeof entry.label === 'string' ? { label: entry.label } : {}), teams: [...new Set(entry.teams.map(team => team.trim().toUpperCase()))], reviewPattern: entry.reviewPattern, reviewScope: entry.reviewScope })
    }
    return { ok: true, data }
  } catch {
    return failLinear(ERROR_KIND.ENV, 'the configured Linear accounts could not be read')
  }
}

async function resolve(ctx: OpContext, entry: AccountSeamEntry, binding: LinearBinding): Promise<OpResult<Ready>> {
  if (!ctx.accounts || typeof ctx.accounts.resolve !== 'function') return failLinear(ERROR_KIND.ENV, 'the room has no account resolution seam wired')
  try {
    const result = await ctx.accounts.resolve(entry.alias, ctx.signal)
    if (!result.ok) return { ok: false, error: seamError(result.status, result.message) }
    if (result.alias !== entry.alias || !result.authorization) return failLinear(ERROR_KIND.ENV, 'the resolved Linear account does not match the requested alias or has no authorization')
    return { ok: true, data: { entry, binding, account: { alias: entry.alias, endpoint: result.endpoint || 'https://api.linear.app/graphql', authorization: result.authorization } } }
  } catch {
    return failLinear(ERROR_KIND.ENV, 'the Linear account could not be resolved: ' + entry.alias)
  }
}

/** 显式账号不继承另一账号的团队；绑定项目则始终限制这次读取。 */
function teamsOf(ready: Ready): string[] {
  const { entry, binding } = ready
  const bound = binding.alias === entry.alias ? binding.team.trim().toUpperCase() : ''
  if (!bound) return entry.teams
  return entry.teams.length ? entry.teams.filter(team => team === bound) : [bound]
}
async function projectOf(ctx: OpContext, ready: Ready): Promise<OpResult<string | null>> {
  if (!ready.binding.project) return { ok: true, data: null }
  const result = await gql<{ projects?: { nodes?: { id?: string }[]; pageInfo?: { hasNextPage?: boolean } } }>(ctx, ready.account, {
    query: PROJECT_QUERY, variables: { filter: { name: { eq: ready.binding.project } } }, bucket: 'read',
  })
  if (!result.ok) return result
  const connection = result.data.projects
  if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') return failLinear(ERROR_KIND.PARSE, 'Linear returned an invalid project connection')
  if (connection.nodes.length > 1 || connection.pageInfo.hasNextPage) return failLinear(ERROR_KIND.CONFLICT, 'the bound Linear project name is ambiguous for ' + ready.entry.alias)
  if (!connection.nodes.length) return failLinear(ERROR_KIND.NOTFOUND, 'the bound Linear project was not found for ' + ready.entry.alias)
  if (!connection.nodes[0] || typeof connection.nodes[0].id !== 'string' || !connection.nodes[0].id) return failLinear(ERROR_KIND.PARSE, 'Linear returned a project without an id')
  return { ok: true, data: connection.nodes[0].id }
}

function validateFilter(filter: AccountListFilter): TrackerError | null {
  if (filter.account !== undefined && (typeof filter.account !== 'string' || !filter.account.trim())) return linearError(ERROR_KIND.CONFLICT, 'account must be an alias or *')
  if (filter.scope !== undefined && filter.scope !== 'assigned' && filter.scope !== 'review') return linearError(ERROR_KIND.UNSUPPORTED, 'scope must be assigned or review')
  if (filter.state !== undefined && filter.state !== 'open' && filter.state !== 'closed') return linearError(ERROR_KIND.UNSUPPORTED, 'state must be open or closed')
  if (filter.since !== undefined && (typeof filter.since !== 'string' || !Number.isFinite(Date.parse(filter.since)))) return linearError(ERROR_KIND.CONFLICT, 'since must be a valid timestamp')
  // 类型与标签在已经按账号、团队、项目收窄的节点上精确判断；截断仍按远端分页报告。
  if (filter.type !== undefined && !['issue', 'map', 'spec'].includes(filter.type)) return linearError(ERROR_KIND.UNSUPPORTED, 'type must be issue, map or spec')
  if (filter.labels !== undefined && (!Array.isArray(filter.labels) || filter.labels.some(label => typeof label !== 'string' || !label))) return linearError(ERROR_KIND.CONFLICT, 'labels must be a list of nonempty names')
  const missing = unsupportedFilters({ ...filter, type: undefined, labels: undefined })
  for (const key of Object.keys(filter)) {
    if (!['account', 'scope', 'state', 'since', 'type', 'labels', 'parentKey', 'keys', 'isPullRequest'].includes(key)) missing.push(key)
  }
  if (filter.labels !== undefined && !Array.isArray(filter.labels)) missing.push('labels')
  if (filter.keys !== undefined && !Array.isArray(filter.keys)) missing.push('keys')
  if (filter.isPullRequest !== undefined && typeof filter.isPullRequest !== 'boolean') missing.push('isPullRequest')
  return missing.length ? linearError(ERROR_KIND.UNSUPPORTED, 'this room cannot filter by ' + missing.join(', ')) : null
}

async function listOne(ctx: OpContext, ready: Ready, filter: AccountListFilter): Promise<AccountListResult> {
  let review: RegExp | null = null
  if (filter.scope === 'review') {
    try { review = new RegExp(ready.entry.reviewPattern, 'i') } catch { return failLinear(ERROR_KIND.ENV, 'the reviewPattern is not a valid regular expression for ' + ready.entry.alias) }
  }
  const project = await projectOf(ctx, ready)
  if (!project.ok) return project
  const conditions: Record<string, unknown>[] = [buildIssuesFilter(filter) || {}]
  if (project.data) conditions.push({ project: { id: { eq: project.data } } })
  const teams = teamsOf(ready)
  if (ready.binding.alias === ready.entry.alias && ready.binding.team && ready.entry.teams.length && !teams.length) return failLinear(ERROR_KIND.CONFLICT, 'the bound Linear team is outside the configured account teams')
  if (teams.length) conditions.push({ team: { key: { in: teams } } })
  const identityScope = filter.scope === 'assigned' ? 'assigned' : filter.scope === 'review' ? ready.entry.reviewScope : null
  if (identityScope === 'assigned' || identityScope === 'subscribed') {
    const identity = await gql<{ viewer?: { id?: string } }>(ctx, ready.account, { query: IDENTITY_QUERY, bucket: 'read' })
    if (!identity.ok) return identity
    const id = identity.data.viewer?.id
    if (!id) return failLinear(ERROR_KIND.PARSE, 'Linear returned no viewer id for ' + ready.entry.alias)
    conditions.push(identityScope === 'assigned' ? { assignee: { id: { eq: id } } } : { subscribers: { some: { id: { eq: id } } } })
  }
  if (review) conditions.push({ state: { type: { nin: CLOSED_STATE_TYPES } } })
  const budget = ctx.listMaxPages
  const maxPages = typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? Math.min(MAX_ACCOUNT_PAGES, Math.max(1, Math.floor(budget))) : MAX_ACCOUNT_PAGES
  const data: AccountIssue[] = []
  const cursors = new Set<string>()
  let after: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await gql<{ issues?: { nodes?: LinearIssueNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }>(ctx, ready.account, {
      query: ISSUES_QUERY, variables: { first: PAGE_SIZE, ...(after ? { after } : {}), filter: { and: conditions } }, bucket: 'read',
    })
    if (!result.ok) return result
    const connection = result.data.issues
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean' || connection.nodes.some(node => !validNode(node))) return failLinear(ERROR_KIND.PARSE, 'Linear returned an invalid issue connection')
    for (const node of connection.nodes) {
      if (review && (CLOSED_STATE_TYPES.includes(String(node.state?.type || '').toLowerCase()) || !review.test(String(node.state?.name || '')))) continue
      const issue = issueOf(node)
      if (filter.type && issue.type !== filter.type) continue
      if (filter.labels?.some(name => !issue.labels?.some(label => label.name.trim().toLowerCase() === name.trim().toLowerCase()))) continue
      data.push({ ...issue, account: ready.entry.alias })
    }
    if (!connection.pageInfo.hasNextPage) return { ok: true, data }
    const cursor = connection.pageInfo.endCursor
    if (!cursor || cursors.has(cursor)) return failLinear(ERROR_KIND.PARSE, 'Linear returned a missing or repeated issue cursor')
    cursors.add(cursor)
    after = cursor
  }
  return { ok: true, data, truncated: true }
}

/** 跨账号只合并成功的完整读取；失败账号逐个列出，不能伪装成空名单。 */
export async function listAccountIssues(ctx: OpContext, filter: AccountListFilter = {}): Promise<AccountListResult> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return failLinear(ERROR_KIND.CONFLICT, 'the list filter must be an object')
  const invalid = validateFilter(filter)
  if (invalid) return { ok: false, error: invalid }
  const binding = await readBinding(ctx)
  if (!binding) return failLinear(ERROR_KIND.ENV, 'this workspace has no Linear binding')
  const listed = await listConfiguredAccounts(ctx)
  if (!listed.ok) return listed
  const alias = filter.account ?? binding.alias
  const entries = alias === '*' ? listed.data : listed.data.filter(entry => entry.alias === alias)
  if (!entries.length) return failLinear(ERROR_KIND.NOTFOUND, 'no configured Linear account matches ' + alias)
  const data: AccountIssue[] = []
  const errors: AccountFailure[] = []
  let successes = 0
  let truncated = false
  for (const entry of entries) {
    try {
      const ready = await resolve(ctx, entry, binding)
      const result = ready.ok ? await listOne(ctx, ready.data, filter) : ready
      if (!result.ok) {
        errors.push({ account: entry.alias, error: safeError(result.error, ready.ok ? ready.data.account.authorization : '') })
        continue
      }
      successes++
      data.push(...result.data as AccountIssue[])
      truncated ||= result.truncated === true
    } catch {
      // 意外的回包形状只坏这本账；异常原文可能回显凭据，不能跨结果边界。
      errors.push({ account: entry.alias, error: linearError(ERROR_KIND.PARSE, 'the Linear account response could not be read for ' + entry.alias) })
    }
  }
  if (!successes) return { ok: false, error: errors[0].error, errors }
  return { ok: true, data, ...(truncated ? { truncated: true } : {}), ...(errors.length ? { partial: true, errors } : {}) }
}

/** 单票必须选一本账；团队与项目不匹配时不交出远端节点。 */
export async function getAccountIssue(ctx: OpContext, key: string, opts: AccountGetOpts = {}): Promise<IssueDetailResult> {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) || typeof opts.account !== 'string' || !/^[a-z][a-z0-9-]*$/.test(opts.account)) return failLinear(ERROR_KIND.CONFLICT, 'get requires one explicit account alias, not *')
  if (typeof key !== 'string' || !key.trim()) return failLinear(ERROR_KIND.NOTFOUND, 'no ticket key was given')
  if (opts.comments !== undefined && (!opts.comments || typeof opts.comments !== 'object' || opts.comments.first !== 0 || opts.comments.after !== undefined)) return failLinear(ERROR_KIND.UNSUPPORTED, 'account reads cannot fetch comments yet')
  const binding = await readBinding(ctx)
  if (!binding) return failLinear(ERROR_KIND.ENV, 'this workspace has no Linear binding')
  const listed = await listConfiguredAccounts(ctx)
  if (!listed.ok) return listed
  const alias = opts.account ?? binding.alias
  const entry = listed.data.find(item => item.alias === alias)
  if (!entry) return failLinear(ERROR_KIND.NOTFOUND, 'no configured Linear account matches ' + alias)
  const ready = await resolve(ctx, entry, binding)
  if (!ready.ok) return ready
  const project = await projectOf(ctx, ready.data)
  if (!project.ok) return { ok: false, error: safeError(project.error, ready.data.account.authorization) }
  const result = await gql<{ issue?: ScopedNode | null }>(ctx, ready.data.account, { query: ACCOUNT_ISSUE_QUERY, variables: { id: key.trim() }, bucket: 'read' })
  if (!result.ok) return { ok: false, error: safeError(result.error, ready.data.account.authorization) }
  const node = result.data.issue
  if (!node) return failLinear(ERROR_KIND.NOTFOUND, 'Linear has no ticket ' + key.trim())
  if (!validNode(node)) return failLinear(ERROR_KIND.PARSE, 'Linear returned an invalid ticket node')
  const teams = teamsOf(ready.data)
  const boundTeamConflict = binding.alias === alias && binding.team && entry.teams.length && !teams.length
  if (boundTeamConflict || (teams.length && !teams.includes(String(node.team?.key || '').toUpperCase())) || (project.data && node.project?.id !== project.data)) return failLinear(ERROR_KIND.NOTFOUND, 'the Linear ticket is outside this workspace project or configured teams')
  const data: AccountIssue = { ...issueOf(node), account: alias }
  return { ok: true, data }
}
