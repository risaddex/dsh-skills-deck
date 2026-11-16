/**
 * src/tracker/rooms/linear/client.ts —— Linear 房的请求层：一次 GraphQL 调用
 *
 * 房间不许用全局 fetch（契约里那句），所以这里只走 `ctx.http.request`。通道自己拿出站名额、
 * 自己上报结局；本文件只负责三件事：拼请求、认 HTTP 状态、把 errors[] 翻成契约分类。
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

/**
 * 发一次 GraphQL 请求。
 *
 * bucket 由调用方给：读走 read，写走 write —— 通道据此分出站名额与冷却档。写请求成功时
 * 通道自己记一笔搭车账，这里不重复记。
 */
export async function gql<T>(
  ctx: OpContext | BackendContext,
  account: LinearAccount,
  req: { query: string; variables?: Record<string, unknown>; bucket?: 'read' | 'write' | 'probe' },
): Promise<GqlResult<T>> {
  const http = channelOf(ctx)
  if (!http) return { ok: false, error: linearError(ERROR_KIND.ENV, 'the room has no HTTP channel wired (ctx.http is missing)') }

  let response
  try {
    response = await http.request({
      method: 'POST',
      url: account.endpoint,
      headers: { Authorization: account.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: req.query, variables: req.variables || {} }),
      bucket: req.bucket || 'read',
      service: 'linear',
      signal: (ctx as OpContext).signal,
    })
  } catch (error) {
    // 通道只在传输层失败时抛错；到这一格说明这一趟没拿到任何回话。
    return { ok: false, error: linearError(kindOfThrow(error), String((error as Error)?.message || error)) }
  }

  if (response.status < 200 || response.status >= 300) {
    const snippet = String(response.body || '').slice(0, 200)
    return { ok: false, error: linearError(kindOfStatus(response.status), 'Linear answered HTTP ' + response.status + (snippet ? ': ' + snippet : '')) }
  }

  let payload: { data?: T; errors?: unknown }
  try {
    payload = JSON.parse(response.body || '{}')
  } catch (error) {
    return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear answered something that is not JSON') }
  }

  if (payload.errors) {
    const classified = classifyGraphQLErrors(payload.errors)
    return { ok: false, error: linearError(classified.kind, classified.message) }
  }
  if (payload.data === undefined || payload.data === null) {
    return { ok: false, error: linearError(ERROR_KIND.PARSE, 'Linear answered without a data field') }
  }
  return { ok: true, data: payload.data }
}
