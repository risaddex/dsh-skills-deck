/**
 * This service lets the relay read comments without expanding deck.panel.read.v1.
 * The relay authorizes the peer; Deck resolves the conversation's workspace and
 * opens a fresh read-only Tracker session for every page, including continuations.
 */
// @ts-expect-error The host does not install Node type declarations.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Comment, RepositoryRef } from '../../../tracker/contract/entities.js'
import type { IssueDetailResult } from '../../../tracker/contract/results.js'
import type { OpContext } from '../../../tracker/contract/contexts.js'
import type { TrackerSession } from '../../../tracker/session/open-tracker.js'
import { STEP_WAIT_MS } from '../../../shared/time-config/src/values.js'
import { hash8 } from '../../contract/workspace-keys.js'
import { errorKindOf, oversizedFailureOf, resolveDeckReadSession, type DeckReadDeps, type DeckReadFailure, type DeckReadSession } from '../../../host/deckReadSession.js'

export const DECK_COMMENTS_FEATURE = 'deck.panel.comments.v1'
export const DECK_COMMENTS_SERVICE = 'deckPanelComments'
const METHOD = 'deck.panel.comments'
const PAGE_SIZE = 50
const MAX_COMMENTS = 200
const MAX_CURSOR_CHARS = 200
const REQUEST_KEYS = new Set(['sessionId', 'key', 'cursor'])
const SAFE_KIND = /^[a-z0-9][a-z0-9-]{0,39}$/

type CommentRequest = { sessionId: string; key: string | number; cursor?: string }
type CommentRow = { body: string; author?: string; createdAt?: string; updatedAt?: string }
type CommentPage = { ok: true; sessionId: string; key: string | number; comments: CommentRow[]; nextCursor?: string; truncated?: true }
type CommentReply = CommentPage | DeckReadFailure
type LogCtx = { fire(level: string, event: string, fields: Record<string, unknown>): void } | null | undefined

export interface DeckPanelComments {
  readonly feature: typeof DECK_COMMENTS_FEATURE
  available(): { available: boolean }
  list(params: unknown): Promise<CommentReply>
}

function requestOf(params: unknown): CommentRequest | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  if (!Reflect.ownKeys(params).every((key) => typeof key === 'string' && REQUEST_KEYS.has(key))) return null
  const own = (key: string) => Object.getOwnPropertyDescriptor(params, key)?.value
  const sid: unknown = own('sessionId')
  const key: unknown = own('key')
  if (typeof sid !== 'string' || !sid.trim() || sid.length > 512) return null
  if (!(typeof key === 'string' && !!key.trim() && key.length <= 200) &&
      !(typeof key === 'number' && Number.isSafeInteger(key) && key > 0)) return null
  if (!Object.prototype.hasOwnProperty.call(params, 'cursor')) return { sessionId: sid.trim(), key }
  const cursor: unknown = own('cursor')
  if (typeof cursor !== 'string' || !cursor.trim() || cursor.length > MAX_CURSOR_CHARS) return null
  return { sessionId: sid.trim(), key, cursor }
}

function fail(kind: string, message: string): DeckReadFailure {
  return { ok: false, error: { kind, message } }
}

/** Only the machine reason crosses the relay, never a Tracker message or path. */
function readFailure(raw: unknown, fallback: string): DeckReadFailure {
  const kind = errorKindOf(raw, fallback)
  const safeKind = SAFE_KIND.test(kind) ? kind : fallback
  return fail(safeKind, `The deck comments could not be read (${safeKind})`)
}

/** A comment body is user content and is never shortened or replaced with an empty string. */
function commentOf(comment: Comment): CommentRow | null {
  if (!comment || typeof comment !== 'object' || typeof comment.body !== 'string') return null
  const row: CommentRow = { body: comment.body }
  const { login, name } = comment.author ?? {}
  if (typeof login === 'string' && login.trim()) row.author = login
  else if (typeof name === 'string' && name.trim()) row.author = name
  if (typeof comment.createdAt === 'string' && comment.createdAt.trim()) row.createdAt = comment.createdAt
  if (typeof comment.updatedAt === 'string' && comment.updatedAt.trim()) row.updatedAt = comment.updatedAt
  return row
}

/** Only fixed, locally generated fields are written to logs; no comment content or identity is logged. */
function logResult(logCtx: LogCtx, method: string, started: number, outcome: string | null): void {
  try {
    if (outcome === null) logCtx?.fire('info', 'host.call', { method, latencyMs: Date.now() - started, ok: true, kind: 'deck-comments' })
    else logCtx?.fire('warn', 'host.call.fail', { method, kind: 'deck-comments', errorHash: hash8(outcome) })
  } catch { /* Logging failure must not break the read. */ }
}

/**
 * The cursor authenticates an offset without revealing a path, account, or key.
 * A different service instance cannot verify it, so restart the list after a host reload.
 */
export function createDeckPanelComments(deps: DeckReadDeps, logCtx?: LogCtx, timeoutMs = STEP_WAIT_MS): DeckPanelComments {
  const signingKey = randomBytes(32)

  function cursorFor(offset: number, resolved: DeckReadSession, key: CommentRequest['key']): string {
    const ref: RepositoryRef = resolved.repoRef
    const scope = [DECK_COMMENTS_FEATURE, offset, resolved.sessionId, key, resolved.cwd, resolved.workspaceRoot,
      resolved.backendId, ref.backend, ref.refId, ref.host, ref.effortId]
    const tag = createHmac('sha256', signingKey).update(JSON.stringify(scope)).digest('hex')
    return `${offset}.${tag}`
  }

  function offsetOf(cursor: string, resolved: DeckReadSession, key: CommentRequest['key']): number | null {
    const match = /^([1-9][0-9]{0,2})\.[a-f0-9]{64}$/.exec(cursor)
    if (!match || match[0] !== cursor) return null
    const offset = Number(match[1])
    if (offset % PAGE_SIZE !== 0 || offset >= MAX_COMMENTS) return null
    const encode = new TextEncoder()
    return timingSafeEqual(encode.encode(cursor), encode.encode(cursorFor(offset, resolved, key))) ? offset : null
  }

  async function read(params: CommentRequest): Promise<CommentReply> {
    const resolved = await resolveDeckReadSession(deps, params.sessionId)
    if (!resolved.ok) return readFailure(resolved, 'session')
    const offset = params.cursor === undefined ? 0 : offsetOf(params.cursor, resolved, params.key)
    if (offset === null) return fail('invalid-cursor', 'This comment page cursor is invalid. Reopen the comments to start again.')

    // Not all Tracker rooms support a native cursor. Request their ordered prefix
    // and return only its new slice. Never request more than the negotiated cap.
    const want = Math.min(offset + PAGE_SIZE, MAX_COMMENTS)
    const key = String(params.key).trim()
    let issueIdentity: { url: string; effortId?: string } | undefined
    const result: IssueDetailResult | DeckReadFailure = await resolved.call(async (session: TrackerSession, ctx: OpContext) => {
      const repo: RepositoryRef = resolved.repoRef
      if (resolved.backendId !== 'markdown') return session.get(repo, key, { comments: { first: want } }, ctx)
      // Markdown's unscoped get chooses the first match. Check for a unique
      // match before reading any comment bodies, and verify the same file came back.
      const canonicalKey = key.padStart(2, '0')
      const matches = await session.list(repo, { keys: [canonicalKey] }, ctx)
      if (!matches?.ok) return readFailure(matches, 'fetch-failed')
      if (!Array.isArray(matches.data) || matches.truncated || matches.fallback) {
        return fail('bad-reply', 'The tracker could not verify the local ticket identity')
      }
      const rows = matches.data.filter((row) => row.key === canonicalKey)
      if (rows.length === 0) return fail('not-found', 'The tracker did not find this ticket')
      if (rows.length !== 1) return fail('conflict', 'More than one local ticket has this key')
      const { effortId, url } = rows[0]
      if (!url || !effortId) return fail('bad-reply', 'The tracker returned no local ticket identity')
      issueIdentity = { url, effortId }
      return session.get({ ...repo, effortId }, canonicalKey, { comments: { first: want } }, ctx)
    })
    if (result?.ok !== true) return readFailure(result, 'fetch-failed')
    const issue = result.data
    if (issueIdentity && (issue?.url !== issueIdentity.url || issue?.effortId !== issueIdentity.effortId)) {
      return fail('conflict', 'The local ticket changed while its comments were being read')
    }
    const completeness = result.provenance?.fieldGroups?.comments
    if (!Array.isArray(issue?.comments) || completeness === 'unexpressed') {
      return fail('comments-unavailable', 'The tracker did not return comments for this ticket')
    }

    const prefix = issue.comments
    const comments: CommentRow[] = []
    for (const raw of prefix.slice(offset, want)) {
      const comment = commentOf(raw)
      if (!comment) return fail('bad-reply', 'The tracker returned an unreadable comment')
      comments.push(comment)
    }
    const total = Number.isSafeInteger(issue.commentCount) && issue.commentCount! >= 0 ? issue.commentCount : undefined
    const hasMore = prefix.length > want || (total !== undefined && total > prefix.length) ||
      issue.commentsHasMore === true || completeness === 'truncated' ||
      (total === undefined && completeness !== 'complete' && prefix.length >= want)
    const out: CommentPage = { ok: true, sessionId: resolved.sessionId, key: params.key, comments }
    if (hasMore && prefix.length >= want && want < MAX_COMMENTS) out.nextCursor = cursorFor(want, resolved, params.key)
    else if (hasMore) out.truncated = true
    return oversizedFailureOf(out, 'deck comment page') ?? out
  }

  async function list(params: unknown): Promise<CommentReply> {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let out: CommentReply
    try {
      const request = requestOf(params)
      out = request ? await Promise.race([
        read(request),
        new Promise<DeckReadFailure>((resolve) => {
          timer = setTimeout(() => resolve(fail('timeout', 'The deck comments did not finish in time')), timeoutMs)
        }),
      ]) : fail('bad-request', 'Expected a session ID, ticket key, and optional comment page cursor')
    } catch {
      out = fail('read-failed', 'The deck comments could not be read')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    logResult(logCtx, METHOD, started, out.ok ? null : out.error.kind)
    return out
  }

  return Object.freeze({ feature: DECK_COMMENTS_FEATURE, available: () => ({ available: true }), list })
}

/** Register only the separate read-only service, not a generic host method or HTTP route. */
export function provideDeckPanelComments(ctx: { provide?: (name: string, value: unknown) => unknown }, deps: DeckReadDeps, logCtx?: LogCtx): boolean {
  const started = Date.now()
  try {
    if (typeof ctx?.provide !== 'function') throw new Error('provide-missing')
    ctx.provide(DECK_COMMENTS_SERVICE, createDeckPanelComments(deps, logCtx))
    logResult(logCtx, `${METHOD}.provide`, started, null)
    return true
  } catch {
    logResult(logCtx, `${METHOD}.provide`, started, 'provide-failed')
    return false
  }
}
