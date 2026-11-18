/**
 * src/tracker/rooms/linear/sub-issues.ts —— 取一张票的子票（契约第 21 条 `Tracker.listSubIssues` 的 Linear 实现，#50）
 *
 * ── 为什么要有这一条 ──────────────────────────────────────────────────────────────
 * 两个房外的调用者要「某一张票的全部子票」：地图电话 `wf.mapTickets`（src/host/mapTickets.ts）与快照的工作集
 * （src/host/tracker/snapshotWorkingSet.ts）。Linear 房原先没有这条操作，注册表补的桩回 unsupported，
 * 两个调用者都当「这个后端不提供」跳过，于是 Linear 地图只显示快照那一页列表里碰巧带着的子票，不在那一页里的就一张都没有。
 * 宿主日志里看到的是 `quota.op` 记着 `listSubIssues`、`backendId: linear`、`ok:false`、`requests:0`。
 *
 * ── 怎么问 ─────────────────────────────────────────────────────────────────────
 * 一张父票一条连接：`issue(id: <键>) { children(first, after, orderBy) }`（queries.ts 的 SUB_ISSUES_QUERY）。
 *  · 父票的键是**文本**：`ENG-12` 这种标识符或 UUID，原样交给 Linear，不转数字（Linear 的键不是数字，#45 已经把键一路当文本带下来）；
 *  · 页大小显式：每页 PAGINATION.linear.subIssuesPageSize（50）张，理由是查询复杂度，见 pagination.ts 与 queries.ts；
 *  · 顺序有名字：SUB_ISSUES_ORDER（创建时间，新造的在前），翻页期间它不挪位置；
 *  · 游标是 Linear 给的 endCursor，原样回传，不解析不拼装。
 *
 * ── 完整度：拿不全的几条路（与 GitHub、GitLab 两房同一条纪律：绝不返回半份数据装作拉全了）──────────────
 *  · 某一页失败 → 整体失败，带那一页的失败档，不返回前几页当作全部；
 *  · 连接没有 `nodes` 数组、没有 `pageInfo.hasNextPage`，或说有下一页却不给游标 → 整体失败（parse）：
 *    不知道有没有读完，不替 Linear 回答「读完了」；
 *  · 读到 1000 张硬上限、而 Linear 还说有下一页 → 仍回成功，但 `capped: true`，provenance 的子票组记 `truncated`；
 *  · 翻到页数上限（PAGINATION.linear.subIssuesMaxPages）还没到底 → 同样标成 `capped`；
 *  · 恰好 1000 张且 Linear 说到此为止 → 是读全了，不标 capped（与 GitHub 房在边界上更保守的写法不同：
 *    那里一到 1000 就标，这里要证明还有下一页才标，因为 Linear 的 `hasNextPage` 就是这个证明）；
 *  · `total`：Linear 的连接没有 totalCount（paging.ts 头注释），所以它是「Linear 这一趟交给我的行数」= fetched + dropped，
 *    撞上限时只是一个下界，由 `capped` 单独说明，不假装知道更多；
 *  · `missing`：恒为 0 —— 没有后端总数可以与拿回来的行对不上；能少的只有被上限截断的部分，那件事归 `capped`；
 *  · `dropped`：拿到了行却读不出来的条数（节点是空的、不是对象、没有标识符），记下来，不混进 fetched，
 *    provenance 的行组记 `truncated`。
 * 两个调用者今天只读 `capped` 与 `missing`（地图电话还读 total、fetched），所以「不全」必须落在 `capped` 上，
 * 它们就会照 GitHub 那条路把「只加载了前 1000 张」说出来；provenance 是给读它的新调用方的更细的交代，不替代这几格。
 *
 * ── 日志（日志纪律，docs/design/335-logging-contract.md）──────────────────────────────
 * 每一页的那一笔出站由 client.ts 的 `linear.request`（按需）记。这里只在「这一趟没读成或没读全」时多记一行
 * 常驻警告 `read.degraded`（沿用全仓已登记的事件与字段 op / reason / latencyMs / opId，不新开事件名）：
 *  `subIssues:truncated` 读到上限被截断、`subIssues:page-fail` 某一页没取回来、`subIssues:notfound` 父票不在、
 *  `subIssues:shape` 回包缺这一读必须有的东西。读全的那一趟不记。
 * 字段只有短枚举与毫秒数、操作编号：**父票的键、账号、请求头、Linear 的原文一个字都不记**。
 * 入参被拒（键是空的）发生在任何请求之前，没有外部调用，所以不记。
 */
import type { Issue } from '../../contract/entities.js'
import type { OpContext } from '../../contract/contexts.js'
import { OPERATION_ENCYCLOPEDIA, FIELD_GROUPS, type FieldGroup } from '../../contract/operations-encyclopedia.js'
import { PAGINATION } from '../../contract/pagination.js'
import type { FieldGroupCompleteness, ReadCompleteness, ReadProvenance } from '../../contract/read-provenance.js'
import type { SubIssueListResult } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { guardEmit, ms } from '../../kernel/log-emit.js'
import { gql, type GqlResult, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { SUB_ISSUES_QUERY } from './queries.js'
import { withBlockers } from './read.js'
import type { RelationConnection } from './relations.js'

/** 每页张数、总张数上限、页数上限：只从共享表取，不在这里写数字（tests/verify-pagination-limits.ts 守着）。 */
const PAGE_SIZE = PAGINATION.linear.subIssuesPageSize
const MAX_SUB_ISSUES = PAGINATION.linear.subIssuesMax
const MAX_PAGES = PAGINATION.linear.subIssuesMaxPages

/** 这一读的来源渠道名：契约的 `source` 是开放字符串，非 GitHub 的房写自家通道（`gitlab-api`、`markdown-files` 同一个起法）。 */
const SOURCE = 'linear-graphql'

/** 子票连接的游标信息：只有这两格被读，`hasNextPage` 按 unknown 收，是为了在运行时认清它是不是真的布尔值。 */
interface SubIssuesPageInfo {
  hasNextPage?: unknown
  endCursor?: unknown
}

/** 子票连接：一页节点（按 unknown 收，逐个认形状）加游标信息。 */
interface SubIssuesConnection {
  nodes?: unknown[] | null
  pageInfo?: SubIssuesPageInfo | null
}

/** 一页回包里本文件读到的几格：父票的标识符与它的子票连接。 */
interface SubIssuesReply {
  issue?: {
    identifier?: string
    children?: SubIssuesConnection | null
  } | null
}

/** `read.degraded` 在这一读上的原因取值（沿用 GitHub、GitLab 两房 subIssues 那几条，含义相同）。 */
type DegradedReason = 'subIssues:truncated' | 'subIssues:page-fail' | 'subIssues:notfound' | 'subIssues:shape'

/**
 * 记一行「这一趟没读成或没读全」（常驻 #108 `read.degraded`，警告级）。
 * 拿不到 logEvent 就静默跳过：读路径不许因为日志而失败（壳在 kernel/log-emit.ts）。
 * `logEvent(...)` 这一行必须留在这里、字段字面量就摆在调用旁边：全仓的字段白名单门禁（tests/verify-log-fields.ts）是照源码认形状的。
 */
function emitSubIssuesDegraded(ctx: OpContext, reason: DegradedReason, startedAt: number): void {
  guardEmit(ctx, (c) => {
    c.logEvent('warn', 'read.degraded', { op: 'subIssues', reason: reason, latencyMs: ms(Date.now() - startedAt), opId: String(c.opId || '') })
  })
}

/** 进程内递增的读序号：保证同一毫秒里的两趟读也有不同的起点标记（与 GitHub 房的 `beginRead` 同一个格式，见下）。 */
let readSequence = 0

/**
 * 起点标记，格式 `read-v1-<毫秒时间戳>-<六位序号>`。
 * 为什么这里自己生成而不是引 GitHub 房的 `beginRead`：那份住在 `rooms/github/routing/`，Linear 房跨房 import 会被
 * `.dependency-cruiser.cjs` 的 `cross-room-import` 判红（paging.ts 头注释同一件事）；格式照抄，宿主的版本门按同一个形状读它。
 */
function startVersionOf(startedAt: number): string {
  readSequence = (readSequence % 999999) + 1
  return 'read-v1-' + String(startedAt) + '-' + String(readSequence).padStart(6, '0')
}

/**
 * 这一趟读的来源与按字段组完整度（契约 `ReadProvenance`，#1686 起 listSubIssues 带它）。
 *
 * 字段组只表这两组（操作百科为 listSubIssues 声明的 `subIssues`、`row`），两组分开报，因为排查方向不同：
 *  · `subIssues` 说「这份子票名单有没有读到底」：被上限截断、翻到页数上限都记 `truncated`；
 *  · `row` 说「读到的行有没有当场丢掉」：有丢弃的行记 `truncated`。
 * 汇总 `completeness` 与 `missingFieldGroups` 按契约的定义由两组派生（有截断就是 truncated，缺失组顺序照 FIELD_GROUPS）。
 */
function provenanceOf(startedAt: number, startVersion: string, facts: { capped: boolean; dropped: number }): ReadProvenance {
  const declared: readonly FieldGroup[] = OPERATION_ENCYCLOPEDIA.listSubIssues.fieldGroups
  const fieldGroups: Partial<Record<FieldGroup, FieldGroupCompleteness>> = {
    subIssues: facts.capped ? 'truncated' : 'complete',
    row: facts.dropped > 0 ? 'truncated' : 'complete',
  }
  const missing = FIELD_GROUPS.filter((group) => declared.includes(group) && fieldGroups[group] !== 'complete')
  const completeness: ReadCompleteness = declared.some((group) => fieldGroups[group] === 'truncated') ? 'truncated' : 'complete'
  return { operation: 'listSubIssues', source: SOURCE, completeness, fieldGroups, missingFieldGroups: missing, durationMs: Math.max(0, Math.trunc(Date.now() - startedAt)), startVersion }
}

/** 一个子票节点 → 契约的票（带阻塞者，规则与列表同一份）；读不出来（空节点、没有标识符）回 null，由调用方记入 dropped。 */
function rowOf(node: unknown): Issue | null {
  try {
    if (!node || typeof node !== 'object') return null
    const issue = withBlockers(issueOf(node as LinearIssueNode), node as { inverseRelations?: RelationConnection | null })
    return issue.key ? issue : null
  } catch {
    return null
  }
}

/**
 * 取一张票的全部子票：按页翻到底，最多 1000 张。
 * `mapKey` 收得比契约宽（`unknown`）：宿主电话是 JavaScript，键可能不是字符串；运行时转成文本并去掉首尾空白，别的什么都不做。
 */
export async function listSubIssuesOf(ctx: OpContext, account: LinearAccount, mapKey: unknown): Promise<SubIssueListResult> {
  // 这一笔的起点：耗时与来源记录都从入口算起。
  const startedAt = Date.now()
  const startVersion = startVersionOf(startedAt)
  const key = String(mapKey === null || mapKey === undefined ? '' : mapKey).trim()
  if (!key) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Fetching child tickets: no parent ticket key was given') }

  const items: Issue[] = []
  let dropped = 0
  let capped = false
  let after: string | null = null
  for (let page = 0; ; page += 1) {
    // 页数上限：到了还没到底，就把这一趟标成「截断」，绝不死翻、也绝不当成读全了。
    if (page >= MAX_PAGES) { capped = true; break }
    const replied: GqlResult<SubIssuesReply> = await gql<SubIssuesReply>(ctx, account, {
      query: SUB_ISSUES_QUERY,
      variables: { id: key, first: PAGE_SIZE, after },
      bucket: 'read',
    })
    if (!replied.ok) {
      emitSubIssuesDegraded(ctx, 'subIssues:page-fail', startedAt)
      return { ok: false, error: replied.error }
    }
    const parent: SubIssuesReply['issue'] = replied.data ? replied.data.issue : null
    if (!parent) {
      emitSubIssuesDegraded(ctx, 'subIssues:notfound', startedAt)
      return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Fetching child tickets: Linear has no ticket ' + key + ' (or this account cannot see it)') }
    }
    const conn: SubIssuesConnection | null | undefined = parent.children
    if (!conn || !Array.isArray(conn.nodes)) {
      emitSubIssuesDegraded(ctx, 'subIssues:shape', startedAt)
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Fetching child tickets: the reply has no children.nodes (wrong shape, not guessing)') }
    }
    const info: SubIssuesPageInfo | null | undefined = conn.pageInfo
    if (!info || typeof info.hasNextPage !== 'boolean') {
      emitSubIssuesDegraded(ctx, 'subIssues:shape', startedAt)
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Fetching child tickets: the connection carried no pageInfo.hasNextPage, so whether the list ended is unknown (refusing to claim either answer)') }
    }
    for (const node of conn.nodes) {
      // 硬上限：再来一张就是第 1001 张，停下并把这个事实带回去（界面据此明说只加载了前 1000 张）。
      if (items.length >= MAX_SUB_ISSUES) { capped = true; break }
      const row = rowOf(node)
      if (row) items.push(row)
      else dropped += 1
    }
    if (capped) break
    // Linear 说到此为止：读全了。这是「完整」唯一的证明，不靠「这一页没装满」去猜。
    if (info.hasNextPage === false) break
    // 还有下一页，但已经装满：不是读全了，是读到了上限。
    if (items.length >= MAX_SUB_ISSUES) { capped = true; break }
    const next: string = String(info.endCursor || '')
    if (!next || next === after) {
      emitSubIssuesDegraded(ctx, 'subIssues:shape', startedAt)
      return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Fetching child tickets: Linear says there is a next page but gave no new cursor (refusing to pretend the last page was reached)') }
    }
    after = next
  }

  const fetched = items.length
  // 「读全了」这一趟不记；被截断的那一趟必须记：回的是成功，可这次只装了一部分子票。
  if (capped) emitSubIssuesDegraded(ctx, 'subIssues:truncated', startedAt)
  return {
    ok: true,
    data: { items, total: fetched + dropped, fetched, capped, missing: 0, dropped },
    provenance: provenanceOf(startedAt, startVersion, { capped, dropped }),
  }
}
