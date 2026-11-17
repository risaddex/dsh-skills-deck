/**
 * src/tracker/rooms/linear/relations.ts —— 阻塞关系的写侧：setBlockedBy 这一条
 *
 * 为什么单独一份文件：write.ts 那几件改的是这张票自己的字段，一次写就结束；这一条改的是图 ——
 * 读这张票现有的边、删掉这次没列出的、补上新增的，而且写下去之前还得证明不会成环。
 *
 * 事实出处 research/13-linear-write-mutations.md §5：只有一种关系类型 blocks，方向由两端念清楚，
 * issueRelationCreate({ issueId: A, relatedIssueId: B, type: blocks }) 读作「A 阻塞 B」，
 * 所以「谁阻塞我」读这张票的 inverseRelations、取 relation.issue 的标识符，删边用关系自己的 id；
 * 反向那张表（relations，我阻塞了谁）本操作不碰 —— 契约里它也只是派生视图。
 *
 * 契约的两条硬规矩在这里是行为不是表态：自己阻塞自己，在发请求之前就判掉（conflict，一个请求都不发）；
 * 成环，在所有写动作之前就判掉（conflict，一条边都不落盘，为什么必须在前面见 cycleVerdictOf）。
 * 覆盖语义：入参那一列就是写完之后这张票的全部阻塞者；删在前、加在后，删只会让图变小，造不出新的环。
 */
import type { Issue, IssueRef } from '../../contract/entities.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import type { OpContext } from '../../contract/contexts.js'
import type { SetOpts } from '../../contract/inputs.js'
import type { State } from '../../contract/identity.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { debugOn, guardEmit } from '../../kernel/log-emit.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import { issueOf, stateOf, type LinearIssueNode } from './normalize.js'
import { ISSUE_CORE, MAX_PAGE } from './queries.js'

/** 探路一页只要几条关系：正常团队里一张票的边是个位数；翻不完就说明看不全，按「证不出来」处理，不猜。 */
const NEIGHBOUR_PAGE = 50

/**
 * 环检最多走几层、最多读几张票：每读一张票就是一次出站请求，图深到十层以上时，
 * 这一趟的代价已经超过「先读清楚了再写」值当的范围。走不完就不写并如实说明，绝不把「没查到环」当成「没有环」。
 */
const CYCLE_MAX_DEPTH = 6
const CYCLE_MAX_READS = 24

/**
 * 读这张票的图：票本身（完整字段，updatedAt 也在里面）加上指向它的关系 inverseRelations。
 * 同一份文档服务三件事：票在不在、expectedUpdatedAt 对不对、现在有哪些边；写完回读也用它。
 * 票自己那一层按 schema 上限 250 取且必须拿全：覆盖语义下「删哪些」是从这份清单算出来的，少看见一条就会误删一条。
 */
const RELATION_GRAPH = 'query DeckBlockedByGraph($id: String!) { issue(id: $id) { ...LinearIssueCore inverseRelations(first: ' + MAX_PAGE + ') { pageInfo { hasNextPage } nodes { id type issue { identifier title state { type } } } } } } ' + ISSUE_CORE

/** 探路：一张票自己被谁阻塞。只要标识符，所以页可以小一点。 */
const BLOCKER_QUERY = 'query DeckBlockerNeighbours($id: String!) { issue(id: $id) { identifier inverseRelations(first: ' + NEIGHBOUR_PAGE + ') { pageInfo { hasNextPage } nodes { type issue { identifier } } } } }'

/** 建一条边：issueId 阻塞 relatedIssueId。 */
const RELATION_CREATE = 'mutation DeckRelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { id } } }'

/** 撤一条边：入参是关系自己的 id。 */
const RELATION_DELETE = 'mutation DeckRelationDelete($id: String!) { issueRelationDelete(id: $id) { success entityId } }'

/** 关系节点（只声明本文件读到的格）。type 在对象上是普通字符串、在入参里才是枚举（研究笔记 §5）。 */
interface LinearRelationNode {
  id?: string
  type?: string
  issue?: { identifier?: string; id?: string; title?: string; state?: { type?: string } | null } | null
}

/** 关系的连接形状：本文件只要一页节点和「还有没有下一页」。 */
interface RelationConnection {
  pageInfo?: { hasNextPage?: boolean } | null
  nodes?: LinearRelationNode[] | null
}

/** 读图时拿回来的票节点：完整票字段加上指向它的关系。 */
interface GraphNode extends LinearIssueNode {
  inverseRelations?: RelationConnection | null
}

/** 一条「谁阻塞我」的边：关系 id 用来删，票号与标题用来比较、也用来交回契约。 */
interface IncomingBlock {
  relationId: string
  key: string
  title: string
  state?: State
}

/** 一次写动作的结局：成功没有多余的话，失败原样带着契约的失败形状。 */
type StepResult = { ok: true } | { ok: false; error: TrackerError }

/** 票号比较：调用方可能给标识符也可能给 UUID，写法不同而指的是同一张票时也要认出来，所以去空白折大写再比。 */
function sameTicket(a: unknown, b: unknown): boolean {
  const left = String(a === null || a === undefined ? '' : a).trim().toUpperCase()
  const right = String(b === null || b === undefined ? '' : b).trim().toUpperCase()
  return left !== '' && left === right
}

/** 入参归一：去掉空白项、去掉重复项（保留第一次出现的写法与顺序）。空数组是合法输入，意思是「一条都不留」。 */
function normalizeBlockers(blockedBy: string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const source = Array.isArray(blockedBy) ? blockedBy : []
  for (const raw of source) {
    const key = String(raw === null || raw === undefined ? '' : raw).trim()
    if (!key) continue
    const norm = key.toUpperCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(key)
  }
  return out
}

/**
 * 指向这张票的 blocks 关系 → 「谁阻塞我」的边。
 * 只认 blocks：duplicate 与 related 也是关系，但它们不是阻塞，算进来的后果是「删掉一条本不该动的边」。
 * 关系 id 缺失的条目跳过（schema 里 IssueRelation.id 非空，走到这一格说明回包不完整）：宁可多建一条同样的边
 * （Linear 会复用完全一样的边），也不拿一个假 id 去删。
 */
function incomingBlocks(node: GraphNode): IncomingBlock[] {
  const conn = node.inverseRelations
  const nodes = conn && Array.isArray(conn.nodes) ? conn.nodes : []
  const out: IncomingBlock[] = []
  for (const rel of nodes) {
    if (String((rel && rel.type) || '') !== 'blocks') continue
    const source = rel && rel.issue
    const key = String((source && (source.identifier || source.id)) || '')
    const relationId = String((rel && rel.id) || '')
    if (!key || !relationId) continue
    const stateType = source && source.state ? String(source.state.type || '') : ''
    const state = stateType ? stateOf(stateType) : undefined
    out.push({ relationId, key, title: String((source && source.title) || ''), ...(state ? { state } : {}) })
  }
  return out
}

/** 一条边 → 契约的 IssueRef（标题与状态按读到的真值给，缺的格省略而不是编一个）。 */
function refOf(block: IncomingBlock): IssueRef {
  return { key: block.key, title: block.title, ...(block.state ? { state: block.state } : {}) }
}

/** 这张票自己的关系清单是否被翻页截断：截断了就不能按覆盖语义写，见主函数的说明。 */
function relationsTruncated(node: GraphNode): boolean {
  const conn = node.inverseRelations
  return !!(conn && conn.pageInfo && conn.pageInfo.hasNextPage === true)
}

/** 读这张票的图。票不存在是 notfound，其余失败原样交出去（契约：失败是返回值，不是异常）。 */
async function readGraph(
  ctx: OpContext,
  account: LinearAccount,
  key: string,
): Promise<{ ok: true; node: GraphNode } | { ok: false; error: TrackerError }> {
  const result = await gql<{ issue: GraphNode | null }>(ctx, account, { query: RELATION_GRAPH, variables: { id: key }, bucket: 'read' })
  if (!result.ok) return { ok: false, error: result.error }
  const node = result.data.issue
  if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no ticket ' + key + ', so its blockers cannot be read or changed') }
  return { ok: true, node }
}

/**
 * 问一张票自己被谁阻塞。
 * complete 为 false 表示这张票的边比一页还多：环检据此得不出结论，调用方要按「证不出来」处理。
 */
async function blockersOfTicket(
  ctx: OpContext,
  account: LinearAccount,
  id: string,
): Promise<{ ok: true; keys: string[]; complete: boolean } | { ok: false; error: TrackerError }> {
  const result = await gql<{ issue: { identifier?: string; inverseRelations?: RelationConnection | null } | null }>(ctx, account, {
    query: BLOCKER_QUERY,
    variables: { id },
    bucket: 'read',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const node = result.data.issue
  if (!node) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no ticket ' + id + ', so it cannot be a blocker') }
  const conn = node.inverseRelations
  const nodes = conn && Array.isArray(conn.nodes) ? conn.nodes : []
  const keys: string[] = []
  for (const rel of nodes) {
    if (String((rel && rel.type) || '') !== 'blocks') continue
    const source = rel && rel.issue
    const key = String((source && (source.identifier || source.id)) || '')
    if (key) keys.push(key)
  }
  const complete = !(conn && conn.pageInfo && conn.pageInfo.hasNextPage === true)
  return { ok: true, keys, complete }
}

/** 环检的三种结论。它不是错误档位，所以不用 ERROR_KIND 的词；取值与 GitHub 房一致，读日志的人不必学第二套。 */
type CycleVerdict = 'clear' | 'cycle' | 'unchecked'

/** 写前环检的结论线（按需 #101 edge.cycle，与另外两房同一个事件名与同一组字段）。 */
function emitCycleVerdict(ctx: OpContext, verdict: CycleVerdict, nodes: number, blockers: number, startedAt: number): void {
  guardEmit(ctx, (c) => {
    c.logEvent('debug', 'edge.cycle', { verdict: verdict, nodes: nodes, blockers: blockers, latencyMs: Date.now() - startedAt })
  }, () => debugOn(ctx))
}

/**
 * 写之前判环：从每个「这次要新加进来的阻塞者」沿它自己的阻塞者往上走，
 * 只要能走回这张票本身，就说明新加的这条边会把图闭合成环。
 *
 * 为什么非要排在写动作之前：研究笔记 §5 只写清了创建与删除两个 mutation，没有一句保证服务端会拒绝
 * 一条会成环的边；而契约明说「成环 → conflict 且不落盘」。写下去再删回来是两件事：中途失败就留下一个环，
 * 而环一旦进了远端，之后每一次读图都会把它当成事实带进界面。
 *
 * 为什么从候选阻塞者往上走：新边只从这张票往外长，环必然经过这张票，「候选阻塞者能不能走回这张票」
 * 就是全部条件；顺着 inverseRelations 每次只读一张票，代价最小。走不完就回 unchecked，调用方不写并如实说明。
 */
async function cycleVerdictOf(
  ctx: OpContext,
  account: LinearAccount,
  ticket: { identifier: string; id: string },
  candidates: readonly string[],
): Promise<{ ok: true; verdict: CycleVerdict } | { ok: false; error: TrackerError }> {
  const startedAt = Date.now()
  const seen = new Set<string>()
  let frontier: string[] = []
  for (const candidate of candidates) {
    const norm = candidate.trim().toUpperCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    frontier.push(candidate)
  }
  let reads = 0
  let verdict: CycleVerdict = 'clear'
  for (let depth = 0; depth < CYCLE_MAX_DEPTH && frontier.length > 0 && verdict === 'clear'; depth += 1) {
    const next: string[] = []
    for (const id of frontier) {
      if (reads >= CYCLE_MAX_READS) { verdict = 'unchecked'; break }
      reads += 1
      const blockers = await blockersOfTicket(ctx, account, id)
      if (!blockers.ok) return { ok: false, error: blockers.error }
      if (!blockers.complete) { verdict = 'unchecked'; break }
      for (const key of blockers.keys) {
        if (sameTicket(key, ticket.identifier) || sameTicket(key, ticket.id)) { verdict = 'cycle'; break }
        const norm = key.trim().toUpperCase()
        if (!norm || seen.has(norm)) continue
        seen.add(norm)
        next.push(key)
      }
      if (verdict !== 'clear') break
    }
    frontier = next
  }
  // 层数用尽但还有票没问：同样属于「没证完」，不许当成没有环。
  if (verdict === 'clear' && frontier.length > 0) verdict = 'unchecked'
  emitCycleVerdict(ctx, verdict, reads, candidates.length, startedAt)
  return { ok: true, verdict }
}

/** 建一条「blocker 阻塞自己这张票」的边，方向由两端念清楚。 */
async function createBlock(ctx: OpContext, account: LinearAccount, blockerKey: string, ownKey: string): Promise<StepResult> {
  const result = await gql<any>(ctx, account, {
    query: RELATION_CREATE,
    variables: { input: { issueId: blockerKey, relatedIssueId: ownKey, type: 'blocks' } },
    bucket: 'write',
  })
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data ? result.data.issueRelationCreate : null
  if (!payload || payload.success === false) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the relation for ' + blockerKey + ' but reported no relation, so that blocker may not be in place') }
  }
  return { ok: true }
}

/** 撤一条边。失败原样交出：这时前面写下去的边留在原地，调用方重跑一次是安全的（差集为空即不再写）。 */
async function removeBlock(ctx: OpContext, account: LinearAccount, relationId: string, blockerKey: string): Promise<StepResult> {
  const result = await gql<any>(ctx, account, { query: RELATION_DELETE, variables: { id: relationId }, bucket: 'write' })
  if (!result.ok) return { ok: false, error: result.error }
  const payload = result.data ? result.data.issueRelationDelete : null
  if (!payload || payload.success === false) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the removal of the blocker ' + blockerKey + ' but reported failure, so it may still be in place') }
  }
  return { ok: true }
}

/**
 * 把这张票的阻塞者整体换成给定的那一列。顺序是刻意排的，每一步都在为下一步准备事实、也都在为「不许写错」挡一道：
 *   1. 自己阻塞自己：在任何请求之前判掉（给定的键里就写着这张票）；
 *   2. 读图：票在不在、expectedUpdatedAt 对不对、现在有哪些边；
 *   3. 读回来之后再判一次自环：调用方可能用 UUID 指同一张票，写法不同而身份相同；
 *   4. 关系清单被截断就不写：覆盖语义下「删哪些」是从这份清单算出来的，看不全就不许动；
 *   5. 算差集，再对要新增的那些边做环检；
 *   6. 先删后加，最后回读并把 Linear 现在真实的边交回去。
 * opts.status 是本地 Markdown 房专用的（见 inputs.ts 的 SetOpts），本房不读它，也不据此做判断。
 */
export async function setBlockedByOfIssue(
  ctx: OpContext,
  account: LinearAccount,
  key: string,
  blockedBy: string[],
  opts: SetOpts | undefined,
): Promise<OpResult<Issue>> {
  const ticketKey = String(key === null || key === undefined ? '' : key).trim()
  if (!ticketKey) return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'no ticket key was given, so no blocker list can be written') }
  const wanted = normalizeBlockers(blockedBy)
  // 硬规矩 1 的前半截：给定的键里就写着这张票本身，一个请求都不发。
  if (wanted.some((candidate) => sameTicket(candidate, ticketKey))) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'the ticket ' + ticketKey + ' cannot block itself, so nothing was sent') }
  }

  const graph = await readGraph(ctx, account, ticketKey)
  if (!graph.ok) return { ok: false, error: graph.error }
  const node = graph.node
  const ownKey = String(node.identifier || node.id || ticketKey)
  const ownId = String(node.id || node.identifier || ticketKey)

  // 硬规矩 1 的后半截：同一张票换一种写法（标识符与 UUID）也是自环，按读回来的真实身份再判一次。
  if (wanted.some((candidate) => sameTicket(candidate, ownKey) || sameTicket(candidate, ownId))) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'the ticket ' + ownKey + ' cannot block itself, so nothing was sent') }
  }

  // 乐观并发与 setParentOfIssue 同一口径：对不上就 conflict，一条边都不动。
  const expected = opts && typeof opts.expectedUpdatedAt === 'string' ? opts.expectedUpdatedAt : ''
  if (expected) {
    const current = String(node.updatedAt || '')
    if (current !== expected) {
      return {
        ok: false,
        error: linearError(ERROR_KIND.CONFLICT, 'the ticket changed since ' + expected + ' (now ' + (current || 'unknown') + '), so its blockers were not changed'),
      }
    }
  }

  if (relationsTruncated(node)) {
    return {
      ok: false,
      error: linearError(ERROR_KIND.UNSUPPORTED, 'this ticket already has more than ' + MAX_PAGE + ' relations and this room cannot replace a list it cannot read whole, so nothing was changed'),
    }
  }

  const current = incomingBlocks(node)
  const wantedNorm = new Set(wanted.map((candidate) => candidate.trim().toUpperCase()))
  const presentNorm = new Set(current.map((block) => block.key.trim().toUpperCase()))
  const removals = current.filter((block) => !wantedNorm.has(block.key.trim().toUpperCase()))
  const additions = wanted.filter((candidate) => !presentNorm.has(candidate.trim().toUpperCase()))

  // 环检必须在第一个写动作之前（理由见 cycleVerdictOf）：它读的是这张票现在的图加上这次要新增的边。
  if (additions.length > 0) {
    const checked = await cycleVerdictOf(ctx, account, { identifier: ownKey, id: ownId }, additions)
    if (!checked.ok) return { ok: false, error: checked.error }
    if (checked.verdict === 'cycle') {
      return {
        ok: false,
        error: linearError(ERROR_KIND.CONFLICT, 'blocking ' + ticketKey + ' with ' + additions.join(', ') + ' would close a cycle in the dependency graph, so nothing was written'),
      }
    }
    if (checked.verdict === 'unchecked') {
      return {
        ok: false,
        error: linearError(ERROR_KIND.CONFLICT, 'the part of the dependency graph this write would touch is larger than this room reads before writing, so a cycle cannot be ruled out and nothing was written'),
      }
    }
  }

  // 先删：删只会让图变小，不可能造出新的环，也不会把后加的那条边推到一张更大的图上。
  for (const block of removals) {
    const removed = await removeBlock(ctx, account, block.relationId, block.key)
    if (!removed.ok) return { ok: false, error: removed.error }
  }
  for (const blocker of additions) {
    const created = await createBlock(ctx, account, blocker, ownKey)
    if (!created.ok) return { ok: false, error: created.error }
  }

  // 写完回读：交回去的是 Linear 现在真实的边，不是「我打算写的那些」。
  // 回读失败时如实回失败（写已经落盘了）；调用方重跑一次是安全的 —— 那时差集为空，一条写请求都不发。
  const after = await readGraph(ctx, account, ticketKey)
  if (!after.ok) return { ok: false, error: after.error }
  const issue = issueOf(after.node)
  return { ok: true, data: { ...issue, blockedBy: incomingBlocks(after.node).map(refOf) } }
}
