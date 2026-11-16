/**
 * src/tracker/rooms/linear/client.ts —— Linear 房的请求层：一次 GraphQL 调用
 *
 * 房间不许用全局 fetch（契约里那句），所以这里只走 `ctx.http.request`。通道自己拿出站名额、
 * 自己上报结局；本文件负责四件事：拼请求、认 HTTP 状态、把 errors[] 翻成契约分类、记一行边界日志。
 *
 * 为什么失败也回信封而不是抛：契约的第一条不变量是「失败是返回值，不是异常」。通道在传输层
 * 抛错是它的形状，本文件把它接住并翻成 `{ ok: false, error }`，房间其余部分只看信封。
 */
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { TrackerError } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { classifyGraphQLErrors, kindOfStatus, kindOfThrow, linearError } from './errors.js'

/** 这一趟用哪个账号：非机密元数据来自 deck 设置，凭据那半截已由账号层解析成可用的 Authorization 头。 */
export interface LinearAccount {
  /** 账号别名，只用于日志与错误里指认是哪一本账。 */
  alias: string
  /** GraphQL 端点，通常是 https://api.linear.app/graphql。 */
  endpoint: string
  /** 完整的 Authorization 头值（API key 裸值，或 OAuth 的 Bearer 前缀），由账号层拼好，本层不改写。 */
  authorization: string
}

export type GqlResult<T> = { ok: true; data: T } | { ok: false; error: TrackerError }

/** 房间的上下文可能没有 http（测试或旧接线）：那是接线缺件，按环境失败大声报，不静默跳过。 */
function channelOf(ctx: OpContext | BackendContext) {
  const http = ctx.http
  if (!http || typeof http.request !== 'function') return null
  return http
}

/** 文档里第一行的操作名（`query LinearIssue` → `LinearIssue`）；匿名文档记 `anonymous`。 */
function operationNameOf(query: string): string {
  const named = /\b(query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)
  return named ? named[2] : 'anonymous'
}

/**
 * 一次请求的边界埋点（**按需**事件 `linear.request`，附录 1.5 的 #136）。
 *
 * 为什么房间要记：通道只报通路健康（`gh.transport` 那一档），它不知道 HTTP 200 里带回的
 * `errors[]` 被翻成了哪一档，也不知道这一趟花了多久 —— 没有这一行，导出的日志里
 * 「Linear 读失败了」查不出原因（PR #26 review 的 P1）。
 *
 * 记什么：操作名、桶、结局（八档之一或 ok）、耗时、账号别名。
 * **不记**：请求头（Authorization 在里面）、请求正文、变量、完整地址 —— 日志落盘不许带可重放的凭据。
 */
function logRequest(
  ctx: OpContext | BackendContext,
  account: LinearAccount,
  fields: { op: string; bucket: string; outcome: string; ms: number },
): void {
  try {
    const logEvent = ctx.logEvent
    if (typeof logEvent !== 'function') return
    // 外层判断：调试开关关着时连字段对象都不组装（日志纪律第三条）。
    if (typeof ctx.isEnabled === 'function' && !ctx.isEnabled('debug')) return
    logEvent('debug', 'linear.request', { op: fields.op, bucket: fields.bucket, outcome: fields.outcome, ms: fields.ms, alias: account.alias })
  } catch { /* 埋点失败不改结果 */ }
}

/**
 * 发一次 GraphQL 请求。
 *
 * bucket 由调用方给：读走 read，写走 write，探活走 probe —— 通道据此分出站名额与冷却档。
 * 写请求成功时通道自己记一笔搭车账，这里不重复记。
 */
export async function gql<T>(
  ctx: OpContext | BackendContext,
  account: LinearAccount,
  req: { query: string; variables?: Record<string, unknown>; bucket?: 'read' | 'write' | 'probe' },
): Promise<GqlResult<T>> {
  const bucket = req.bucket || 'read'
  const op = operationNameOf(req.query)
  const started = Date.now()
  /** 所有出口都从这里过：先记一行，再回信封 —— 这样成功与失败都留得下边界。 */
  const done = (result: GqlResult<T>): GqlResult<T> => {
    logRequest(ctx, account, { op, bucket, outcome: result.ok ? 'ok' : result.error.kind, ms: Date.now() - started })
    return result
  }

  const http = channelOf(ctx)
  if (!http) return done({ ok: false, error: linearError(ERROR_KIND.ENV, 'the room has no HTTP channel wired (ctx.http is missing)') })

  let response
  try {
    response = await http.request({
      method: 'POST',
      url: account.endpoint,
      headers: { Authorization: account.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: req.query, variables: req.variables || {} }),
      bucket,
      service: 'linear',
      signal: (ctx as OpContext).signal,
    })
  } catch (error) {
    // 通道只在传输层失败时抛错；到这一格说明这一趟没拿到任何回话。
    return done({ ok: false, error: linearError(kindOfThrow(error), String((error as Error)?.message || error)) })
  }

  if (response.status < 200 || response.status >= 300) {
    const snippet = String(response.body || '').slice(0, 200)
    return done({ ok: false, error: linearError(kindOfStatus(response.status), 'Linear answered HTTP ' + response.status + (snippet ? ': ' + snippet : '')) })
  }

  let payload: { data?: T; errors?: unknown }
  try {
    payload = JSON.parse(response.body || '{}')
  } catch (error) {
    return done({ ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear answered something that is not JSON') })
  }

  if (payload.errors) {
    const classified = classifyGraphQLErrors(payload.errors)
    return done({ ok: false, error: linearError(classified.kind, classified.message) })
  }
  if (payload.data === undefined || payload.data === null) {
    return done({ ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear answered without a data field') })
  }
  return done({ ok: true, data: payload.data })
}
