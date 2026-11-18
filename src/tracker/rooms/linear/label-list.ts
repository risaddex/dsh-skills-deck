/**
 * src/tracker/rooms/linear/label-list.ts —— 列出团队的标签与颜色（契约操作 listLabels，#48）
 *
 * 契约（正文见 `contract/contract-label-colors.ts`，返回形状见 `contract/results.ts` 的 `LabelListResult`）：
 * 返回「这个后端能改色的全部标签」，每条只有 name / color / 可选 description；颜色是不带井号的六位小写
 * 十六进制，空串表示还没配颜色；**取不全就必须整体失败**（档位只能是 env 或 network），
 * 不许把残缺清单当全量交出去 —— 列表项里没有任何位置能表示「这份清单被截断了」。
 *
 * ── 「团队的标签」指什么 ──────────────────────────────────────────────────────────
 * 绑定声明里那个团队的标签，加上工作区标签（`IssueLabel.team` 为 null，研究笔记 §4）。别的团队的标签
 * 不列：它们不能用在这个团队的票上，列出来用户会以为能给它们配色、能贴到票上。
 * 同名的团队标签与工作区标签只留一条，**团队那条说了算**：`setLabelsOfIssue` 按名字挑标签时也是团队优先
 * （`labels.ts` 的 `pickLabel`），所以这里显示的颜色就是用户贴上该名字后实际得到的那个标签的颜色。
 *
 * ── 为什么在本地按团队筛，而不是让 Linear 筛 ───────────────────────────────────────
 * 研究笔记 §4 只核对了 `Query.issueLabels` 是标准连接，没有逐字核对过「按团队 key 或团队为空」的过滤字段；
 * 向 schema 索取一个它不认的字段，换来的是整个查询被拒，功能就整个不可用。所以这里只问 `labels.ts`
 * 已经在用的那几格（`id name color team { id key }`）再加 `description`，翻到底以后在本地筛。
 * 代价是大组织里要多翻几页（每页 250 条）；页数上限见下，到顶就整体失败而不是给残缺清单。
 * 这个字段集与翻页写法没有对真实 Linear 账号跑过：它按研究笔记与同目录已有的写法拼成，
 * 若某个字段被拒，会以 HTTP 200 带 errors[] 的形式在 `gql` 那一层翻成失败，不会静默变成空清单。
 *
 * ── 这一条不挂 provenance ────────────────────────────────────────────────────────
 * `ReadProvenance` 的组装住在 GitHub 房（`rooms/github/routing/read-result.ts`），跨房 import 会被
 * `cross-room-import` 判红；`LabelListResult.provenance` 是可选格，Linear 房今天所有读都不挂它
 * （见 `paging.ts` 头注释），本条与它们一致。
 *
 * 失败是返回值不是异常；每一页请求的边界日志由 `client.ts` 的 `gql` 统一记（`linear.request`），
 * 本文件不另加日志点：整条失败的几个分支各自带着不同的话，调用方与宿主日志的 `ok:false` 一起就能定位。
 */
import type { OpContext } from '../../contract/contexts.js'
import type { LabelColor } from '../../contract/entities.js'
import type { LabelListResult } from '../../contract/results.js'
import { PAGINATION } from '../../contract/pagination.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { normalizeColor } from '../../../shared/label-color/src/colors.js'
import { gql, type GqlResult, type LinearAccount } from './client.js'
import { failLinear } from './errors.js'

/**
 * 翻页取标签：一页取满连接上限（250，Linear 自己的接口事实，见共享表），游标由调用方翻到底。
 * 不传 includeArchived：退休的标签不能再被新指派（研究笔记 §4 的生命周期一节），列出来再让人给它配色没有意义。
 */
const LABEL_LIST_QUERY = 'query DeckLabelList($after: String) { issueLabels(first: ' + PAGINATION.linear.connectionMax + ', after: $after) { nodes { id name color description team { id key } } pageInfo { hasNextPage endCursor } } }'

/** 整条失败的话统一以这一句开头：契约要求取不全时说清是「未能获取全部标签」。 */
const PREFIX = 'Could not fetch all labels: '

/** Linear 回的一条标签里本文件读的格子。 */
interface LabelNode {
  name?: unknown
  color?: unknown
  description?: unknown
  team?: { key?: unknown } | null
}

/** 一页连接的回包形状；显式写出来，是为了让 `after` 与游标之间的循环赋值不触发隐式 any 的推断环。 */
interface LabelConnectionReply {
  issueLabels?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null } | null
}

/** 一条标签 → 契约的列表项；没有名字时回 null，由调用方整条失败（列表项里没有位置表示「丢了一条」）。 */
function toLabelColor(node: LabelNode): LabelColor | null {
  if (typeof node.name !== 'string' || !node.name) return null
  // 颜色过 normalizeColor：Linear 回 `#EB5757`，契约要不带井号的六位小写；给不出合法颜色时写空串（空值，不是失败）。
  const item: LabelColor = { name: node.name, color: normalizeColor(node.color) || '' }
  if (typeof node.description === 'string' && node.description.trim() !== '') item.description = node.description
  return item
}

/**
 * 列出这个团队的全部标签（团队标签 ∪ 工作区标签）与颜色。
 *
 * `teamKey` 来自绑定声明；声明里没写团队就**拒绝**，而不是只列工作区标签：
 * 只列一半又回成功，面板上团队自己的标签会无声地回到兜底色，正是这条操作要消灭的现象。
 */
export async function listLabelsOfTeam(ctx: OpContext, account: LinearAccount, teamKey: string): Promise<LabelListResult> {
  const wantedTeam = String(teamKey || '').toUpperCase()
  if (!wantedTeam) {
    return failLinear(ERROR_KIND.ENV, PREFIX + 'the workspace binding names no Linear team, so it is unknown which team\'s labels to list. Add a `team:` line to the `# Issue tracker: linear` section of docs/agents/issue-tracker.md, then retry.')
  }

  // 同名只留一条：键是标签名（原样，不折叠大小写），团队标签覆盖工作区标签但保持第一次出现的位置。
  const byName = new Map<string, { item: LabelColor; ofTeam: boolean }>()
  let after: string | null = null
  for (let page = 0; page < PAGINATION.linear.countMaxPages; page += 1) {
    const reply: GqlResult<LabelConnectionReply> = await gql<LabelConnectionReply>(ctx, account, {
      query: LABEL_LIST_QUERY,
      variables: { after },
      bucket: 'read',
    })
    // 任何一页失败都整体失败：手上已经读到的页就是「残缺清单」，丢掉。档位沿用 gql 翻好的那一档。
    if (!reply.ok) return { ok: false, error: reply.error }
    const connection: LabelConnectionReply['issueLabels'] = reply.data.issueLabels
    // 回包里没有连接，或 nodes 不是数组：不能当成「没有标签」读，否则一个被改了形状的回包会安静地变成空清单。
    if (!connection || !Array.isArray(connection.nodes)) {
      return failLinear(ERROR_KIND.ENV, PREFIX + 'Linear answered the label query without a label list in the shape the plugin expects. This is a problem with the plugin runtime environment, not a mistake on your side. Please retry later.')
    }
    for (const raw of connection.nodes as LabelNode[]) {
      const node: LabelNode = raw && typeof raw === 'object' ? raw : {}
      const item = toLabelColor(node)
      // 单条没有名字就整条失败：静默跳过会变成用户眼里的「标签凭空少了一个」。
      if (!item) {
        return failLinear(ERROR_KIND.ENV, PREFIX + 'an entry in the label list Linear returned has no label name, so the plugin cannot confirm the list is complete. Please retry later.')
      }
      const owner = node.team
      const ofTeam = !!owner && typeof owner === 'object' && String(owner.key || '').toUpperCase() === wantedTeam
      // 既不是工作区标签（team 为 null）也不是本团队的：别的团队的标签，不列。
      if (owner && !ofTeam) continue
      const known = byName.get(item.name)
      if (!known) byName.set(item.name, { item, ofTeam })
      else if (ofTeam && !known.ofTeam) {
        known.item = item
        known.ofTeam = true
      }
    }
    const info: { hasNextPage?: boolean; endCursor?: string | null } | null | undefined = connection.pageInfo
    if (!(info && info.hasNextPage)) {
      return { ok: true, data: Array.from(byName.values(), (entry) => entry.item) }
    }
    // 说有下一页却不给游标：翻不动，只能整体失败，不能把已读到的当全量。
    if (!info.endCursor) {
      return failLinear(ERROR_KIND.ENV, PREFIX + 'Linear said there are more labels but gave no cursor to read them, so the plugin cannot confirm it read them all. Please retry later.')
    }
    after = String(info.endCursor)
  }
  // 翻到页数上限还没到底：宁可整体失败，也不把「可能没看全」的名单交出去。
  return failLinear(ERROR_KIND.ENV, PREFIX + 'this workspace has more labels than the plugin can read in one call (' + PAGINATION.linear.countMaxPages * PAGINATION.linear.connectionMax + '), so it cannot confirm it read them all. Clean up the labels you no longer need in Linear, then retry.')
}
