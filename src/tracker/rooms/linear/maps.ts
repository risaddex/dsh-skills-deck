/**
 * src/tracker/rooms/linear/maps.ts —— 地图薄查（契约 `Tracker.listMaps` 的 Linear 实现，#89）
 *
 * ── 为什么要有这一条 ──────────────────────────────────────────────────────────────
 * Linear 房原先没有 `listMaps`，注册表补的桩回 `unsupported`。两个调用者（`deck_context` 与
 * `deck_issue_list` 的 `type=map`）都把「不支持」当成「退回老路」，老路是 `list(repo, { type: 'map' })`，
 * 而本房的 `list` 翻不动 `type` 这一格（read.ts 的 unsupportedFilters），于是老路也失败：
 * `deck_context` 回 `partial` 加 `maps: []`（一个读起来像「仓库没有地图」的零），`deck_issue_list` 什么都不回。
 * 有了这一条，两个调用者拿到的是真薄行；「不支持」这个答案从此不再出现在本房的地图清单上，
 * 所以真实的失败（网络、凭据、回包形状）一律如实报错，绝不再被伪装成「不支持」而引去那条走不通的老路。
 *
 * ── 怎么问（契约在 contract/operations.ts 的 listMaps，GitHub、GitLab、本地 Markdown 三房同一口径）──────────
 *  · 只要地图：标签条件 `wayfinder:map`，由服务端按不分大小写筛（buildIssuesFilter 同一个拼法，与本房的列表、计数共用）；
 *  · 状态不筛：开着的、关了的地图都要；时间窗口不给：要全部，不是「某时刻以来的变化」；
 *  · 行是薄的：只要 key / title / state / url 四格（选择集见 queries.ts 的 MAP_LIST_QUERY，没有嵌套连接，一页很便宜）；
 *  · 翻页按创建时间（翻页期间一张地图被改动也不会挪位置），翻完在内存里按更新时间倒序重排，缺时间的沉底，
 *    同时间的保持抓取先后（稳定，不让人猜）；同一张地图出现在两页里只留一份（见下）。
 *
 * ── 完整度：拿不全的几条路（与 GitLab 房的地图薄查同一条纪律：绝不返回半份数据装作拉全了）──────────────────
 *  · 某一页失败 → 整趟失败，带那一页的失败档（网络、凭据、限流各自的类别原样保留），不返回前几页当作全部；
 *  · 回包没有 `nodes` 数组、没有 `pageInfo.hasNextPage`，或说有下一页却不给新游标 → 整趟失败（parse）：
 *    不知道有没有读完，不替 Linear 回答「读完了」；
 *  · 某一行读不出来（不是对象、没有标识符）→ 整趟失败（parse）。薄行结果里没有「丢了几行」这一格，
 *    悄悄丢掉的行会让清单看起来是全的，所以宁可失败；
 *  · 翻满 PAGINATION.linear.mapListMaxPages 页、Linear 仍说有下一页 → 仍回成功，但 `truncated: true`，调用方据此说清「只取回了前 N 张」；
 *    恰好翻满、Linear 说到此为止 → 是读全了，不标截断（要证明还有下一页才标，证明就是 Linear 的 hasNextPage）；
 *  · `total`：Linear 的连接没有 totalCount（paging.ts 头注释），所以它是「这一趟取回的行数」，撞上限时只是一个下界，
 *    由 `truncated` 单独说明，不假装知道更多。
 * 页大小（listPageSize）与页数上限（mapListMaxPages）只从共享分页表取，不在这里写数字（tests/verify-pagination-limits.ts 守着）。
 * 上限的 10 页是与 GitHub、GitLab 对齐的取值，不是在真实 Linear 工作区里量出来的。
 *
 * ── 日志 ──────────────────────────────────────────────────────────────────────────
 * 不新增事件，也不新增 `read.degraded` 的原因取值（GitLab 房的地图薄查同一个做法）：每一页的那一笔出站由 client.ts 的
 * `linear.request`（按需）记；失败直接回错，由 `deck_context` 的回执（reason 与 listError）说明；截断由结果里的
 * `truncated` 与回执 notes 说明。入参没有可拒的（只有账号），所以没有「请求之前就被拒」的分支。
 */
import type { OpContext } from '../../contract/contexts.js'
import { PAGINATION } from '../../contract/pagination.js'
import type { MapListOpResult, MapRow } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type GqlResult, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { MAP_LIST_QUERY } from './queries.js'
import { buildIssuesFilter } from './read.js'

/** 地图标签：服务端筛用它，与另外三房同一个小写名（服务端按不分大小写比，见 buildIssuesFilter）。 */
const MAP_LABEL = 'wayfinder:map'

/** 每页张数与页数上限：只从共享表取，不在这里写数字。 */
const PAGE_SIZE = PAGINATION.linear.listPageSize
const MAX_MAP_PAGES = PAGINATION.linear.mapListMaxPages

/** 一页回包里本文件读到的几格：票的连接。节点与游标信息都按 unknown 收，运行时逐个认形状。 */
interface MapsReply {
  issues?: {
    nodes?: unknown[] | null
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null
  } | null
}

/** 取回来、还没排序的一行：带更新时间与抓取序号，排序用，交出去之前剥掉。 */
interface KeptRow {
  row: MapRow
  updatedAt: string
  seq: number
}

/**
 * 一个节点 → 薄行加更新时间；读不出来（不是对象、没有标识符）回 null，由调用方整趟失败。
 * 键、状态、地址的取法全部复用 `issueOf`，与本房其余读操作同一份规则（`stateOf` 的开关表只在 normalize.ts 一处）。
 */
function rowOf(node: unknown, seq: number): KeptRow | null {
  if (!node || typeof node !== 'object') return null
  const issue = issueOf(node as LinearIssueNode)
  if (!issue.key) return null
  return {
    row: { key: String(issue.key), title: issue.title, state: issue.state, url: issue.url },
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
    seq,
  }
}

/**
 * 地图薄查：翻页取回全部地图（最多 MAX_MAP_PAGES 页），回四格行。
 *
 * @param ctx 本次调用的上下文（出站请求与日志都走它）
 * @param account 这一趟用的 Linear 账号（由 index.ts 的 `using` 解出）
 */
export async function listMapsOf(ctx: OpContext, account: LinearAccount): Promise<MapListOpResult> {
  // 筛选条件只有标签这一格；状态与时间窗口都不给，所以回来的是开着的加关了的全部地图。
  const filter = buildIssuesFilter({ labels: [MAP_LABEL] }) ?? null
  const kept: KeptRow[] = []
  // 同一张地图出现在两页里（翻页期间它被改动挪了位置）只留先读到的那一份，不让清单里出现同一个键两次。
  const seen = new Set<string>()
  let seq = 0
  let truncated = false
  let after: string | null = null
  for (let page = 0; ; page += 1) {
    // 页数上限：到了还没读到底，就把这一趟标成「截断」，绝不死翻、也绝不当成读全了。
    if (page >= MAX_MAP_PAGES) { truncated = true; break }
    const replied: GqlResult<MapsReply> = await gql<MapsReply>(ctx, account, {
      query: MAP_LIST_QUERY,
      variables: { first: PAGE_SIZE, after, filter },
      bucket: 'read',
    })
    // 某一页失败：此前页攒的行全部作废，不回半份；失败档原样带出（网络、凭据、限流各自的类别不变）。
    if (!replied.ok) return { ok: false, error: replied.error }
    const conn: NonNullable<MapsReply['issues']> | null | undefined = replied.data ? replied.data.issues : null
    if (!conn || !Array.isArray(conn.nodes)) {
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Listing maps: the reply has no issues.nodes (wrong shape, not guessing)') }
    }
    const info = conn.pageInfo
    if (!info || typeof info.hasNextPage !== 'boolean') {
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Listing maps: the connection carried no pageInfo.hasNextPage, so whether the list ended is unknown (refusing to claim either answer)') }
    }
    for (const node of conn.nodes) {
      const got = rowOf(node, seq)
      if (!got) {
        return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Listing maps: a row came back without a ticket identifier, so it cannot be listed (refusing to return a list with a row missing)') }
      }
      if (seen.has(got.row.key)) continue
      seen.add(got.row.key)
      kept.push(got)
      seq += 1
    }
    // Linear 说到此为止：读全了。这是「完整」唯一的证明，不靠「这一页没装满」去猜。
    if (info.hasNextPage === false) break
    const next: string = String(info.endCursor || '')
    if (!next || next === after) {
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Listing maps: Linear says there is a next page but gave no new cursor (refusing to pretend the last page was reached)') }
    }
    after = next
  }
  // 更新时间倒序：缺时间的沉底（空串最小），同时间按抓取序（稳定，不让人猜）。
  kept.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.seq - b.seq
    if (!a.updatedAt) return 1
    if (!b.updatedAt) return -1
    return a.updatedAt < b.updatedAt ? 1 : -1
  })
  const rows = kept.map((k) => k.row)
  return { ok: true, data: { rows, total: rows.length, truncated } }
}
