/**
 * src/host/deckTree.ts —— 会话 → workspace → 开放地图/规格树的只读宿主电话。
 *
 * 这一层只回答一个问题：一个对话的 sessionId 对应哪个 workspace，以及从该 workspace 的
 * Tracker 读会话里取出的开放工作树是什么形状。它不复制后端判据：workspace 由现有 wf.cwd 解析，
 * 后端选择、只读权限与 Tracker 契约调用都由现有 openSession 会话承担。
 *
 * 边界：不写、不缓存、不读评论。会话找不到就失败，绝不回落到别的 workspace；
 * 后端没表达的 blockedBy / tickets 保持未知，不折成空数组。
 */

import { assembleSnapshot } from './tracker/snapshotAssemble.js'

type Deps = {
  handleCwd: (args: { sessionId: string }) => Promise<any>
  openSession: (cwd: string, opts?: { write?: boolean }) => Promise<any>
}

type TreeBlocker = {
  key: string | number
  title?: string
  state?: string
}

type TreeTicket = {
  key: string
  number: number | null
  title: string
  state: string
  url: string
  blockedBy?: TreeBlocker[]
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

function stringOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function numberOrNull(value: unknown, key: string): number | null {
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

function stateOf(value: unknown): string {
  return String(value || '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

function errorTextOf(value: unknown): string {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec.message === 'string' && rec.message) return rec.message
    if (typeof rec.detail === 'string' && rec.detail) return rec.detail
    if (typeof rec.error === 'string' && rec.error) return rec.error
  }
  return 'The deck tree could not be read'
}

function errorKindOf(value: unknown, fallback: string): string {
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

function failureOf(value: unknown, fallbackKind: string): { ok: false; error: { kind: string; message: string } } {
  const rec = value && typeof value === 'object' ? value as Record<string, unknown> : null
  return {
    ok: false,
    error: {
      kind: errorKindOf(rec, fallbackKind),
      message: errorTextOf(rec ? rec.error : value),
    },
  }
}

function blockerOf(raw: unknown): TreeBlocker | null {
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
  const out: TreeBlocker = { key }
  if (title) out.title = title
  if (state) out.state = state
  return out
}

function blockersOf(ticket: any): TreeBlocker[] | undefined {
  const hasRefs = Array.isArray(ticket && ticket.blockedByRefs)
  const hasRaw = Array.isArray(ticket && ticket.blockedBy)
  if (!hasRefs && !hasRaw) return undefined
  const refs: unknown[] = [
    ...(hasRefs ? ticket.blockedByRefs : []),
    ...(hasRaw ? ticket.blockedBy : []),
  ]
  const out: TreeBlocker[] = []
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
export function createDeckTreeRead(deps: Deps): { handleTree: (args?: any) => Promise<any> } {
  const { handleCwd, openSession } = deps

  async function handleTree(args?: any): Promise<any> {
    const sessionId = typeof (args && args.sessionId) === 'string' ? args.sessionId.trim() : ''
    if (!sessionId) return { ok: false, error: { kind: 'no-sid', message: 'Missing sessionId' } }

    let cwdReply: any
    try {
      cwdReply = await handleCwd({ sessionId })
    } catch (e) {
      return { ok: false, error: { kind: 'session', message: errorTextOf(e) } }
    }
    if (!cwdReply || cwdReply.ok !== true) return failureOf(cwdReply, 'session')
    const cwd = stringOf(cwdReply.cwd).trim()
    if (!cwd) return { ok: false, error: { kind: errorKindOf(cwdReply, 'no-cwd'), message: 'This session has no cwd information' } }

    let opened: any
    try {
      opened = await openSession(cwd, { write: false })
    } catch (e) {
      return { ok: false, error: { kind: 'session', message: errorTextOf(e) } }
    }
    if (!opened || opened.ok !== true) return failureOf(opened, 'session')
    if (!opened.repoRef || typeof opened.call !== 'function') {
      return { ok: false, error: { kind: 'repo-ref', message: 'The read session returned no repository identity' } }
    }

    let listed: any
    try {
      listed = await opened.call((session: any, ctx: any) => session.list(opened.repoRef, { state: 'open' }, ctx))
    } catch (e) {
      return { ok: false, error: { kind: 'fetch-failed', message: errorTextOf(e) } }
    }
    if (!listed || listed.ok !== true) return failureOf(listed, 'fetch-failed')
    if (!Array.isArray(listed.data)) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker list returned no row array' } }
    }

    const assembled: any = assembleSnapshot(opened.repoRef, listed.data)
    if (!assembled || !Array.isArray(assembled.maps)) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker rows could not be assembled into a tree' } }
    }
    const containers: TreeContainer[] = []
    for (const raw of assembled.maps) {
      const container = containerOf(raw)
      if (!container) continue
      if (container.state === 'CLOSED') continue
      containers.push(container)
    }

    const out: any = {
      ok: true,
      sessionId,
      workspaceRoot: stringOf(cwdReply.workspaceRoot || cwd),
      backendId: stringOf(opened.backendId),
      containers,
      truncated: listed.truncated === true,
      fallback: listed.fallback === 'rest' ? 'rest' : null,
    }
    if (typeof listed.fallbackReason === 'string' && listed.fallbackReason) out.fallbackReason = listed.fallbackReason
    return out
  }

  return { handleTree }
}

export default { createDeckTreeRead }
