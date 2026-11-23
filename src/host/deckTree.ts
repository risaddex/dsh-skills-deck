/**
 * src/host/deckTree.ts —— 会话 → workspace → 开放地图/规格树的只读宿主电话。
 *
 * 这一层只回答一个问题：一个对话的 sessionId 对应哪个 workspace，以及从该 workspace 的
 * Tracker 读会话里取出的开放工作树是什么形状。它不复制后端判据：workspace 由现有 wf.cwd 解析，
 * 后端选择、只读权限与 Tracker 契约调用都由现有 openSession 会话承担。
 *
 * #72 起「会话 → workspace → 只读会话」与失败折法搬到 src/host/deckReadSession.ts，每一行的归一
 * 搬到 src/host/deckReadRow.ts：票读（src/host/deckTicket.ts）必须与这里解析出同一个工作区、
 * 把阻塞者写成一模一样的一行，各留一份就是两个真源。本文件只剩树自己的投影（容器、子票与截断）。
 *
 * 两个条数上限（50 个容器、200 张票）是规格 #70 钉的数，字节护栏是本票补的传输护栏；三个数都住在
 * src/tracker/contract/deck-read.ts 的 DECK_READ_LIMITS 一处，这里只 import 名字、不写第二份字面量。
 * 到了上限不是失败，是「截断」：回包把三个来源（后端名册、容器上限、票上限）分开报，并报少画了几个
 * 容器与几张票，面板据此说「这不是全部」；只有回包大过字节护栏时才如实失败 —— 那时不交半份树。
 *
 * 边界：不写、不缓存、不读评论。会话找不到就失败，绝不回落到别的 workspace；
 * 后端没表达的 blockedBy / tickets 保持未知，不折成空数组。
 */

import { assembleSnapshot } from './tracker/snapshotAssemble.js'
import { errorTextOf, failureOf, oversizedFailureOf, resolveDeckReadSession, type DeckReadDeps } from './deckReadSession.js'
import { blockersOf, numberOrNull, stateOf, stringOf, type DeckReadBlocker } from './deckReadRow.js'
import { DECK_READ_LIMITS } from '../tracker/contract/deck-read.js'

type TreeTicket = {
  key: string
  number: number | null
  title: string
  state: string
  url: string
  blockedBy?: DeckReadBlocker[]
}

type TreeContainer = {
  key: string
  number: number | null
  kind: 'map' | 'spec'
  title: string
  state: string
  url: string
  tickets?: TreeTicket[]
}

/** 子票行：键必给，其余缺了用空串，读不到就不猜。 */
function ticketOf(raw: any): TreeTicket | null {
  const key = stringOf(raw && raw.key).trim()
  if (!key) return null
  const out: TreeTicket = {
    key,
    number: numberOrNull(raw && raw.number, key),
    title: stringOf(raw && raw.title),
    state: stateOf(raw && raw.state),
    url: stringOf(raw && raw.url),
  }
  const blockedBy = blockersOf(raw)
  if (blockedBy !== undefined) out.blockedBy = blockedBy
  return out
}

/** 容器行：只认 map 与 spec 两种种类，别的种类不进树（宁可不显示，也不冒充成一种容器）。 */
function containerOf(raw: any): TreeContainer | null {
  const key = stringOf(raw && raw.key).trim()
  if (!key) return null
  const kindRaw = stringOf(raw && raw.type)
  if (kindRaw !== 'map' && kindRaw !== 'spec') return null
  const out: TreeContainer = {
    key,
    number: numberOrNull(raw && raw.number, key),
    kind: kindRaw,
    title: stringOf(raw && raw.title),
    state: stateOf(raw && raw.state),
    url: stringOf(raw && raw.url),
  }
  if (Array.isArray(raw && raw.tickets)) {
    out.tickets = raw.tickets.map(ticketOf).filter((t: TreeTicket | null): t is TreeTicket => t !== null)
  }
  return out
}

/**
 * 组装电话。依赖显式传入：会话解析、只读会话与后端选择各只有一条来源。
 */
export function createDeckTreeRead(deps: DeckReadDeps): { handleTree: (args?: any) => Promise<any> } {
  async function handleTree(args?: any): Promise<any> {
    const resolved = await resolveDeckReadSession(deps, args && args.sessionId, 'The deck tree could not be read')
    if (!resolved.ok) return resolved

    let listed: any
    try {
      listed = await resolved.call((session: any, ctx: any) => session.list(resolved.repoRef, { state: 'open' }, ctx))
    } catch (e) {
      return { ok: false, error: { kind: 'fetch-failed', message: errorTextOf(e, 'The deck tree could not be read') } }
    }
    if (!listed || listed.ok !== true) return failureOf(listed, 'fetch-failed', 'The deck tree could not be read')
    if (!Array.isArray(listed.data)) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker list returned no row array' } }
    }
    // 有行、却一行都读不出键：这不是「空工作区」（空的答案是零行），是后端回了一份认不出的数据。
    // 不在这里拦住，组装器会把整批丢掉、回一棵空树，面板看到的就是「这个仓库一张票都没挂」。
    if (listed.data.length > 0 && !listed.data.some((row: any) => stringOf(row && row.key).trim() !== '')) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker list returned rows whose ticket keys could not be read' } }
    }

    const assembled: any = assembleSnapshot(resolved.repoRef, listed.data)
    if (!assembled || !Array.isArray(assembled.maps)) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker rows could not be assembled into a tree' } }
    }
    const openContainers: TreeContainer[] = []
    let ticketsSeen = 0
    for (const raw of assembled.maps) {
      const container = containerOf(raw)
      if (!container) continue
      if (container.state === 'CLOSED') continue
      openContainers.push(container)
      if (Array.isArray(container.tickets)) ticketsSeen += container.tickets.length
    }

    // 两个条数上限按容器顺序切，切掉的容器整块消失：额度只剩 10 张而下个容器有 20 张时不带它，
    // 不把它画成「只有前几张票」—— 半截票单会被面板读成「这张地图一共就这几张票」。
    const containers: TreeContainer[] = []
    let ticketsKept = 0
    let containerCut = false
    let ticketCut = false
    for (const container of openContainers) {
      if (containers.length >= DECK_READ_LIMITS.maxContainers) { containerCut = true; break }
      const held = Array.isArray(container.tickets) ? container.tickets.length : 0
      if (ticketsKept + held > DECK_READ_LIMITS.maxTickets) { ticketCut = true; break }
      containers.push(container)
      ticketsKept += held
    }
    // 字节护栏放在条数之后：条数正常、单行特别大（例如一张几 MB 正文的票）时才轮到它挡。
    const oversized = oversizedFailureOf(containers, 'deck tree')
    if (oversized) return oversized

    const out: any = {
      ok: true,
      sessionId: resolved.sessionId,
      workspaceRoot: resolved.workspaceRoot,
      backendId: resolved.backendId,
      containers,
      // 截断的总信号：任何一个来源切掉了东西都为 true。面板只用这一格决定要不要说「这不是全部」。
      truncated: listed.truncated === true || containerCut || ticketCut,
      // 三个来源分开报：后端名册自己不全（Tracker 契约的 truncated）与这一层两个上限切了，是两件不同的事，
      // 排查时要知道该去找谁。
      backendTruncated: listed.truncated === true,
      containersTruncated: containerCut,
      ticketsTruncated: ticketCut,
      // 省略数是「这次投影真的少画了多少」（后端本身不全时它只是本次切掉的量，不是仓库总量）。
      omittedContainers: openContainers.length - containers.length,
      omittedTickets: ticketsSeen - ticketsKept,
      fallback: listed.fallback === 'rest' ? 'rest' : null,
    }
    if (typeof listed.fallbackReason === 'string' && listed.fallbackReason) out.fallbackReason = listed.fallbackReason
    return out
  }

  return { handleTree }
}

export default { createDeckTreeRead }
