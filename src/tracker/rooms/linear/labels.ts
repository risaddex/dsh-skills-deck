/**
 * src/tracker/rooms/linear/labels.ts —— 覆盖式改标签：名字 → 标签 id → 一次 issueUpdate
 *
 * 契约的 `setLabels` 是**替换**，不是增量（见 `contract/operations.ts` 那一条上的说明）。
 * Linear 正好有一条同口径的写入口：`IssueUpdateInput.labelIds`，研究笔记 §4 引的 schema 原话是
 * “Replacement list of label UUIDs. An empty list removes all labels.”（§2 重复了同一句），
 * 所以这里**不用** `issueAddLabel` / `issueRemoveLabel`，也不用 `addedLabelIds` / `removedLabelIds`：
 * 那两条是增量，用它们实现替换就得先读现值再算差集，而读与写之间别人插一笔，差集就少删或多加。
 * 替换语义有一个请求就说完的好处，代价是每次都要把整组标签写全 —— 这是契约要的，不是损失。
 *
 * 为什么名字要先换成 id：Linear 的写入口只收 UUID，而调用方（deck 工具、面板）手里只有名字。
 * 换 id 的顺序固定为「先查一次、缺的再建、最后一次性写票」：这样失败时票上的标签要么一个没动，
 * 要么正好是调用方要的那一整组，不会出现「写了一半」那种看起来做了的状态。
 *
 * 不变量与同目录的另外几份写侧文件一致：失败是返回值不是异常；不合规的输入当场拒绝，
 * 绝不发一个「看起来做了」的请求。
 */
import type { Issue } from '../../contract/entities.js'
import type { OpContext } from '../../contract/contexts.js'
import type { LabelInput, SetOpts } from '../../contract/inputs.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { labelNameFilter, pickLabel, wantedLabelsOf, type WantedLabel } from './label-match.js'
import { PAGINATION } from '../../contract/pagination.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE } from './queries.js'

/** 与读侧、`write.ts` 同一份选择集：写完之后回的那张票要能直接过 `issueOf`。 */
const ISSUE_FIELDS = '...LinearIssueCore'
const ISSUE_UPDATE = 'mutation DeckIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ' + ISSUE_FIELDS + ' } } } ' + ISSUE_CORE

/** 乐观并发要比的只有两格：这张票还在不在、它现在的 updatedAt 是多少。 */
const ISSUE_UPDATED_AT = 'query DeckIssueUpdatedAt($id: String!) { issue(id: $id) { identifier updatedAt } }'

/**
 * 名字 → 标签，一次问全这一批。
 *
 * 研究笔记 §4 核对了 `Query.issueLabels` 是标准连接（一页 1 到 250 条），§8 核对了
 * `StringComparator` 有 `in`；把「标签名过滤字段」逐字抄进那份笔记的是没有的，所以这一句是
 * 按那两条事实拼的。若 Linear 不认这个过滤字段，它会回 HTTP 200 带 errors[]，客户端那一层照常
 * 翻成失败 —— 这里不存在「查不到就当没标签」的静默降级。
 *
 * `first: 250` 是连接的上限；一批名字的精确匹配远到不了这个数，所以不翻页。
 * 不传 includeArchived：退休（retire）的标签本来就「不能再被新指派」（§4 的生命周期一节），
 * 把它查出来再用反而是错的。
 */
/**
 * 按名字找标签，**必须能翻页**：同名标签可以在不同团队里各有一份，一页 250 条在小工作区够用，
 * 在大的组织里却可能把「本团队那份」挤到下一页 —— 于是它被判成缺失、进而被重复创建，
 * 或者一次本来合法的替换因为撞名而失败（PR #32 review 的 P2）。所以这里带回游标，由调用方翻到底。
 *
 * 名字**不分大小写**（#85）：Linear 自己把 `Bug` 与 `bug` 当成同一个名字，建 `bug` 时会以
 * “Label "Bug" already exists” 拒绝。若这里仍按精确名字找，工作区里的 `Bug` 永远找不到，
 * 随后去建 `bug` 又被拒绝，一个有 `Bug` 的团队就永远满足不了 `bug`。
 * 过滤写成 `filter: IssueLabelFilter` 变量：Linear 的 `StringComparator` 有 `eqIgnoreCase`，
 * 却**没有**忽略大小写的 `in`（2026-11-23 对照 @linear/sdk 的 schema.graphql 核对过：
 * `IssueLabelFilter` 有 `or: [IssueLabelFilter!]`，`StringComparator` 里只有 `in` 与 `eqIgnoreCase`），
 * 所以一批名字写成「各名字一条 `eqIgnoreCase` 的 `or`」。
 */
const LABELS_BY_NAME = 'query DeckLabelsByName($filter: IssueLabelFilter!, $after: String) { issueLabels(filter: $filter, first: 250, after: $after) { nodes { id name color team { id key } } pageInfo { hasNextPage endCursor } } }'

/** 缺的名字建出来（§4：`IssueLabelCreateInput` 只有 `name` 必填，`color` 不接受 null）。 */
const LABEL_CREATE = 'mutation DeckIssueLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color team { id key } } } }'

/** 团队 key → 团队 id：标签的 `teamId` 要 UUID，而绑定声明里写的是 key（与建票同一条路）。 */
const TEAMS_BY_KEY = 'query DeckTeamsByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }'

/**
 * 团队 key → 团队 id。只在真要建标签时才调用，所以「标签全都已经存在」的那一趟不会多一次查询。
 * 声明里没写团队、或者 Linear 没有这个 key，都如实失败：把标签建到凭空猜的团队里，
 * 等于把调用方要的东西换成了别的（与 `write.ts` 建票那一处同一个判断）。
 */
async function teamIdOfIssue(ctx: OpContext, account: LinearAccount, teamKey: string): Promise<OpResult<string>> {
  if (!String(teamKey || '')) {
    return { ok: false, error: linearError(ERROR_KIND.ENV, 'the workspace binding names no Linear team, so a new label has no team to belong to') }
  }
  const teams: any = await gql<any>(ctx, account, { query: TEAMS_BY_KEY, variables: { key: teamKey }, bucket: 'read' })
  if (!teams.ok) return { ok: false, error: teams.error }
  const nodes = (teams.data && teams.data.teams && teams.data.teams.nodes) || []
  const team = (Array.isArray(nodes) ? nodes : []).find((node: any) => node && String(node.key || '').toUpperCase() === String(teamKey).toUpperCase())
  if (!team || !team.id) {
    return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no team with key ' + teamKey + ', so a new label cannot be scoped to it') }
  }
  return { ok: true, data: String(team.id) }
}

/**
 * 建一个缺失的标签，回它的 id。
 *
 * **建成本团队的标签，不是工作区标签**，这是本文件唯一一处主动选边的地方，理由三条：
 * 一是这张票属于绑定声明那一个团队，本团队标签它一定能用，而工作区标签只解决「能用」、不解决归属；
 * 二是工作区标签对整个工作区永久可见，一个只为这张票起的名字从此出现在每个团队的选片器里 ——
 * 一次只认一张票的写操作不该有这么大的影响面（还要工作区级的权限才收得回来）；
 * 三是反过来的代价很小：别的团队真要用这个名字时，建自己的那一份即可，两条同名标签并存在 Linear 里
 * 本来就是合法状态，读侧按名字认识它们（`normalize.ts` 的 `issueTypeOf` 只看名字）。
 * 真要建工作区标签，`IssueLabelCreateInput` 的写法是**省掉 teamId**（§4 的原话 “Omit for a workspace
 * label.”），也就是说「建团队标签」是显式给出 teamId 这一条，而不是另有一个 organization 字段
 * （§4 明确说两个输入类型上都没有 organizationId）。
 */
async function createLabel(ctx: OpContext, account: LinearAccount, want: WantedLabel, teamId: string): Promise<OpResult<string>> {
  const input: Record<string, unknown> = { name: want.name, teamId }
  // §4：color 不接受 null，所以「没颜色」只能整格省掉，不能传空串或 null。
  if (want.color) input.color = want.color
  if (want.description) input.description = want.description
  const created: any = await gql<any>(ctx, account, { query: LABEL_CREATE, variables: { input }, bucket: 'write' })
  if (!created.ok) return { ok: false, error: created.error }
  const payload = created.data && created.data.issueLabelCreate
  const id = payload && payload.issueLabel ? String(payload.issueLabel.id || '') : ''
  if ((payload && payload.success === false) || !id) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the label creation but reported no label id, so the ticket was left untouched') }
  }
  return { ok: true, data: id }
}

/**
 * 把「建标签失败」补成一条人能照着做的失败（#85）。
 *
 * 为什么要补：Linear 的应用令牌在有的工作区没有建标签的权限，回的只有一句 “not allowed to take action”，
 * 而回执里 `stage` 为空、reason 是 backend-unsupported，读的人看不出是标签这一步失败、缺哪些标签、该做什么。
 * 这里不新增原因码（原因码固定八个，见 `receipt-reason.ts`），而是把事实写进两处：
 *   · 失败的 `stage` 字段标成 `LABEL_CREATE`，让失败证据里看得见是哪一步；
 *   · `message` 写明这一步、Linear 的原话，权限被拒时再列出**还没建成的全部名字**（被拒的这个加上还没试的），
 *     并说清去哪里一次性建好再重试。只列被拒的那一个不够：人会建一个、重试、再撞下一个。
 * `kind` 原样保留（权限被拒仍是 `auth`）：分类决定界面怎么说话，这里只补说明，不改分类。
 * 只有权限被拒才建议「去 Linear 里手工建」：别的原因（比如名字不合规）手工建同样会失败，那句话会把人带偏。
 * 已经建出来的标签留在工作区里，理由见 `createLabel`。
 */
function labelCreateFailure(cause: TrackerError, stillMissing: WantedLabel[], teamKey: string): TrackerError {
  // stillMissing 的第一个就是这次建失败的那个标签，后面是还没试的。
  const head = 'The step of creating a label failed: the label "' + stillMissing[0].name + '" was not created (Linear said: ' + cause.message + '). '
  const tail = cause.kind === ERROR_KIND.AUTH
    ? 'Missing labels that could not be created: ' + stillMissing.map((item) => '"' + item.name + '"').join(', ')
      + '. No ticket was created or changed. Create them once in Linear (Settings, Labels, team ' + teamKey + ') and retry.'
    : 'No ticket was created or changed.'
  return { kind: cause.kind, message: head + tail, raw: cause.raw || cause.message, stage: TRACKER_ERROR_STAGE.LABEL_CREATE }
}

/** 唯一的一处写：`labelIds` 把这张票的标签**整组换掉**（§4 引的 schema 原话），空数组就是清空。 */
async function writeLabelIds(ctx: OpContext, account: LinearAccount, key: string, labelIds: string[]): Promise<OpResult<Issue>> {
  const result: any = await gql<any>(ctx, account, { query: ISSUE_UPDATE, variables: { id: key, input: { labelIds } }, bucket: 'write' })
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data && result.data.issueUpdate
  if (!payload || payload.success === false || !payload.issue) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the label mutation but reported no issue') }
  }
  return { ok: true, data: issueOf(payload.issue as LinearIssueNode) }
}

/**
 * 名字 → 标签 id（按调用方给的顺序），缺的建成本团队标签。
 *
 * 为什么单独导出：覆盖式改标签（`setLabelsOfIssue`）与建票（`write.ts` 的 `createIssue`）都要把标签名换成 id，
 * 而「翻到底再判断缺不缺」「只认本团队或工作区标签」「建成本团队标签」这三条规矩只能有一份 ——
 * 建票若自己再写一遍，两处迟早会对同一个名字给出不同的 id（#33）。
 *
 * 失败是返回值不是异常；失败时票上一个字都没动（建票时则是一张票都没建），已建出的标签留在工作区里（理由见 `createLabel`）。
 * 入参 `wanted` 必须已经过 `wantedLabelsOf` 归一（去重、名字非空）。
 */
export async function resolveLabelIds(ctx: OpContext, account: LinearAccount, wanted: WantedLabel[], teamKey: string): Promise<OpResult<string[]>> {
  // 翻到底再判断「缺不缺」：只看第一页就建标签，会把别人的同名标签当成不存在。
  const found: any[] = []
  let after: string | null = null
  for (let page = 0; page < PAGINATION.linear.countMaxPages; page += 1) {
    const lookup: any = await gql<any>(ctx, account, { query: LABELS_BY_NAME, variables: { filter: labelNameFilter(wanted), after }, bucket: 'read' })
    if (!lookup.ok) return { ok: false, error: lookup.error }
    const conn = lookup.data && lookup.data.issueLabels
    const nodes = (conn && conn.nodes) || []
    if (!Array.isArray(nodes)) return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear answered the label lookup without a node list') }
    found.push(...nodes)
    const more = !!(conn && conn.pageInfo && conn.pageInfo.hasNextPage)
    if (!more) break
    if (!conn.pageInfo.endCursor) return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear said there are more labels but gave no cursor to read them') }
    after = String(conn.pageInfo.endCursor)
    // 翻到上限还没到底：宁可整条操作失败，也不在「可能没看全」的名单上决定新建标签。
    if (page === PAGINATION.linear.countMaxPages - 1) {
      return { ok: false, error: linearError(ERROR_KIND.UNSUPPORTED, 'this workspace has more labels than the room will walk in one go, so the label list cannot be read completely; nothing was written') }
    }
  }

  const ids = new Map<string, string>()
  const missing: WantedLabel[] = []
  for (const want of wanted) {
    const match = pickLabel(found, want.name, teamKey)
    const id = match ? String(match.id || '') : ''
    if (id) ids.set(want.name, id)
    else missing.push(want)
  }

  if (missing.length > 0) {
    const team = await teamIdOfIssue(ctx, account, teamKey)
    if (!team.ok) return { ok: false, error: team.error }
    for (let index = 0; index < missing.length; index += 1) {
      const want = missing[index]
      const created = await createLabel(ctx, account, want, team.data)
      // 建到一半失败就停：已经建出来的标签留在工作区里（一张没人用的标签无害），而票上一个字都没改。
      // 不删它们，是因为删标签会连带摘掉别处正在用的同一份（§4 的 issueLabelDelete 就是这样），
      // 为了收拾自己的一次失败去动别人的数据，代价比留下一个空标签大得多。
      // 失败说明里要列的是「还没建成的全部名字」：被拒的这一个加上后面还没试的（#85）。
      if (!created.ok) return { ok: false, error: labelCreateFailure(created.error, missing.slice(index), teamKey) }
      ids.set(want.name, created.data)
    }
  }

  const ordered: string[] = []
  for (const want of wanted) {
    const id = ids.get(want.name)
    if (!id) return { ok: false, error: linearError(ERROR_KIND.PARSE, 'the label ' + want.name + ' could not be resolved to an id, so the ticket was left untouched') }
    ordered.push(id)
  }
  return { ok: true, data: ordered }
}

/**
 * 覆盖式改标签：`labels` 里有什么，票上就正好是什么（空数组清空全部）。
 *
 * `opts.expectedUpdatedAt` 是契约的乐观并发：给了就先读一次这张票的 `updatedAt`，对不上回
 * `conflict` 且**一个查询都不多花**、一个写都不发（与 `write.ts` 的 `setParentOfIssue` 同一份写法）。
 * 不比对就写，会把别人刚做的标签改动整组盖掉，还回「成功」。
 * `opts.status` 只给本地 Markdown 房用（那边状态存在标签里），Linear 的状态是 workflow state 不是标签，
 * 所以这里无视它 —— 无视而不是拒绝，因为它不改变这次标签写的结果。
 */
export async function setLabelsOfIssue(
  ctx: OpContext,
  account: LinearAccount,
  key: string,
  labels: LabelInput[],
  opts: SetOpts | undefined,
  teamKey: string,
): Promise<OpResult<Issue>> {
  // 缺了这份清单（调用方 bug，类型上说不可能）不能当空清单读：这里的空清单是「清空全部标签」，
  // 于是一个漏传的参数会安静地把票上的标签全摘掉。宁可当场拒绝，让人去修调用点。
  if (!Array.isArray(labels)) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'setting labels needs the full replacement list; a missing one is refused instead of being read as "remove every label"') }
  }
  const normalized = wantedLabelsOf(labels)
  if (!normalized.ok) return { ok: false, error: normalized.error }
  const wanted = normalized.data

  const expected = opts && typeof opts.expectedUpdatedAt === 'string' ? opts.expectedUpdatedAt : ''
  if (expected) {
    const current: any = await gql<any>(ctx, account, { query: ISSUE_UPDATED_AT, variables: { id: key }, bucket: 'read' })
    if (!current.ok) return { ok: false, error: current.error }
    const node = current.data && current.data.issue
    if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'the ticket ' + key + ' does not exist, so its labels cannot be changed') }
    if (String(node.updatedAt || '') !== expected) {
      return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'the ticket changed since ' + expected + ' (now ' + String(node.updatedAt || 'unknown') + '), so its labels were not changed') }
    }
  }

  // 空的替换清单就是「清空标签」。这一格**不发任何查询**：既不用知道票上现在有什么标签，
  // 也不用把名字换成 id —— 那样做只是多花请求，还会在「票上一堆标签、一个都不留」时读到一半就失败。
  if (wanted.length === 0) return writeLabelIds(ctx, account, key, [])

  const resolved = await resolveLabelIds(ctx, account, wanted, teamKey)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return writeLabelIds(ctx, account, key, resolved.data)
}
