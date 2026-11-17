/**
 * src/host/linearAccountSeam.ts — the host half of the account seam: turn what the Linear account
 * resolver found into what a tracker room is allowed to see (ticket #27, ADR 20261117-room-account-seam).
 *
 * The room asks the seam for an account by alias and gets back a ready `Authorization` header or a
 * classified failure. It never gets the token. The resolver in src/shared/linear-accounts/src/resolve.ts
 * returns a record that DOES carry the token (`token`), because the host needs it to build the header and
 * to probe identity. This file is the one place that record is narrowed, so the rule "a token never crosses
 * the boundary" lives in a single function that a gate can pin.
 *
 * The result is BUILT field by field, never copied and then trimmed. A copy-then-delete would let any field
 * the resolver grows tomorrow (a refresh token, the client secret, a raw payload) cross the boundary without
 * anyone deciding it should; building from a short allowed list means a new field stays on the host side until
 * someone adds it here on purpose.
 *
 * The shapes below follow the ADR (section 2, part 3). `src/tracker/contract/accounts.ts` does not exist yet:
 * ticket #13 creates it. When it lands, replace the two local types with `import type` from there; the host may
 * import the contract, the contract may not import the host, so nothing else changes.
 */

import type { LinearResolution } from '../shared/linear-accounts/src/resolve.js'
import type { AccountSeamResult, AccountSeamStatus } from '../tracker/contract/accounts.js'

/** The shapes live in the contract since #13 landed them; this module narrows into them. */
export type AccountFailureStatus = AccountSeamStatus
export type AccountSeamResolution = AccountSeamResult

/** The failure statuses the seam may report; anything else the resolver might say becomes a plain `error`. */
const FAILURE_STATUSES: readonly string[] = ['needs_auth', 'identity_mismatch', 'error', 'unconfigured']

/**
 * Replace every occurrence of the token (and of the authorization header value) in a message. The resolver
 * promises its messages carry no secret; this is a second guard at the boundary because the cost of a leak
 * here is a token in a room's log line or an error shown to a person.
 */
function scrub(text: string, secrets: string[]): string {
  let out = String(text === undefined || text === null ? '' : text)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('<redacted>')
  }
  return out
}

/**
 * Narrow one resolver answer to what crosses the seam.
 *
 * `endpoint` is passed through only when the caller gives one; the room has its own default, and the host
 * does not invent one here.
 */
export function toAccountResolution(resolution: LinearResolution, opts?: { endpoint?: string }): AccountSeamResolution {
  const raw = (resolution || {}) as unknown as Record<string, unknown>
  const secrets: string[] = []
  if (typeof raw['token'] === 'string') secrets.push(raw['token'] as string)
  if (typeof raw['authorization'] === 'string') secrets.push(raw['authorization'] as string)

  if (raw['status'] === 'ok') {
    const authorization = typeof raw['authorization'] === 'string' ? (raw['authorization'] as string) : ''
    const alias = typeof raw['alias'] === 'string' ? (raw['alias'] as string) : ''
    // A success with no header is not a success the room can use: report it instead of handing over an empty one.
    if (authorization === '' || alias === '') {
      return { ok: false, status: 'error', message: 'the Linear account resolved without a usable authorization header, so the room cannot act as it' }
    }
    const out: AccountSeamResolution = { ok: true, alias, authorization }
    if (opts && typeof opts.endpoint === 'string' && opts.endpoint !== '') out.endpoint = opts.endpoint
    return out
  }

  const status = FAILURE_STATUSES.indexOf(String(raw['status'])) >= 0 ? (raw['status'] as AccountFailureStatus) : 'error'
  const message = scrub(typeof raw['message'] === 'string' ? (raw['message'] as string) : 'the Linear account could not be resolved', secrets)
  return { ok: false, status, message }
}
