/**
 * src/shared/linear-signin/src/protocol.ts — the wire shapes of Linear sign-in (map ticket #19).
 *
 * Everything here is a pure function of its inputs: it builds the text that goes on the wire and reads
 * the text that comes back. No network, no filesystem, no clock (the caller passes `now`), so each rule
 * can be pinned offline — which matters because the cases that bite are the ones nobody reproduces by
 * hand: a token answer with no `expires_in`, a callback pasted in the wrong shape, a refresh that
 * must not lose the rotated refresh token.
 *
 * Two sign-in modes are built from these pieces (research/12-linear-signin-protocol.md, section D):
 *
 *   - `oauth_user`: authorization code with PKCE S256, as the plugin this fork replaces did it, but
 *     with scope `read,write` because this fork writes tickets.
 *   - `oauth_app`: the client-credentials grant (decision in ticket #19, route B). It has no browser
 *     step and no refresh token, so the secret has to be kept to ask for the next token.
 *
 * No secret value is ever placed in an error message built here.
 */

/** Not exported: only buildAuthorizeUrl needs it, and an exported constant nobody else reads is dead vocabulary to the shared-layer gate. */
const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke'

/**
 * The scope set, spelled the way Linear's own examples spell it. One value for every machine and both
 * modes on purpose: Linear revokes an app's existing app-actor tokens when a request names a different
 * scope set, so two processes using different strings would sign each other out.
 */
export const LINEAR_SCOPE = 'read,write'

/** A token inside this many milliseconds of expiring is renewed before use rather than after a 401. */
export const LINEAR_RENEW_WINDOW_MS = 5 * 60 * 1000

/** The fields a grant record's payload carries. It must survive a JSON round trip, so only plain values. */
export interface LinearGrantPayload {
  mode: 'oauth_user' | 'oauth_app'
  alias: string
  clientId: string
  /** Kept for oauth_app, which has no refresh token and needs it to ask again; absent for a PKCE oauth_user grant. */
  clientSecret?: string
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds when the access token stops working; 0 when Linear did not say. */
  expiresAt: number
  scope: string[]
  obtainedAt: number
  orgId?: string
  urlKey?: string
}

/** Percent-encode one form component the way application/x-www-form-urlencoded wants it. */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+')
}

/** An ordered list of pairs as a form body; undefined and empty values are left out so no field is sent blank. */
export function formBody(pairs: Array<[string, string | undefined]>): string {
  const parts: string[] = []
  for (const pair of pairs) {
    const value = pair[1]
    if (value === undefined || value === '') continue
    parts.push(enc(pair[0]) + '=' + enc(value))
  }
  return parts.join('&')
}

/** The authorize URL for the oauth_user mode. `prompt=consent` is deliberate: without it Linear reuses the browser's earlier consent and a token can land in the wrong workspace. */
export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scope?: string; actor?: 'user' | 'app' }): string {
  const query = formBody([
    ['response_type', 'code'],
    ['client_id', p.clientId],
    ['redirect_uri', p.redirectUri],
    ['scope', p.scope || LINEAR_SCOPE],
    ['state', p.state],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
    ['actor', p.actor || 'user'],
  ])
  return LINEAR_AUTHORIZE_URL + '?' + query
}

/** What a pasted or redirected callback carried: the code and the state, or why neither is usable. */
export type CallbackParse = { ok: true; code: string; state: string } | { ok: false; reason: string }

/**
 * Read a callback in any of the three shapes a person can end up with: the full redirect URL, just its
 * query string, or the bare code Linear shows when the loopback port was busy. A bare code carries no
 * state, which is reported as an empty state so the caller can decide whether that is acceptable.
 */
export function parseCallback(input: string): CallbackParse {
  const text = String(input === undefined || input === null ? '' : input).trim()
  if (text === '') return { ok: false, reason: 'empty' }
  let query = ''
  const q = text.indexOf('?')
  if (q >= 0) query = text.slice(q + 1)
  else if (text.indexOf('=') >= 0) query = text
  if (query === '') return { ok: true, code: text, state: '' }
  const hash = query.indexOf('#')
  if (hash >= 0) query = query.slice(0, hash)
  const values: Record<string, string> = {}
  for (const part of query.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const key = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '))
    const val = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '))
    values[key] = val
  }
  if (values['error']) return { ok: false, reason: 'provider_error:' + String(values['error']).slice(0, 80) }
  if (!values['code']) return { ok: false, reason: 'no_code' }
  return { ok: true, code: values['code'], state: values['state'] || '' }
}

/** The body of the authorization-code exchange (oauth_user). PKCE makes the secret optional; it is sent only when given. */
export function codeExchangeBody(p: { code: string; redirectUri: string; clientId: string; clientSecret?: string; codeVerifier: string }): string {
  return formBody([
    ['grant_type', 'authorization_code'],
    ['code', p.code],
    ['redirect_uri', p.redirectUri],
    ['client_id', p.clientId],
    ['client_secret', p.clientSecret],
    ['code_verifier', p.codeVerifier],
  ])
}

/** The body of a refresh (oauth_user). */
export function refreshBody(p: { refreshToken: string; clientId: string; clientSecret?: string }): string {
  return formBody([
    ['grant_type', 'refresh_token'],
    ['refresh_token', p.refreshToken],
    ['client_id', p.clientId],
    ['client_secret', p.clientSecret],
  ])
}

/** The body of the client-credentials request (oauth_app). The scope is always the fixed set, see LINEAR_SCOPE. */
export function clientCredentialsBody(p: { clientId: string; clientSecret: string; scope?: string }): string {
  return formBody([
    ['grant_type', 'client_credentials'],
    ['client_id', p.clientId],
    ['client_secret', p.clientSecret],
    ['scope', p.scope || LINEAR_SCOPE],
  ])
}

/** The body of a revoke call. The hint helps Linear find the token faster; it is not required. */
export function revokeBody(token: string, hint?: 'access_token' | 'refresh_token'): string {
  return formBody([
    ['token', token],
    ['token_type_hint', hint],
  ])
}

/** The error codes RFC 6749 defines for the token endpoint; the only provider text allowed into a message. */
const STANDARD_OAUTH_ERRORS: readonly string[] = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable']

export type TokenParse =
  | { ok: true; accessToken: string; refreshToken: string; expiresInMs: number; scope: string[] }
  | { ok: false; reason: 'oauth_bad_response' | 'oauth_http_error' | 'client_credentials_disabled' | 'invalid_client' | 'invalid_grant'; message: string }

/**
 * Read a token endpoint answer. A reply with no access token is a bad response even on HTTP 200, and a
 * non-2xx answer keeps Linear's own `error` string because it is the only hint a person gets: for
 * example an app without client credentials enabled answers that the client does not support the grant.
 */
export function parseTokenResponse(status: number, body: unknown): TokenParse {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (status < 200 || status >= 300) {
    const error = typeof obj['error'] === 'string' ? String(obj['error']) : ''
    const description = typeof obj['error_description'] === 'string' ? String(obj['error_description']) : ''
    if (/client_credentials/i.test(description)) {
      return { ok: false, reason: 'client_credentials_disabled', message: 'Linear refused the client-credentials grant: switch "client credentials tokens" on for this OAuth application in Linear, then try again' }
    }
    if (error === 'invalid_client') return { ok: false, reason: 'invalid_client', message: 'Linear did not recognise this client id and secret; check them, or the secret may have been rotated' }
    if (error === 'invalid_grant') return { ok: false, reason: 'invalid_grant', message: 'Linear rejected the code or refresh token as spent or expired; sign in again' }
    // Only a standard OAuth error code is echoed back: an unknown string is provider-controlled text, and
    // the one place a secret could ride along is a message a person copies into a ticket.
    const known = STANDARD_OAUTH_ERRORS.indexOf(error) >= 0
    return { ok: false, reason: 'oauth_http_error', message: 'Linear answered HTTP ' + status + (known ? ' (' + error + ')' : '') + ' at the token endpoint' }
  }
  const access = typeof obj['access_token'] === 'string' ? String(obj['access_token']).trim() : ''
  if (access === '') return { ok: false, reason: 'oauth_bad_response', message: 'Linear answered the token request without an access token' }
  const refresh = typeof obj['refresh_token'] === 'string' ? String(obj['refresh_token']).trim() : ''
  const seconds = typeof obj['expires_in'] === 'number' && isFinite(obj['expires_in'] as number) ? (obj['expires_in'] as number) : 0
  const scope = typeof obj['scope'] === 'string' ? String(obj['scope']).split(/[\s,]+/).filter((s) => s !== '') : Array.isArray(obj['scope']) ? (obj['scope'] as unknown[]).map(String) : []
  return { ok: true, accessToken: access, refreshToken: refresh, expiresInMs: seconds > 0 ? Math.round(seconds * 1000) : 0, scope }
}

/** Build the record payload from a parsed token answer. `now` is passed in so this stays a pure function. */
export function grantPayload(p: { mode: 'oauth_user' | 'oauth_app'; alias: string; clientId: string; clientSecret?: string; parsed: { accessToken: string; refreshToken: string; expiresInMs: number; scope: string[] }; now: number; previous?: Partial<LinearGrantPayload> | null; orgId?: string; urlKey?: string }): LinearGrantPayload {
  const out: LinearGrantPayload = {
    mode: p.mode,
    alias: p.alias,
    clientId: p.clientId,
    accessToken: p.parsed.accessToken,
    expiresAt: p.parsed.expiresInMs > 0 ? p.now + p.parsed.expiresInMs : 0,
    scope: p.parsed.scope.length > 0 ? p.parsed.scope : LINEAR_SCOPE.split(','),
    obtainedAt: p.now,
  }
  if (p.clientSecret) out.clientSecret = p.clientSecret
  // A rotation that returns no new refresh token must not erase the one already held.
  const refresh = p.parsed.refreshToken || (p.previous && typeof p.previous.refreshToken === 'string' ? p.previous.refreshToken : '')
  if (refresh) out.refreshToken = refresh
  const orgId = p.orgId || (p.previous && p.previous.orgId) || ''
  const urlKey = p.urlKey || (p.previous && p.previous.urlKey) || ''
  if (orgId) out.orgId = orgId
  if (urlKey) out.urlKey = urlKey
  return out
}

/** Whether a grant should be renewed before use: it has an expiry and that expiry is inside the window. A grant with no expiry is never renewed on a clock, only after a 401. */
export function needsRenewal(payload: { expiresAt?: number } | null | undefined, now: number): boolean {
  const at = payload && typeof payload.expiresAt === 'number' ? payload.expiresAt : 0
  return at > 0 && at - now <= LINEAR_RENEW_WINDOW_MS
}
