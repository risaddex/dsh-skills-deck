/**
 * src/tracker/rooms/linear/assignees.ts —— 写侧：覆盖式改指派人（契约的 setAssignees）
 *
 * ── 这一件事在 Linear 上的真实形状 ─────────────────────────────────────────────
 * 契约的 setAssignees 收的是一份**整集**（传什么就是什么），而 Linear 的
 * `IssueUpdateInput.assigneeId` 只收**一个**用户 id。schema 里这个字段的说明原文是
 * "UUID of the new assignee. Null unassigns the issue."，出处是
 * `research/13-linear-write-mutations.md` 引的 S2（@linear/sdk 里的 schema.graphql，
 * 提交 87d638c），`input IssueUpdateInput` 第 18038–18040 行（字段声明在第 18040 行）。
 * 于是「登录名 → 用户 id」这一步必须自己走：`Query.users(filter: UserFilter, first: Int)`
 * 是 schema 里唯一按人查的入口（同一份 S2 的 `type Query` 第 35508–35510 行，说明原文：
 * "Users in the workspace, with filtering and pagination. Disabled accounts are excluded unless
 * includeDisabled is true."）。它的 `UserFilter` 提供 `name: StringComparator` 与
 * `displayName: StringComparator`（第 43047、43071 行），`StringComparator` 提供
 * `eqIgnoreCase`（第 39172 行），`UserFilter.or` 的说明是「这一组里至少一条命中，再叠加本过滤器
 * 上的其余条件」（第 43073 行），所以 `app` 与 `or` 可以写在同一个过滤器上。
 *
 * ── 四个必须写死的决定 ──────────────────────────────────────────────────────────
 * 1. 查不到的登录名 → `not-found`，整步失败、一个写请求都不发。理由与 GitLab 房 #1785
 *    （tests/verify-1785-assign-unknown.ts）那一课同源：把一个人静默丢掉，调用方看到的是成功，
 *    而名单里少了一个人 —— 这比失败更难发现。
 * 2. 空数组 → 明确清空，写 `assigneeId: null`。契约里 `[]` 与「省略」是两种意思，这里照契约读，
 *    不把空数组当成「什么都没说」。
 * 3. 多于一个人 → `unsupported`，不替调用方挑一个。Linear 的模型是一个人；挑第一个等于回答
 *    一个调用方没问的问题，而人看到的却是「成功」。
 * 4. 一个登录名同时命中两个人的昵称与全名 → `conflict`，同样一个字节都不写。
 *
 * 两条不变量与房内其它写操作一致：失败是返回值不是异常；写前版本校验
 * （`opts.expectedUpdatedAt`）对不上就回 `conflict` 且**不写**，与 `write.ts` 的
 * `setParentOfIssue` 逐字同规。
 */
import type { Issue } from '../../contract/entities.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import type { OpContext } from '../../contract/contexts.js'
import type { AssigneeInput, SetOpts } from '../../contract/inputs.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE } from './queries.js'

/** 与读侧同一份选择集（`queries.ts` 的 `ISSUE_CORE`）：写完之后回的那张票要能直接过 `issueOf`。 */
const ISSUE_FIELDS = '...LinearIssueCore'

/**
 * 改一个字段的 mutation。与 `write.ts` 里那一份逐字相同：那边的常量与 `issueFromMutation`
 * 都没有导出，而这次改动只许新建一个文件，所以这里照抄一份。两份并存只是过渡，
 * 接线时应当把它们收拢成一处 —— 现在任何一边单独改字段，另一边就会悄悄落后。
 */
const ISSUE_UPDATE = 'mutation DeckSetAssigneesUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ' + ISSUE_FIELDS + ' } } } ' + ISSUE_CORE

/**
 * 登录名换一个人。
 *
 * `first: 5` 是为了分清「唯一命中」与「不止一个人」：要 1 个只够判断存在，回执里说不出
 * 「命中了几个人」；5 个对复杂度可以忽略，而 schema 的连接参数上限本来就是 250。
 * 不传 `includeDisabled`：它的默认值就是 false（见文件头的说明原文），停用的账号不会出现在名单里，
 * 这正是指派时要的口径。
 */
const USERS_BY_LOGIN = 'query DeckUsersByLogin($filter: UserFilter!) { users(filter: $filter, first: 5) { nodes { id name displayName app } } }'

/** 乐观并发要的那一次读：只要 identifier 与 updatedAt，别的字段一个都不取。 */
const ISSUE_UPDATED_AT = 'query DeckIssueUpdatedAt($id: String!) { issue(id: $id) { identifier updatedAt } }'

/** 一次查人的四种结局。写成可辨识联合，是为了让调用方逐种处置，不留「看着办」的第五种。 */
type Lookup = { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'many'; count: number } | { kind: 'error'; error: TrackerError }

/**
 * 入参 → 去重后的登录名清单与「有没有空白名字」这一格。
 *
 * 裸串与 `{ login }` 两形都收（契约 `AssigneeInput` 的定义），去掉首尾空白后为空的一律当坏输入，
 * 由调用方拒绝：把它当成「这个人不存在」会给出误导的回执，当成「清空」更糟 ——
 * 一次打错的输入会删掉别人已有的认领。
 * 同一个人写两遍（大小写不同也算同一个）不构成「多于一个人」，所以先去重再判断。
 */
function loginsOf(assignees: unknown): { logins: string[]; blank: boolean } {
  const list = Array.isArray(assignees) ? assignees : []
  const logins: string[] = []
  let blank = false
  for (const item of list) {
    const raw = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? String((item as { login?: unknown }).login ?? '')
        : ''
    const login = raw.trim()
    if (!login) {
      blank = true
      continue
    }
    if (!logins.some((seen) => seen.toLowerCase() === login.toLowerCase())) logins.push(login)
  }
  return { logins, blank }
}

/**
 * 登录名 → 用户 id。
 *
 * 为什么同时认 `displayName` 与 `name` 两个字段：读侧（`normalize.ts` 的 `issueOf`）把
 * `assignee.name`（Linear 的「全名」）当成契约的 `login` 交出去，而 Linear 里唯一保证工作区内
 * 不重名的是 `displayName`（schema 原文："The user's display (nick) name. Must be unique within
 * the workspace."，第 42630 行）。只认其中一个，都会让「把读回来的登录名再写回去」这一趟失败：只认
 * displayName 时读侧给的全名查不到人，只认全名时调用方手里的昵称查不到人。
 * 两个都命中、但指向**不同**的人时不算查到：那是一个登录名落在两个人身上，挑谁都是猜。
 */
async function lookupUser(ctx: OpContext, account: LinearAccount, login: string): Promise<Lookup> {
  // 服务端就已经把「代表已安装应用的账号」筛掉（app: { eq: false }）；下面再核一遍 node.app，
  // 是不想依赖某个工作区的过滤实现 —— 少认一个人顶多报 not-found，多认一个人就会指派错对象。
  const filter = {
    app: { eq: false },
    or: [{ displayName: { eqIgnoreCase: login } }, { name: { eqIgnoreCase: login } }],
  }
  const answer = await gql<any>(ctx, account, { query: USERS_BY_LOGIN, variables: { filter }, bucket: 'read' })
  if (!answer.ok) return { kind: 'error', error: answer.error }
  const nodes = answer.data && answer.data.users && answer.data.users.nodes
  const wanted = login.toLowerCase()
  const ids = new Set<string>()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.app === true) continue
    const id = String(node.id || '')
    if (!id) continue
    const display = String(node.displayName || '').toLowerCase()
    const full = String(node.name || '').toLowerCase()
    if (display === wanted || full === wanted) ids.add(id)
  }
  if (ids.size === 0) return { kind: 'none' }
  let only = ''
  for (const id of ids) only = id
  if (ids.size > 1) return { kind: 'many', count: ids.size }
  return { kind: 'one', id: only }
}

/**
 * 写前版本校验：给了 `expectedUpdatedAt` 就先读当前的 `updatedAt` 比一次。
 *
 * 对不上回 `conflict` 且不写 —— 不比对就写，会把别人刚做完的认领改动盖掉还报成功。
 * 票根本不在是 `not-found`：票都不在，改谁都不该发生。
 * 返回值是「失败」或 `null`（放行），而不是抛错：契约要求失败是返回值。
 */
async function staleUpdatedAt(ctx: OpContext, account: LinearAccount, key: string, expected: string): Promise<TrackerError | null> {
  const current = await gql<any>(ctx, account, { query: ISSUE_UPDATED_AT, variables: { id: key }, bucket: 'read' })
  if (!current.ok) return current.error
  const node = current.data && current.data.issue
  if (!node) return linearError(ERROR_KIND.NOTFOUND, 'the ticket ' + key + ' does not exist, so its assignees cannot be changed')
  const now = String(node.updatedAt || '')
  if (now !== expected) {
    return linearError(ERROR_KIND.CONFLICT, 'the ticket changed since ' + expected + ' (now ' + (now || 'unknown') + '), so the assignees were not changed')
  }
  return null
}

/**
 * 覆盖式改指派人：`[]` 清空，一个人换掉当前认领，多于一个人如实拒绝。
 *
 * 顺序是有意的：先把输入核完（这一步一个请求都不发），再做写前版本校验，最后才去查人。
 * 把校验放在查人之前，是因为版本已经过期的调用不值得再花一次读去问「这个人是谁」，
 * 而查完人再拒绝也会让回执读起来像「人找到了、只是没写」。
 */
export async function setAssigneesOfIssue(
  ctx: OpContext,
  account: LinearAccount,
  key: string,
  assignees: AssigneeInput[],
  opts: SetOpts | undefined,
): Promise<OpResult<Issue>> {
  const { logins, blank } = loginsOf(assignees)
  if (blank) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'an assignee list with an empty login cannot be applied: assignees are replaced as a whole, so a blank entry is a broken name rather than "nobody", and nothing was written') }
  }
  if (logins.length > 1) {
    return { ok: false, error: linearError(ERROR_KIND.UNSUPPORTED, 'Linear assigns one person per ticket and ' + logins.length + ' were given (' + logins.join(', ') + '), so nothing was written') }
  }
  const expected = opts && typeof opts.expectedUpdatedAt === 'string' ? opts.expectedUpdatedAt : ''
  if (expected) {
    const stale = await staleUpdatedAt(ctx, account, key, expected)
    if (stale) return { ok: false, error: stale }
  }
  let assigneeId: string | null = null
  const login = logins.length === 1 ? logins[0] : ''
  if (login) {
    const found = await lookupUser(ctx, account, login)
    if (found.kind === 'error') return { ok: false, error: found.error }
    if (found.kind === 'none') {
      return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no active person named ' + login + ', so the assignees were left as they were and no write was sent') }
    }
    if (found.kind === 'many') {
      return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'the login ' + login + ' matches ' + found.count + ' different people in this workspace, so the assignees were left as they were and no write was sent') }
    }
    assigneeId = found.id
  }
  // 省略 `assigneeId` 与写 `null` 在 Linear 是两个意思（schema 原文：Null unassigns the issue），
  // 空清单要的就是后者。本来就没人认领时再写一次 null 也不会错，所以不为「省一次写」先读一次。
  const result = await gql<any>(ctx, account, { query: ISSUE_UPDATE, variables: { id: key, input: { assigneeId } }, bucket: 'write' })
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data && result.data.issueUpdate
  // `success: false` 与「没回票」都当失败：Linear 会先回一个空壳再补错误，把空壳当成功
  // 就是「看起来改好了」。回的那张票原样交给调用方，谁被指派以它为准 —— 所以这里不做二次读回，
  // 也不能把「这台票面上还是旧的」解释成成功。
  if (!payload || payload.success === false || !payload.issue) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the assignee change but reported no issue') }
  }
  return { ok: true, data: issueOf(payload.issue as LinearIssueNode) }
}
