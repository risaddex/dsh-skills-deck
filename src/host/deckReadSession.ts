/**
 * src/host/deckReadSession.ts —— 树读与票读共用的一次只读读怎么开头：sessionId → workspace → 只读会话，
 * 以及失败怎么说话。
 *
 * 为什么单独住一份：树读（#71）与票读（#72）都必须从对话的 sessionId 解析出同一个 workspace，
 * 并且都必须用同一套「失败回什么原因、带哪句话」的折法；各写一份就是两个真源，两条读路径会对
 * 同一个失败给出两种回包，而手机面板会同时显示它们。#73 起两条读共用的字节护栏（oversizedFailureOf，
 * 数字来自契约层的 DECK_READ_LIMITS）也住在这里：同一个上限在两处的量法只能有这一份。
 *
 * 边界：不写、不缓存、不碰后端判据。workspace 由现有 wf.cwd 解析，后端选择与只读权限由现有
 * openSession 承担；会话找不到就失败，绝不回落到别的 workspace —— 回落到默认工作区会让手机面板
 * 显示另一个仓库的票。
 */

import { DECK_READ_LIMITS } from '../tracker/contract/deck-read.js'

/** 只读会话解析成功后拿到的东西：解析出来的工作区身份与一条只读会话入口。 */
export type DeckReadSession = {
  ok: true
  /** 调用方给的那个 sessionId（原样带回，便于上层把回包与请求对上）。 */
  sessionId: string
  /** 会话解析出的工作区目录（这次读的解析基准）。 */
  cwd: string
  /** 工作区根（两条读都照原样回给上层；解析器给不出时退成这次 cwd）。 */
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
}

/**
 * 把一段投影量成 UTF-8 字节数：手机那条通道收的是字节，字符数不算数。
 *
 * 为什么集中这一处：树读与票读都要用同一个护栏（数字在契约层的 DECK_READ_LIMITS，见那里的注释），
 * 量法各写一份，迟早一处按字符、一处按字节，同一个上限在两处松紧不同。没有 TextEncoder 的环境
 * （老运行时、极简闭包）退回字符数：护栏会略松一点，但不会因为量不出来就把一次正常的读判成失败。
 */
function projectionBytesOf(value: unknown): number {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') return 0
  const Encoder: any = (globalThis as any).TextEncoder
  if (typeof Encoder === 'function') return new Encoder().encode(text).length
  return text.length
}

/**
 * 投影超过传输护栏时回的那个失败；没超回 null（调用方照常把回包交出去）。
 *
 * 为什么是「失败」而不是「截断」：截断说的是「名单不全，但每一行都是真的」；字节护栏挡住的是
 * 一个本身就不该整份过通道的回包（例如一张几 MB 正文的票）。把这种回包截一半交上去，面板会把
 * 半份正文当成完整正文读，比失败更糟。`what` 是这次读的名字（'deck tree' / 'deck ticket'），
 * 回给人看的那句话里要说清是哪一份太大。
 */
export function oversizedFailureOf(value: unknown, what: string): DeckReadFailure | null {
  const bytes = projectionBytesOf(value)
  if (bytes <= DECK_READ_LIMITS.maxProjectionBytes) return null
  return {
    ok: false,
    error: {
      kind: 'oversized',
      message: 'The ' + what + ' is ' + bytes + ' bytes, over the ' + DECK_READ_LIMITS.maxProjectionBytes
        + '-byte relay limit; it is not sent in part, so read a smaller piece of the workspace',
    },
  }
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

/**
 * 一次只读读的入口：sessionId → workspace → 只读会话。
 *
 * 每一支失败都回自己的原因（缺 sessionId、会话找不到、没有 cwd、会话开不起来、没有仓库身份），
 * 且任何一支都不去碰别的 workspace。`notRead` 是后端连一句话都没给时回给上层的那句原话，
 * 由调用方给（每条读说自己那件事，不共用一句）。
 */
export async function resolveDeckReadSession(
  deps: DeckReadDeps,
  rawSessionId: unknown,
  notRead?: string,
): Promise<DeckReadSession | DeckReadFailure> {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  if (!sessionId) return { ok: false, error: { kind: 'no-sid', message: 'Missing sessionId' } }

  let cwdReply: any
  try {
    cwdReply = await deps.handleCwd({ sessionId })
  } catch (e) {
    return { ok: false, error: { kind: 'session', message: errorTextOf(e, notRead) } }
  }
  if (!cwdReply || cwdReply.ok !== true) return failureOf(cwdReply, 'session', notRead)
  const cwd = String(cwdReply.cwd === null || cwdReply.cwd === undefined ? '' : cwdReply.cwd).trim()
  if (!cwd) return { ok: false, error: { kind: errorKindOf(cwdReply, 'no-cwd'), message: 'This session has no cwd information' } }

  let opened: any
  try {
    opened = await deps.openSession(cwd, { write: false })
  } catch (e) {
    return { ok: false, error: { kind: 'session', message: errorTextOf(e, notRead) } }
  }
  if (!opened || opened.ok !== true) return failureOf(opened, 'session', notRead)
  if (!opened.repoRef || typeof opened.call !== 'function') {
    return { ok: false, error: { kind: 'repo-ref', message: 'The read session returned no repository identity' } }
  }

  return {
    ok: true,
    sessionId,
    cwd,
    workspaceRoot: String(cwdReply.workspaceRoot || cwd),
    backendId: String(opened.backendId === null || opened.backendId === undefined ? '' : opened.backendId),
    repoRef: opened.repoRef,
    call: opened.call,
  }
}
