import { TRACKER_ERROR_STAGE, type OpResult } from '../contract/results.js'
import { ERROR_KIND } from '../contract/vocabulary.js'

/** 不认账号筛选的房间必须在读之前拒绝，不能忽略筛选后把另一份清单当成答案。没有筛选时返回空值，原路径不变。 */
export function refuseAccountRead(options: unknown): OpResult<never> | null {
  if (!options || typeof options !== 'object') return null
  const input = options as Record<string, unknown>
  if (input.account === undefined && input.scope === undefined) return null
  const malformed = (input.account !== undefined && (typeof input.account !== 'string' || input.account.trim() === ''))
    || (input.scope !== undefined && input.scope !== 'assigned' && input.scope !== 'review')
  return {
    ok: false,
    error: {
      kind: malformed ? ERROR_KIND.PARSE : ERROR_KIND.UNSUPPORTED,
      message: malformed ? 'Account reads require a nonempty account alias and scope assigned or review.' : 'This backend does not support account or inbox-scope reads; no read was sent.',
      stage: TRACKER_ERROR_STAGE.INPUT_REFUSED,
      raw: '',
    },
  }
}
