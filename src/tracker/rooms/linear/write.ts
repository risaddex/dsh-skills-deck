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
import type { OpContext } from '../../contract/contexts.js'
import type { UpdatePatch } from '../../contract/inputs.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE } from './queries.js'

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
