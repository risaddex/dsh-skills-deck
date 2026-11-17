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
import type { OpResult } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
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
const LABELS_BY_NAME = 'query DeckLabelsByName($names: [String!]!) { issueLabels(filter: { name: { in: $names } }, first: 250) { nodes { id name color team { id key } } } }'

/** 缺的名字建出来（§4：`IssueLabelCreateInput` 只有 `name` 必填，`color` 不接受 null）。 */
const LABEL_CREATE = 'mutation DeckIssueLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color team { id key } } } }'

/** 团队 key → 团队 id：标签的 `teamId` 要 UUID，而绑定声明里写的是 key（与建票同一条路）。 */
const TEAMS_BY_KEY = 'query DeckTeamsByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }'

/** 调用方给的一条标签，归一成这里真正要用的三格。 */
interface WantedLabel {
  /** 标签名，**原样**用：契约说名字原样读回，所以写也原样写，不折叠大小写、不去空白。 */
  name: string
  /** 建新标签时用的颜色，形如 `#EB5757`；空串表示调用方没给，建的时候整个省掉。 */
  color: string
  /** 建新标签时带的说明；空串表示不传。 */
  description: string
}

/**
 * 契约的颜色写法是「不带井号的六位十六进制」，Linear 收 `#EB5757` 这种（§4 的 `color` 字段说明）。
 *
 * 认不出来就回空串让调用方省掉这一格，由 Linear 用它自己的默认色：猜一个近似值等于写下一个
 * 谁都没要过的颜色，而颜色在这个后端没有回读校验的位置让人发现错了。
 */
function hexColorOf(color: unknown): string {
  const digits = String(color ?? '').trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(digits) ? '#' + digits : ''
}

/**
 * 把 `LabelInput[]` 归一成 `WantedLabel[]`，并按名字去重（先出现的那个说了算）。
 *
 * 为什么要去重：Linear 的 `labelIds` 是一组标签，同一个 id 写两次没有意义，还可能被判成非法输入；
 * 而调用方那张清单常常是「票上已有的 + 这次加的」拼起来的，重名是常态而不是错误。
 * 为什么名字不合规要整条拒绝而不是跳过：少贴一个标签而照样回「成功」，调用方只会以为已经贴上了。
 */
function wantedLabelsOf(labels: LabelInput[]): OpResult<WantedLabel[]> {
  const list = Array.isArray(labels) ? labels : []
  const seen = new Set<string>()
  const wanted: WantedLabel[] = []
  for (const item of list) {
    const source: any = item
    const name = typeof source === 'string' ? source : String((source && source.name) || '')
    // 全是空白的名字不是「一个叫空的标签」，而是调用方把一个空值当成了标签：拒绝，不猜它的本意。
    if (!name.trim()) {
      return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'a label needs a name: Linear names are 1 to 80 characters, and a blank one cannot be matched or created') }
    }
    if (seen.has(name)) continue
    seen.add(name)
    wanted.push({
      name,
      color: typeof source === 'string' ? '' : hexColorOf(source && source.color),
      description: typeof source === 'string' ? '' : String((source && source.description) || ''),
    })
  }
  return { ok: true, data: wanted }
}

/**
 * 同名标签可能不止一条：工作区标签一处（§4：`IssueLabel.team` 为 null 就是工作区标签），
 * 各团队标签各一处。名字是调用方给的唯一线索，所以按固定顺序挑一条，不让结果随回包顺序变：
 *   ① 绑定声明里那个团队的标签 —— 调用方看的通常就是本团队那份清单；
 *   ② 工作区标签 —— 它对每个团队都可用，是被 Linear 拒掉的可能性最小的一种；
 *   ③ 其余任意一条 —— 别的团队的标签可能被 Linear 以「不可用于这张票的团队」拒掉，
 *      那时会如实失败，绝不假装已经贴上。
 */
function pickLabel(found: any[], name: string, teamKey: string): any | null {
  const same = found.filter((node: any) => node && String(node.name || '') === name)
  if (same.length === 0) return null
  const wantedTeam = String(teamKey || '').toUpperCase()
  if (wantedTeam) {
    const own = same.find((node: any) => node.team && String(node.team.key || '').toUpperCase() === wantedTeam)
    if (own) return own
  }
  // 只认「本团队的」或「工作区的」：别的团队的标签**不能**用在这张票上（Linear 要求标签对该票所在
  // 团队可用，见研究笔记 §4）。回 null 让上游把它当缺失、走建标签那条路 —— 拿另一个团队的 id 去写，
  // 换来的是对端拒绝，而调用方看到的是一次「本来合法」的失败（PR #32 review 的 P2）。
  return same.find((node: any) => !node.team) || null
}

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

  const lookup: any = await gql<any>(ctx, account, { query: LABELS_BY_NAME, variables: { names: wanted.map((item) => item.name) }, bucket: 'read' })
  if (!lookup.ok) return { ok: false, error: lookup.error }
  const nodes = (lookup.data && lookup.data.issueLabels && lookup.data.issueLabels.nodes) || []
  const found = Array.isArray(nodes) ? nodes : []

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
    for (const want of missing) {
      const created = await createLabel(ctx, account, want, team.data)
      // 建到一半失败就停：已经建出来的标签留在工作区里（一张没人用的标签无害），而票上一个字都没改。
      // 不删它们，是因为删标签会连带摘掉别处正在用的同一份（§4 的 issueLabelDelete 就是这样），
      // 为了收拾自己的一次失败去动别人的数据，代价比留下一个空标签大得多。
      if (!created.ok) return { ok: false, error: created.error }
      ids.set(want.name, created.data)
    }
  }

  const ordered: string[] = []
  for (const want of wanted) {
    const id = ids.get(want.name)
    if (!id) return { ok: false, error: linearError(ERROR_KIND.PARSE, 'the label ' + want.name + ' could not be resolved to an id, so the ticket was left untouched') }
    ordered.push(id)
  }
  return writeLabelIds(ctx, account, key, ordered)
}
