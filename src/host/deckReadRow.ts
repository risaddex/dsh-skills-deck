/**
 * src/host/deckReadRow.ts —— 树读与票读共用的一份「把后端回来的一格写成人能读的样子」的归一。
 *
 * 为什么单独住一份：树里的一行子票与一张票的详情会并排出现在同一个面板上 —— 同一个阻塞者在两处
 * 必须是同一行，同一个状态在两处必须写成同一个大写值。各留一份就是两个真源，两条读路径迟早对同一个
 * 后端回包给出两种形状。
 *
 * 边界：纯函数，只做「对象 → 确定形状」的展开与三态判断；不碰会话、不碰后端、不读文件、不留状态。
 */

/** 任意值收成字符串：null 与 undefined 都当空串，不写 "null" 这种字面。 */
export function stringOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 票号收成数字：数字、纯数字字符串、以及键本身是纯数字时都认；其余一律 null。
 * 为什么退到 key：GitHub 房只给 key，面板要的 number 得从键里读；读不出就如实给 null，不猜。
 */
export function numberOrNull(value: unknown, key: string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = parseInt(value.trim(), 10)
    if (Number.isFinite(n)) return n
  }
  if (/^\d+$/.test(key)) {
    const n = parseInt(key, 10)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 状态归一成大写两态：面板与客户端多处按 'CLOSED' 比较。
 *
 * 只有明确读到关闭才是 CLOSED，其余按 OPEN —— 契约里 state 是必给的两态核心字段，读不到这一格
 * 只可能是回包形状不对，那种情况由上面的 parse 失败拦住，不会走到这里。
 */
export function stateOf(value: unknown): string {
  return String(value || '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

/** 树读与票读里的一行阻塞者：键必给，标题与状态读到才有。 */
export type DeckReadBlocker = {
  key: string | number
  title?: string
  state?: string
}

/** 把一条阻塞引用写成一个对象：裸数字、裸字符串、{key}、{number,title,state} 四种写法都认。 */
export function blockerOf(raw: unknown): DeckReadBlocker | null {
  let key: string | number | null = null
  let title = ''
  let state = ''
  if (typeof raw === 'number' && Number.isFinite(raw)) key = raw
  else if (typeof raw === 'string' && raw.trim()) key = raw.trim()
  else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    const keyRaw = rec.key !== undefined && rec.key !== null ? rec.key : rec.number
    if (typeof keyRaw === 'number' && Number.isFinite(keyRaw)) key = keyRaw
    else if (typeof keyRaw === 'string' && keyRaw.trim()) key = keyRaw.trim()
    if (typeof rec.title === 'string') title = rec.title
    if (typeof rec.state === 'string') state = stateOf(rec.state)
  }
  if (key === null) return null
  const out: DeckReadBlocker = { key }
  if (title) out.title = title
  if (state) out.state = state
  return out
}

/**
 * 把一张票的阻塞边写成数组。
 *
 * 三态：后端整格没给（`blockedBy` 与 `blockedByRefs` 都不是数组）就回 undefined，让上层省略这一格；
 * 明确给了空数组就回空数组。这条区分是 #71 定的：省略表示「不知道」，空数组表示「确实没有」，
 * 两者在面板上是不一样的话。同一个键只出现一次（两种来源合起来时会重复）。
 */
export function blockersOf(ticket: any): DeckReadBlocker[] | undefined {
  const hasRefs = Array.isArray(ticket && ticket.blockedByRefs)
  const hasRaw = Array.isArray(ticket && ticket.blockedBy)
  if (!hasRefs && !hasRaw) return undefined
  const refs: unknown[] = [
    ...(hasRefs ? ticket.blockedByRefs : []),
    ...(hasRaw ? ticket.blockedBy : []),
  ]
  const out: DeckReadBlocker[] = []
  const seen = new Set<string>()
  for (const raw of refs) {
    const ref = blockerOf(raw)
    if (!ref) continue
    const id = String(ref.key)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(ref)
  }
  return out
}
