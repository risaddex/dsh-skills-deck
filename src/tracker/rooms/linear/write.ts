/**
 * src/tracker/rooms/linear/write.ts —— 写侧：评论、改票、关票/重开
 *
 * 三个操作各对应一个已经核对过的 mutation（出处见 `research/13-linear-write-mutations.md`）：
 *   · `commentCreate(input: { issueId, body })`（§3，`body` 对公开 API 是必填）；
 *   · `issueUpdate(id, input)`（§2，省略的字段保持原值，`parentId: null` 表示移到根）；
 *   · 关/重开没有独立 mutation：先读这张票所在团队的状态表，挑第一个 `completed`（关）或
 *     第一个 `unstarted`（重开），再用 `issueUpdate` 写 `stateId`（§7）。
 *
 * 两条不变量与读侧一致：失败是返回值不是异常；不认识的条件（`milestone`、自定义字段）如实回
 * `unsupported`，绝不发一个「看起来做了」的请求。
 */
import type { Comment, Issue } from '../../contract/entities.js'
import type { OpResult } from '../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../contract/results.js'
import type { OpContext } from '../../contract/contexts.js'
import type { UpdatePatch, CreateInput, SetOpts, LabelInput } from '../../contract/inputs.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE } from './queries.js'
import { resolveLabelIds, wantedLabelsOf } from './labels.js'
import { lookupByAnchor, withAnchor } from './anchor.js'
import { checkIdempotencyKey } from '../../../refresh/contract/idempotency-keys.js'
import { markerKindInHeader, markerLineFor } from '../../../shared/issue-file/src/marker.js'

/** 与读侧同一份选择集（`queries.ts` 的 `ISSUE_CORE`）：写完之后回的那张票要能直接过 `issueOf`。 */
const ISSUE_FIELDS = '...LinearIssueCore'

const COMMENT_CREATE = 'mutation DeckCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt updatedAt url user { name displayName } } } }'
const ISSUE_UPDATE = 'mutation DeckIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ' + ISSUE_FIELDS + ' } } } ' + ISSUE_CORE
const ISSUE_STATES = 'query DeckIssueStates($id: String!) { issue(id: $id) { team { key states { nodes { id name type position } } } } }'

/** 一条评论节点 → 契约的 Comment。作者给不出就写空串，不编一个名字。 */
function commentOf(node: any): Comment {
  const user = node && node.user ? node.user : null
  const login = String((user && (user.name || user.displayName)) || '')
  return {
    ...(node && node.id ? { id: String(node.id) } : {}),
    author: { login, ...(user && user.displayName ? { name: String(user.displayName) } : {}) },
    authorAssociation: '',
    body: String((node && node.body) || ''),
    createdAt: String((node && node.createdAt) || ''),
    updatedAt: String((node && node.updatedAt) || (node && node.createdAt) || ''),
  }
}

/** 发一条评论。成功回的是**新建的那条评论**，不是整张票。 */
export async function commentOnIssue(ctx: OpContext, account: LinearAccount, key: string, body: string): Promise<OpResult<Comment>> {
  const text = String(body || '')
  // Linear 的公开 API 要求 body 非空（§3 的字段说明）；空正文发出去只会换来一个对端错误。
  if (!text.trim()) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'a comment needs a body: Linear refuses an empty one on the public API') }
  const result = await gql<any>(ctx, account, { query: COMMENT_CREATE, variables: { input: { issueId: key, body: text } }, bucket: 'write' })
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data && result.data.commentCreate
  if (!payload || payload.success === false || !payload.comment) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the comment mutation but reported no comment') }
  return { ok: true, data: commentOf(payload.comment) }
}

/**
 * 改票：今天只翻 `title` 与 `body`。
 *
 * `milestone` / `customFields` 在 Linear 是别的 mutation（项目里程碑、自定义字段），这一版没有实现，
 * 所以给了它们就整体回 `unsupported`，而不是悄悄丢掉 —— 丢掉等于「看起来改了」。
 */
export async function updateIssue(ctx: OpContext, account: LinearAccount, key: string, patch: UpdatePatch | undefined): Promise<OpResult<Issue>> {
  const wanted = patch || {}
  if (wanted.milestone !== undefined || (Array.isArray(wanted.customFields) && wanted.customFields.length > 0)) {
    return { ok: false, error: linearError(ERROR_KIND.UNSUPPORTED, 'this room cannot write milestones or custom fields yet; clearing them would be a guess') }
  }
  const input: Record<string, unknown> = {}
  if (typeof wanted.title === 'string') input.title = wanted.title
  if (typeof wanted.body === 'string') input.description = wanted.body
  if (Object.keys(input).length === 0) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'an empty patch would be a request that changes nothing, so none was sent') }
  const result = await gql<any>(ctx, account, { query: ISSUE_UPDATE, variables: { id: key, input }, bucket: 'write' })
  return issueFromMutation(result, 'the update')
}

/** 把一次 issueUpdate 的回包翻成 `OpResult<Issue>`：三处写路径共用，免得各写一份判定。 */
function issueFromMutation(result: any, what: string): OpResult<Issue> {
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data && result.data.issueUpdate
  if (!payload || payload.success === false || !payload.issue) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted ' + what + ' mutation but reported no issue') }
  return { ok: true, data: issueOf(payload.issue as LinearIssueNode) }
}

/**
 * 关票或重开：先读团队状态表，挑第一个 `completed`（关）或第一个 `unstarted`（重开），再写 `stateId`。
 *
 * 为什么不用单据上的状态名：状态名是各团队自己起的（`Done` / `Concluído` / `Shipped`），类型才是
 * Linear 的公共词汇（§7）。挑第一个是为了可预期：同一个团队每次落到同一个状态。
 */
export async function setIssueStateType(ctx: OpContext, account: LinearAccount, key: string, wanted: 'completed' | 'unstarted'): Promise<OpResult<Issue>> {
  const states = await gql<any>(ctx, account, { query: ISSUE_STATES, variables: { id: key }, bucket: 'read' })
  if (!states.ok) return { ok: false, error: states.error }
  const nodes = (states.data && states.data.issue && states.data.issue.team && states.data.issue.team.states && states.data.issue.team.states.nodes) || []
  const wantedNodes = (Array.isArray(nodes) ? nodes : []).filter((n: any) => n && String(n.type || '').toLowerCase() === wanted)
  if (wantedNodes.length === 0) {
    return { ok: false, error: linearError(ERROR_KIND.UNSUPPORTED, 'this team has no workflow state of type ' + wanted + ', so the ticket cannot be moved there') }
  }
  wantedNodes.sort((a: any, b: any) => Number(a.position || 0) - Number(b.position || 0))
  const stateId = String(wantedNodes[0].id || '')
  if (!stateId) return { ok: false, error: linearError(ERROR_KIND.PARSE, 'the workflow state Linear returned has no id') }
  const result = await gql<any>(ctx, account, { query: ISSUE_UPDATE, variables: { id: key, input: { stateId } }, bucket: 'write' })
  return issueFromMutation(result, 'the state change')
}

/** 团队 key → 团队 id：建票必须带 teamId，而绑定声明里写的是 key（例如 ENG）。 */
const TEAMS_BY_KEY = 'query DeckTeamsByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }'
/** 探索地图的类型标签：与 `normalize.ts` 的 `issueTypeOf` 认的是同一个名字。 */
const MAP_LABEL = 'wayfinder:map'
const ISSUE_CREATE = 'mutation DeckIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ' + ISSUE_FIELDS + ' } } } ' + ISSUE_CORE

/**
 * 建一张票。
 *
 * 必须带团队：Linear 的 `issueCreate` 要 `teamId`，而绑定声明写的是团队 key，所以先按 key 查一次。
 *
 * 标签与类型（#33）：
 *   · `labels` 经 `labels.ts` 的 `resolveLabelIds` 换成 id（与覆盖式改标签同一份解析：翻到底、只认本团队或
 *     工作区标签、缺的建成本团队标签），随同一个 `issueCreate` 的 `labelIds` 发出 —— 不存在「先建票、再贴标签」
 *     的窗口，所以一张 `map` 不会有一刻是普通 issue；
 *   · `type: 'map'` 在调用方给的标签之外再加 `wayfinder:map`（已经给了就不重复）；
 *   · `type: 'spec'` 不带标签：规格由正文文件头的标记认（见 `normalize.ts` 的 `issueTypeOf`），而写标记的是 deck
 *     的建票工具。这里只负责**不丢**它，并在正文里没有标记时补上，免得直接调用本房的人建出一张读回来是普通票的规格。
 *
 * 幂等锚（#33）：给了 `idempotencyKey` 就先按锚回查（`anchor.ts`）：命中就把旧票交回去、不发任何写请求；
 * 回查没做成如实失败、绝不建票；没命中才建，并把锚写成正文第一行。不给就与没有这个字段之前完全一样。
 *
 * 仍然如实回 `unsupported` 的只有 `assignees`：用户 id 的解析不在这一版里，丢掉它等于「看起来做了」。
 */
export async function createIssue(ctx: OpContext, account: LinearAccount, input: CreateInput, teamKey: string): Promise<OpResult<Issue>> {
  const wanted = input || ({} as CreateInput)
  const title = String(wanted.title || '').trim()
  if (!title) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'a ticket needs a title: Linear refuses one without it') }
  if (!teamKey) return { ok: false, error: linearError(ERROR_KIND.ENV, 'the workspace binding names no Linear team, so a ticket cannot be created in one') }
  if (Array.isArray(wanted.assignees) && wanted.assignees.length > 0) {
    return { ok: false, error: linearError(ERROR_KIND.UNSUPPORTED, 'this room cannot set assignees while creating a ticket yet: resolving them to Linear users is not implemented, and creating the ticket without them would be a guess') }
  }
  // 键不合规当场失败，而且早于任何请求：键不合法时连回查都无从做起；不「清洗」成另一个键。
  let idemKey = ''
  if (wanted.idempotencyKey !== undefined && wanted.idempotencyKey !== null) {
    const checked = checkIdempotencyKey(wanted.idempotencyKey)
    if (!checked.ok) return { ok: false, error: Object.assign(linearError(ERROR_KIND.PARSE, 'create: idempotencyKey cannot be used: ' + checked.reason), { stage: TRACKER_ERROR_STAGE.INPUT_REFUSED }) }
    idemKey = checked.key
  }
  // 标签名先归一（去重、拒绝空名）：不合规就整条拒绝，绝不发一个丢了标签的建票请求。
  const names: LabelInput[] = Array.isArray(wanted.labels) ? [...wanted.labels] : []
  if (wanted.type === 'map' && !names.some((l: any) => (typeof l === 'string' ? l : (l && l.name)) === MAP_LABEL)) names.push({ name: MAP_LABEL })
  const normalized = wantedLabelsOf(names)
  if (!normalized.ok) return { ok: false, error: normalized.error }

  // 回查在一切写之前：命中就一个写请求都不发。
  if (idemKey) {
    const found = await lookupByAnchor(ctx, account, teamKey, idemKey)
    if (!found.ok) return { ok: false, error: found.error }
    if (found.hit) return { ok: true, data: found.issue }
  }

  const teams = await gql<any>(ctx, account, { query: TEAMS_BY_KEY, variables: { key: teamKey }, bucket: 'read' })
  if (!teams.ok) return { ok: false, error: teams.error }
  const nodes = (teams.data && teams.data.teams && teams.data.teams.nodes) || []
  const team = (Array.isArray(nodes) ? nodes : []).find((n: any) => n && String(n.key || '').toUpperCase() === String(teamKey).toUpperCase())
  if (!team || !team.id) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no team with key ' + teamKey + ', so the ticket cannot be created') }

  const payload: Record<string, unknown> = { teamId: String(team.id), title }
  let description = typeof wanted.body === 'string' ? wanted.body : ''
  // 规格的类型在正文标记里：调用方（deck）已经写了就保持原样；没写就补，补在正文最前面（锚会再排到它前面）。
  if (wanted.type === 'spec' && markerKindInHeader(description) !== 'spec') description = markerLineFor('spec') + description
  if (idemKey) description = withAnchor(description, idemKey)
  if (description || typeof wanted.body === 'string') payload.description = description
  if (wanted.parentKey) payload.parentId = String(wanted.parentKey)
  if (normalized.data.length > 0) {
    const ids = await resolveLabelIds(ctx, account, normalized.data, teamKey)
    if (!ids.ok) return { ok: false, error: ids.error }
    payload.labelIds = ids.data
  }
  const result = await gql<any>(ctx, account, { query: ISSUE_CREATE, variables: { input: payload }, bucket: 'write' })
  if (!result.ok) return { ok: false, error: result.error }
  const created = result.data && result.data.issueCreate
  if (!created || created.success === false || !created.issue) return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the create mutation but reported no issue') }
  return { ok: true, data: issueOf(created.issue as LinearIssueNode) }
}

/**
 * 改父票：`null` 表示移到根（Linear 用 `parentId: null` 表达，省略表示保持原样）。
 *
 * `opts.expectedUpdatedAt` 是契约的乐观并发：给了就先读当前票比一次 `updatedAt`，对不上回
 * `conflict` 且**不写**。不比对就写，会把别人刚做的父改动盖掉还报成功。
 */
export async function setParentOfIssue(ctx: OpContext, account: LinearAccount, key: string, parentKey: string | null, opts?: SetOpts): Promise<OpResult<Issue>> {
  const expected = opts && typeof opts.expectedUpdatedAt === 'string' ? opts.expectedUpdatedAt : ''
  if (expected) {
    const current: any = await gql<any>(ctx, account, { query: 'query DeckIssueUpdatedAt($id: String!) { issue(id: $id) { identifier updatedAt } }', variables: { id: key }, bucket: 'read' })
    if (!current.ok) return { ok: false, error: current.error }
    const node = current.data && current.data.issue
    if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'the ticket ' + key + ' does not exist, so its parent cannot be changed') }
    if (String(node.updatedAt || '') !== expected) {
      return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'the ticket changed since ' + expected + ' (now ' + String(node.updatedAt || 'unknown') + '), so the parent was not changed') }
    }
  }
  const input = { parentId: parentKey === null || parentKey === undefined ? null : String(parentKey) }
  const result = await gql<any>(ctx, account, { query: ISSUE_UPDATE, variables: { id: key, input }, bucket: 'write' })
  return issueFromMutation(result, 'the parent change')
}