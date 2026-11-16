/**
 * src/tracker/rooms/linear/errors.ts —— 把 Linear 的失败翻成契约的八个分类
 *
 * 分类决定界面怎么说话（引导重新登录 / 提示稍后 / 说明做不到），所以八个取值一个不多一个不少。
 * 八个**名字**不在本文件里写：它们的唯一真源是 `src/tracker/contract/vocabulary.ts` 的 `ERROR_KIND`
 * （`tests/verify-error-single-source.ts` 的 B1 就是守这一条）。本文件只做「哪种失败归哪一档」的判断。
 *
 * Linear 的三种失败形状各归各档：
 *   · 传输层抛错（连不上、超时、被掐断）→ NETWORK，环境缺 fetch 才是 ENV；
 *   · HTTP 401 / 403 / 404 / 409 / 429 → AUTH / AUTH / NOTFOUND / CONFLICT / RATELIMIT；
 *   · HTTP 200 但带 errors[]（Linear 最常见的失败写法）→ 按 extensions.code 与 type 认。
 */
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { TrackerError } from '../../contract/results.js'

/**
 * 造一个契约形状的失败。所有出口都经它，避免各自拼 message 与 kind。
 *
 * `raw` 是契约必填的第三段：原文。本房造失败时手上只有一句人话（真正的原文在 client 那一层
 * 已被翻成人话），所以让 raw 与 message 同值 —— 比留空诚实，也比再编一段「原文」诚实。
 */
export function linearError(kind: ErrorKind, message: string): TrackerError {
  return { kind, message, raw: message }
}

/**
 * 造一个失败信封。房间只有这一个地方把 `{ ok: false, error }` 拼起来
 * （`tests/verify-error-single-source.ts` 的 A2 要求失败信封出自错误模块，不在各操作里现拼）。
 */
export function failLinear(kind: ErrorKind, message: string): { ok: false; error: TrackerError } {
  return { ok: false, error: linearError(kind, message) }
}

/** HTTP 状态码 → 分类。5xx 与其余未列举的一律 NETWORK（重试可能有用），不是 PARSE。 */
export function kindOfStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return ERROR_KIND.AUTH
  if (status === 404) return ERROR_KIND.NOTFOUND
  if (status === 409) return ERROR_KIND.CONFLICT
  if (status === 429) return ERROR_KIND.RATELIMIT
  return ERROR_KIND.NETWORK
}

/** 传输层抛出来的错：环境缺 fetch 是 ENV，其余是 NETWORK。 */
export function kindOfThrow(error: unknown): ErrorKind {
  const message = String((error as Error)?.message || error || '')
  if (/no fetch implementation/i.test(message)) return ERROR_KIND.ENV
  return ERROR_KIND.NETWORK
}

/**
 * GraphQL 的 errors[] → 分类与一句话。
 *
 * Linear 在 HTTP 200 里回错误是常态（研究笔记 §9）：`extensions.code` 只被文档点名过一次
 * （RATELIMITED），SDK 另读 `extensions.type`（authentication error / invalid input / …），
 * 所以两处都认；认不出来按 NETWORK —— 让它可重试，而不是伪装成解析失败。
 */
export function classifyGraphQLErrors(errors: unknown): { kind: ErrorKind; message: string } {
  const list = Array.isArray(errors) ? errors : []
  const first = list[0] as { message?: string; extensions?: { code?: string; type?: string } } | undefined
  const message = String(first?.message || 'Linear returned an error')
  const code = String(first?.extensions?.code || '').toUpperCase()
  const type = String(first?.extensions?.type || '').toLowerCase()
  // 顺序是有意的：'feature not accessible' 里也含 'not accessible'，所以**先**认能力缺失这一档。
  // 反过来写会让 UNSUPPORTED 永远走不到，把「这个操作不可用」说成「你登录失败了」，
  // 界面于是把人赶去重新登录（PR #26 review 指出过这一条）。
  if (type.includes('feature not accessible')) return { kind: ERROR_KIND.UNSUPPORTED, message }
  if (code === 'RATELIMITED' || type.includes('ratelimit') || type.includes('usage limit')) return { kind: ERROR_KIND.RATELIMIT, message }
  if (type.includes('authentication') || type.includes('forbidden') || type.includes('not accessible')) return { kind: ERROR_KIND.AUTH, message }
  if (type.includes('invalid input') || type === 'user error') return { kind: ERROR_KIND.CONFLICT, message }
  return { kind: ERROR_KIND.NETWORK, message }
}
