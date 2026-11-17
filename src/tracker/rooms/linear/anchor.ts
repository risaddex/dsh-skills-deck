/**
 * src/tracker/rooms/linear/anchor.ts —— 建票前按幂等锚回查（契约 `CreateInput.idempotencyKey`，#33）
 *
 * 要解决的只有一件事：票已经建成了，只是调用方没收到回答（超时、连接被掐断），外层一重试就再建一张。
 * 契约（`contract/contract-idempotency.ts`）答应三条，这里逐条兑现：
 *   1. 锚落在票面上：正文第一行的 HTML 注释（`anchorLineFor`），渲染后看不见，读回来还在；
 *   2. 建前必须按锚回查，而且回查读的是**票面**上的锚，不是内存里的表 —— 进程重启之后内存表没了、票还在；
 *   3. 命中就把旧票交回去、不发任何写请求；没命中才建；**拿不准必须如实失败、绝不建票**。
 *
 * 怎么查：Linear 的 `issues` 连接接受 `IssueFilter`，其中 `description` 是可空字符串比较器，支持 `contains`
 * （官方过滤文档 https://linear.app/developers/filtering 逐字列了 `contains` 与 `description: { null: true }`），
 * 所以用「本团队 + description 含这个键」把候选收窄到服务端，再把每个候选的正文读回来过一遍共享的
 * `matchAnchor`（判据只有一份：锚得能从票面原文读回来，且票必须还开着）。服务端的 `contains` 只用来**收窄**，
 * 不当证据：它是子串匹配，键 `a1` 会撞上写着 `a12` 的票，最后认不认只看 `matchAnchor`。
 *
 * 为什么限定本团队：同一个键在两个团队里各有一张票时，复用错的那张等于把另一个团队的票当成这次动作的结果。
 * 为什么翻页要到底：只看第一页就判「没找到」，正是重复建票的来路；到上限还没翻完就按「拿不准」失败。
 */
import type { Issue } from '../../contract/entities.js'
import type { OpContext } from '../../contract/contexts.js'
import type { OpResult } from '../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { PAGINATION } from '../../contract/pagination.js'
import { anchorLineFor, matchAnchor, isAnchorHit, stripAnchorLines } from '../../../refresh/contract/idempotency-keys.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE, MAX_PAGE } from './queries.js'

/** 本团队里「正文含这个键」的开着的票。`description` 过滤与 `team.key` 过滤都是 `IssueFilter` 的字段。 */
const ISSUES_BY_ANCHOR = 'query DeckIssuesByAnchor($first: Int!, $after: String, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter) { nodes { ...LinearIssueCore } pageInfo { hasNextPage endCursor } } } ' + ISSUE_CORE

/** 回查的结论：没找到照常建、找到了复用、没做成如实失败（绝不把拿不准当没找到）。 */
export type AnchorLookup =
  | { ok: true; hit: true; issue: Issue }
  | { ok: true; hit: false }
  | { ok: false; error: ReturnType<typeof linearError> & { stage?: string } }

/** 回查没做成时的失败：只陈述事实，并带上 stage 让调用方知道「票没建、原样重试是安全的」。 */
function lookupFailure(kind: string, message: string): { ok: false; error: ReturnType<typeof linearError> & { stage?: string } } {
  const error = linearError(kind as never, 'The lookup for a create with an idempotency anchor could not be completed: ' + message + '; no ticket was created.')
  return { ok: false, error: Object.assign(error, { stage: TRACKER_ERROR_STAGE.ANCHOR_LOOKUP }) }
}

/**
 * 把锚那一行拼到正文前面；不带锚时原样返回。拼之前先剥掉正文里已有的锚行，
 * 免得调用方手写过同一行时落成两行相同的注释（与 GitHub 房的 `withAnchor` 同一做法）。
 */
export function withAnchor(body: string, key: string): string {
  if (!key) return body
  return anchorLineFor(key) + stripAnchorLines(body)
}

/**
 * 建前回查。`key` 必须已经过 `checkIdempotencyKey`；`teamKey` 是绑定声明里的团队键。
 * 候选按 `updatedAt` 之外的顺序没有意义，所以不依赖顺序，只靠翻到底。
 */
export async function lookupByAnchor(ctx: OpContext, account: LinearAccount, teamKey: string, key: string): Promise<AnchorLookup> {
  const filter = { team: { key: { eq: teamKey } }, description: { contains: key } }
  const candidates: { key: string; body: string; state: 'open' | 'closed' | undefined }[] = []
  const issues = new Map<string, LinearIssueNode>()
  let after: string | null = null
  const maxPages = PAGINATION.linear.countMaxPages
  for (let page = 0; page < maxPages; page += 1) {
    const result: any = await gql<any>(ctx, account, { query: ISSUES_BY_ANCHOR, variables: { first: MAX_PAGE, after, filter }, bucket: 'read' })
    if (!result.ok) return lookupFailure(result.error.kind, result.error.message)
    const conn = result.data && result.data.issues
    const nodes = conn && conn.nodes
    if (!Array.isArray(nodes)) return lookupFailure(ERROR_KIND.PARSE, 'Linear answered the anchor search without a node list')
    for (const node of nodes as LinearIssueNode[]) {
      const identifier = String((node && node.identifier) || '')
      if (!identifier) continue
      const row = issueOf(node)
      candidates.push({ key: identifier, body: row.body, state: row.state })
      issues.set(identifier, node)
    }
    if (!(conn.pageInfo && conn.pageInfo.hasNextPage)) break
    if (!conn.pageInfo.endCursor) return lookupFailure(ERROR_KIND.PARSE, 'Linear said there are more tickets but gave no cursor to read them')
    after = String(conn.pageInfo.endCursor)
    // 翻到上限还没到底：宁可失败，也不在「可能没看全」的名单上判「没找到」。
    if (page === maxPages - 1) return lookupFailure(ERROR_KIND.UNSUPPORTED, 'more tickets carry that text than the room will read in one go, so the anchor cannot be ruled out')
  }
  const match = matchAnchor(candidates, undefined, key)
  if (isAnchorHit(match)) {
    const node = issues.get(String(match.key))
    if (!node) return lookupFailure(ERROR_KIND.PARSE, 'the matching ticket ' + String(match.key) + ' was not in the page that was read')
    return { ok: true, hit: true, issue: issueOf(node) }
  }
  // miss 与 mismatch（候选在、但锚对不上或已关闭）都意味着「没有可复用的票」，照常建。
  // unsupported 只会来自空键，而空键在调用前已被挡掉，这里不会走到。
  return { ok: true, hit: false }
}
