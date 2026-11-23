/**
 * src/host/deckReadScope.ts —— 两条只读电话（树读与票读）共用的骨架：会话 → workspace → 只读会话，
 * 以及每一行投影都要用的那几样归一。
 *
 * 为什么单独住一个文件：树读（#71）与票读（#72）都必须从对话的 sessionId 解析出同一个 workspace，
 * 并且都必须用同一套「失败怎么说话」与「阻塞者怎么写成一行」的归一。各写一份就是两个真源，
 * 两条读路径迟早会对同一个后端回包给出两种形状，而手机面板会同时显示它们。
 *
 * 边界：不写、不缓存、不碰后端判据。workspace 由现有 wf.cwd 解析，后端选择与只读权限由现有
 * openSession 承担；会话找不到就失败，绝不回落到别的 workspace。
 */

/** 只读会话解析成功后拿到的东西：解析出来的工作区身份与一条只读会话入口。 */
export type DeckReadSession = {
  ok: true
  /** 调用方给的那个 sessionId（原样带回，便于上层把回包与请求对上）。 */
  sessionId: string
  /** 会话解析出的工作区目录（这次读的解析基准）。 */
  cwd: string
  /** 工作区根（树读与票读都照原样回给上层；解析器给不出时退成本次 cwd）。 */
  workspaceRoot: string
  /** 只读会话选中的后端 id。 */
  backendId: string
  /** 后端身份：读票与读列表都要把它原样交回 Tracker 契约。 */
  repoRef: any
  /** 只读会话的调用入口：把「拿会话与上下文做一件事」交给它执行。 */
  call: (fn: any) => Promise<any>
}

/** 解析失败的回包：`kind` 是机器可读原因，`message` 是给人看的一句话。 */
export type DeckReadFailure = { ok: false; error: { kind: string; message: string } }

/** 本文件依赖的两个出口，都由装配点（src/host/index.ts）显式传入。 */
export type DeckReadDeps = {
  /** 把对话的 sessionId 解析成 cwd（现有 wf.cwd 电话）。 */
  handleCwd: (args: { sessionId: string }) => Promise<any>
  /** 按 cwd 开一条会话；只读读路径一律带 write:false。 */
  openSession: (cwd: string, opts?: { write?: boolean }) => Promise<any>
  /** 后端失败却又连一句话都没给时，回给上层的那句原话（每条读说自己的那件事，不共用一句）。 */
  readLabel?: string
}

/** 任意值收成字符串：null 与 undefined 都当空串，不写 "null" 这种字面。 */
export function stringOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 票号收成数字：数字、纯数字字符串、以及键本身是纯数字时都认；其余一律 null。
 * 为什么退到 key：GitHub 房只给 key，界面要的 number 得从键里读；读不出就如实给 null，不猜。
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
 * 状态归一成大写的两态：面板多处按 'CLOSED' 比较。
 * 只有明确读到关闭才是 CLOSED，其余（含读不到状态）按 OPEN —— 与树读同一口径。
 */
export function stateOf(value: unknown): string {
  return String(value || '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

/** 从失败回包里取一句给人看的话：字符串直接用，对象认 message / detail / error 三格；取不到用调用方给的那句。 */
export function errorTextOf(value: unknown, fallback: string = 'The deck read could not be completed'): string {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.message === 'string' && rec.message) return rec.message
    if (typeof rec.detail === 'string' && rec.detail) return rec.detail
    if (typeof rec.error === 'string' && rec.error) return rec.error
  }
  return fallback
}

/** 从失败回包里取机器可读原因：顶层 kind / failKind / reason，或嵌在 error 里的 kind。 */
export function errorKindOf(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.kind === 'string' && rec.kind) return rec.kind
    if (typeof rec.failKind === 'string' && rec.failKind) return rec.failKind
    if (typeof rec.reason === 'string' && rec.reason) return rec.reason
    if (rec.error && typeof rec.error === 'object') {
      const nested = rec.error as Record<string, unknown>
      if (typeof nested.kind === 'string' && nested.kind) return nested.kind
    }
  }
  return fallback
}

/** 把一个后端/会话的失败回包折成统一失败形状；取不到原因就用调用方给的兜底。 */
export function failureOf(value: unknown, fallbackKind: string, fallbackMessage?: string): DeckReadFailure {
  const rec = value && typeof value === 'object' ? value as Record<string, unknown> : null
  return {
    ok: false,
    error: {
      kind: errorKindOf(rec, fallbackKind),
      message: errorTextOf(rec ? rec.error : value, fallbackMessage),
    },
  }
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

/**
 * 一次只读读的入口：sessionId → workspace → 只读会话。
 *
 * 每一支失败都回自己的原因（缺 sessionId、会话找不到、没有 cwd、会话开不起来、没有仓库身份），
 * 且任何一支都不去碰别的 workspace —— 手机面板按会话圈定范围，「回落到默认工作区」会让它显示
 * 另一个仓库的票。
 */
export async function resolveDeckReadSession(deps: DeckReadDeps, rawSessionId: unknown): Promise<DeckReadSession | DeckReadFailure> {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  const label = deps.readLabel
  if (!sessionId) return { ok: false, error: { kind: 'no-sid', message: 'Missing sessionId' } }

  let cwdReply: any
  try {
    cwdReply = await deps.handleCwd({ sessionId })
  } catch (e) {
    return { ok: false, error: { kind: 'session', message: errorTextOf(e, label) } }
  }
  if (!cwdReply || cwdReply.ok !== true) return failureOf(cwdReply, 'session', label)
  const cwd = stringOf(cwdReply.cwd).trim()
  if (!cwd) return { ok: false, error: { kind: errorKindOf(cwdReply, 'no-cwd'), message: 'This session has no cwd information' } }

  let opened: any
  try {
    opened = await deps.openSession(cwd, { write: false })
  } catch (e) {
    return { ok: false, error: { kind: 'session', message: errorTextOf(e, label) } }
  }
  if (!opened || opened.ok !== true) return failureOf(opened, 'session', label)
  if (!opened.repoRef || typeof opened.call !== 'function') {
    return { ok: false, error: { kind: 'repo-ref', message: 'The read session returned no repository identity' } }
  }

  return {
    ok: true,
    sessionId,
    cwd,
    workspaceRoot: stringOf(cwdReply.workspaceRoot || cwd),
    backendId: stringOf(opened.backendId),
    repoRef: opened.repoRef,
    call: opened.call,
  }
}
