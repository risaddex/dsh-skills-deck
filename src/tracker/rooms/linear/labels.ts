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
import { labelNameFilter, pickLabel, wantedLabelsOf, type WantedLabel } from './label-match.js'
// 建缺的标签那一件（团队 id、建标签、建不成时的说明）住在 label-create.ts：#92 加日志之后本文件越过每文件 20 KB。
import { createLabel, labelCreateFailure, teamIdOfIssue } from './label-create.js'
// #92：这一步的两条结论线（忽略大小写对上、建标签被拒）住在同目录的 label-log.ts，本文件只负责给事实。
import { emitLabelCreateFail, emitLabelMatch } from './label-log.js'
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
  // #92：这一趟的起算点，两条结论线都记「走到这里花了多久」（查一次、建几个、再回话，可能隔着两次网络）。
  const startedAt = Date.now()
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
  // #92：靠忽略大小写对上的那些对（要 `bug`、对上 `Bug`）。`pickLabel` 只在找不到同一拼写时才回别的写法，
  // 所以「对上的写法与请求的写法不同」就是「这一趟确实靠忽略大小写才成功」的判据。
  const folded: Array<{ wanted: string; found: string }> = []
  for (const want of wanted) {
    const match = pickLabel(found, want.name, teamKey)
    const id = match ? String(match.id || '') : ''
    if (id) {
      ids.set(want.name, id)
      if (String(match.name || '') !== want.name) folded.push({ wanted: want.name, found: String(match.name || '') })
    } else missing.push(want)
  }
  // 一条解析落一行（不按名字各记一行）：要回答的是「这一趟走没走过忽略大小写那条路」，不是逐名字的流水。
  // 一个都没折也照记：`folded: 0` 说「查过、一个都没折」，与「这一条根本没发」（没走到这一步）是两件事。
  emitLabelMatch(ctx, { requested: wanted.length, folded: folded, startedAt: startedAt })

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
      if (!created.ok) {
        // #92：这一档此前一条日志都没有，事后只能从回执反推「标签这一步被拒了」与「缺的是哪一批」。
        emitLabelCreateFail(ctx, { requested: wanted.length, missing: missing.slice(index).map((one) => one.name), kind: String(created.error.kind || ''), startedAt: startedAt })
        return { ok: false, error: labelCreateFailure(created.error, missing.slice(index), teamKey) }
      }
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
