/**
 * src/host/linearSignin.ts — the host half of Linear sign-in (map ticket #19).
 *
 * The DSH authorization seam owns the conversation with the person and never the protocol, so the
 * protocol is here. The pure part — what goes on the wire and how an answer is read — is in
 * src/shared/linear-signin/src/protocol.ts and is pinned offline. This file adds what a pure module
 * cannot: the network, a loopback listener, the clock and the credential store, each injected so
 * tests/verify-19-linear-signin.ts can run the whole flow against stand-ins.
 *
 * Two modes, one record per account (`skills-deck/linear-<alias>`, the record the resolver reads):
 *
 *   - `oauth_app` (route B, decided in ticket #19): the client-credentials grant. One secret prompt,
 *     one POST, no browser. There is no refresh token, so the client id and secret stay in the record
 *     and the next token is requested with them.
 *   - `oauth_user`: authorization code with PKCE S256. A loopback listener on a port this plugin owns
 *     receives the redirect; when the port is taken the person pastes the code instead.
 *
 * Rules that are easy to break and expensive to find out later:
 *   - A record is written only through `modifyRecord`, and a refreshed grant is persisted BEFORE the
 *     shared promise resolves: Linear rotates the refresh token on every refresh, so resolving first
 *     and failing to write would lose the only valid one.
 *   - Renewal is single-flight per alias, so two requests that both find the token stale make one call.
 *   - A request that came back 401 is renewed once and replayed once; a second 401 is the answer.
 *   - No token, secret or code is ever placed in a log line, a notice or an error message.
 */

import {
  LINEAR_REVOKE_URL,
  LINEAR_SCOPE,
  LINEAR_TOKEN_URL,
  buildAuthorizeUrl,
  clientCredentialsBody,
  codeExchangeBody,
  grantPayload,
  needsRenewal,
  parseCallback,
  parseTokenResponse,
  refreshBody,
  revokeBody,
} from '../shared/linear-signin/src/protocol.js'
import type { LinearGrantPayload } from '../shared/linear-signin/src/protocol.js'
import { LINEAR_CREDENTIAL_SCOPE, linearCredentialId, linearCredentialKey } from '../shared/linear-accounts/src/resolve.js'
import { LINEAR_PROBE_TIMEOUT_MS } from '../shared/time-config/src/values.js'

/** The two answers the token endpoint call can give. */
export type TokenCall = { ok: true; status: number; body: unknown } | { ok: false; reason: string; message: string }

/** Everything this file takes from outside, each optional so a gate can pass stand-ins. */
export interface LinearSigninDeps {
  fetchImpl?: any
  now?: () => number
  randomBytes?: (n: number) => Uint8Array
  sha256?: (text: string) => Promise<Uint8Array>
  timeoutMs?: number
  tokenUrl?: string
  revokeUrl?: string
  /** Opens a loopback listener and resolves what it received; absent means "paste mode only". */
  listen?: (port: number, signal: AbortSignal) => Promise<{ url: string; wait: Promise<string>; close: () => void } | null>
  /** The port this plugin owns for the redirect URI registered in the Linear OAuth application. */
  redirectPort?: number
}

/** The port for the redirect URI `http://127.0.0.1:<port>/callback` — registered once in the Linear OAuth app. */
export const LINEAR_REDIRECT_PORT = 48719

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return out
}

function b64url(bytes: Uint8Array): string {
  const B: any = (globalThis as any).Buffer
  return B.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function defaults(deps?: LinearSigninDeps) {
  const d = deps || {}
  const nodeCrypto = (): any => (globalThis as any).require ? (globalThis as any).require('node:crypto') : null
  return {
    fetchImpl: d.fetchImpl || (globalThis as any).fetch,
    now: d.now || (() => Date.now()),
    randomBytes: d.randomBytes || ((n: number) => { const c: any = (globalThis as any).crypto; const a = new Uint8Array(n); c.getRandomValues(a); return a }),
    sha256: d.sha256 || (async (text: string) => { const c: any = (globalThis as any).crypto; const enc = new (globalThis as any).TextEncoder().encode(text); return new Uint8Array(await c.subtle.digest('SHA-256', enc)) }),
    timeoutMs: typeof d.timeoutMs === 'number' ? d.timeoutMs : LINEAR_PROBE_TIMEOUT_MS,
    tokenUrl: d.tokenUrl || LINEAR_TOKEN_URL,
    revokeUrl: d.revokeUrl || LINEAR_REVOKE_URL,
    listen: d.listen,
    redirectPort: typeof d.redirectPort === 'number' ? d.redirectPort : LINEAR_REDIRECT_PORT,
    _unused: nodeCrypto,
  }
}

/** One form POST to Linear. Transport failures come back as a reason, never as a thrown error carrying a body. */
export async function postForm(url: string, body: string, deps?: LinearSigninDeps, signal?: AbortSignal): Promise<TokenCall> {
  const o = defaults(deps)
  if (typeof o.fetchImpl !== 'function') return { ok: false, reason: 'upstream_error', message: 'this runtime has no fetch implementation, so Linear cannot be reached' }
  const Controller = (globalThis as any).AbortController
  const controller = new Controller()
  const onAbort = () => { try { controller.abort() } catch (e) { /* already settled */ } }
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
  const timer = setTimeout(onAbort, o.timeoutMs)
  try {
    const response = await o.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: controller.signal })
    const status = typeof response?.status === 'number' ? response.status : 0
    let parsed: unknown = null
    try { parsed = await response.json() } catch (e) { parsed = null }
    return { ok: true, status, body: parsed }
  } catch (e) {
    const msg = String((e && (e as Error).message) || e)
    if (signal && signal.aborted) return { ok: false, reason: 'cancelled', message: 'the sign-in was cancelled' }
    if (/abort/i.test(msg)) return { ok: false, reason: 'timeout', message: 'Linear did not answer within ' + o.timeoutMs + ' ms' }
    return { ok: false, reason: 'upstream_error', message: 'the request to Linear could not be sent: ' + msg.slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/** The text of a failed call or parse, as one sentence that carries no secret. */
function failure(call: TokenCall | { ok: false; reason: string; message: string }): string {
  return call.ok === false ? call.message : 'Linear answered with something unexpected'
}

/** Ask Linear for an app-actor token with the client credentials, and return the record payload. */
export async function signInApp(p: { alias: string; clientId: string; clientSecret: string; orgId?: string; urlKey?: string }, deps?: LinearSigninDeps, signal?: AbortSignal): Promise<{ ok: true; payload: LinearGrantPayload } | { ok: false; reason: string; message: string }> {
  const o = defaults(deps)
  const call = await postForm(o.tokenUrl, clientCredentialsBody({ clientId: p.clientId, clientSecret: p.clientSecret }), deps, signal)
  if (call.ok === false) return call
  const parsed = parseTokenResponse(call.status, call.body)
  if (parsed.ok === false) return parsed
  return { ok: true, payload: grantPayload({ mode: 'oauth_app', alias: p.alias, clientId: p.clientId, clientSecret: p.clientSecret, parsed, now: o.now(), orgId: p.orgId, urlKey: p.urlKey }) }
}

/** Exchange an authorization code (PKCE) for a user grant. */
export async function exchangeUserCode(p: { alias: string; clientId: string; clientSecret?: string; code: string; redirectUri: string; codeVerifier: string }, deps?: LinearSigninDeps, signal?: AbortSignal): Promise<{ ok: true; payload: LinearGrantPayload } | { ok: false; reason: string; message: string }> {
  const o = defaults(deps)
  const call = await postForm(o.tokenUrl, codeExchangeBody({ code: p.code, redirectUri: p.redirectUri, clientId: p.clientId, clientSecret: p.clientSecret, codeVerifier: p.codeVerifier }), deps, signal)
  if (call.ok === false) return call
  const parsed = parseTokenResponse(call.status, call.body)
  if (parsed.ok === false) return parsed
  return { ok: true, payload: grantPayload({ mode: 'oauth_user', alias: p.alias, clientId: p.clientId, clientSecret: p.clientSecret, parsed, now: o.now() }) }
}

/** The credential store surface this file uses: only the two calls it needs. */
export interface CredentialStoreLike {
  readRecord(key: string): Promise<any>
  modifyRecord(key: string, mutate: (current: any) => Promise<any>): Promise<any>
  deleteRecord(key: string): Promise<void>
}

const inflight: Map<string, Promise<{ ok: true; accessToken: string } | { ok: false; reason: string; message: string }>> = new Map()

/**
 * Make sure the grant for one account holds a usable access token, renewing it when it is inside the
 * renewal window or when the caller says a request was just refused (`force`). Single-flight per alias:
 * a second caller while a renewal runs awaits the same promise instead of spending a second refresh
 * token. The renewed grant is written through `modifyRecord` before that promise resolves.
 */
export function ensureFreshGrant(store: CredentialStoreLike, alias: string, opts?: { force?: boolean }, deps?: LinearSigninDeps): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string; message: string }> {
  const key = linearCredentialKey(alias)
  const running = inflight.get(key)
  if (running) return running
  const work = (async () => {
    const o = defaults(deps)
    const record = await store.readRecord(key)
    const payload: LinearGrantPayload | null = record && record.kind === 'grant' && record.payload && typeof record.payload === 'object' ? (record.payload as LinearGrantPayload) : null
    if (!payload || typeof payload.accessToken !== 'string' || payload.accessToken === '') return { ok: false as const, reason: 'needs_auth', message: 'no grant is stored for ' + alias + '; sign in first' }
    if (!opts?.force && !needsRenewal(payload, o.now())) return { ok: true as const, accessToken: payload.accessToken }

    let renewed: { ok: true; payload: LinearGrantPayload } | { ok: false; reason: string; message: string }
    if (payload.mode === 'oauth_app') {
      if (!payload.clientId || !payload.clientSecret) return { ok: false as const, reason: 'needs_auth', message: 'the stored app grant for ' + alias + ' lacks its client id or secret; sign in again' }
      renewed = await signInApp({ alias, clientId: payload.clientId, clientSecret: payload.clientSecret, orgId: payload.orgId, urlKey: payload.urlKey }, deps)
    } else {
      if (!payload.refreshToken) return { ok: false as const, reason: 'needs_auth', message: 'the stored grant for ' + alias + ' has no refresh token; sign in again' }
      const call = await postForm(o.tokenUrl, refreshBody({ refreshToken: payload.refreshToken, clientId: payload.clientId, clientSecret: payload.clientSecret }), deps)
      if (call.ok === false) return call
      const parsed = parseTokenResponse(call.status, call.body)
      if (parsed.ok === false) return parsed
      renewed = { ok: true, payload: grantPayload({ mode: 'oauth_user', alias, clientId: payload.clientId, clientSecret: payload.clientSecret, parsed, now: o.now(), previous: payload }) }
    }
    if (renewed.ok === false) return renewed

    // Persist first, resolve second: the rotated refresh token exists nowhere else.
    const next = renewed.payload
    try {
      await store.modifyRecord(key, async () => ({ kind: 'grant', payload: next }))
    } catch (e) {
      return { ok: false as const, reason: 'credential_store_unavailable', message: 'the renewed token could not be saved for ' + alias + ': ' + String((e as Error)?.message || e).slice(0, 120) }
    }
    return { ok: true as const, accessToken: next.accessToken }
  })()
  inflight.set(key, work)
  const release = () => { if (inflight.get(key) === work) inflight.delete(key) }
  work.then(release, release)
  return work
}

/**
 * Revoke an account's grant at Linear, then forget the local record whatever Linear answered: a sign-out
 * that depends on the network would leave a person unable to remove a credential while offline. The
 * seam cannot revoke, so this is the only place it happens.
 */
export async function signOut(store: CredentialStoreLike, alias: string, deps?: LinearSigninDeps): Promise<{ revoked: boolean; message: string }> {
  const o = defaults(deps)
  const key = linearCredentialKey(alias)
  let revoked = false
  let message = 'no stored grant to revoke'
  try {
    const record = await store.readRecord(key)
    const payload: LinearGrantPayload | null = record && record.kind === 'grant' && record.payload ? (record.payload as LinearGrantPayload) : null
    const token = payload ? (payload.refreshToken || payload.accessToken || '') : ''
    if (token) {
      const call = await postForm(o.revokeUrl, revokeBody(token, payload && payload.refreshToken ? 'refresh_token' : 'access_token'), deps)
      revoked = call.ok === true && call.status >= 200 && call.status < 300
      message = revoked ? 'revoked at Linear' : 'Linear did not confirm the revoke (' + (call.ok ? 'HTTP ' + call.status : call.reason) + '); the local record is removed anyway'
    }
  } catch (e) {
    message = 'the stored grant could not be read; removing it anyway'
  }
  await store.deleteRecord(key)
  return { revoked, message }
}

/** The shape of the session the seam hands a flow, narrowed to what these flows use. */
export interface SessionLike {
  readonly method: string
  readonly signal: AbortSignal
  commit(record: any): Promise<void>
  notify(n: { message: string; url?: string; code?: string }): void
  prompt(p: any): Promise<string>
}

/** The account facts a flow needs and the document supplies. */
export interface FlowAccount {
  alias: string
  label?: string
  authType: string
  orgId?: string
  urlKey?: string
}

/**
 * Build the flow that signs one account in. The client id is asked for with a plain question and the
 * secret with a masked one, so neither lives in a settings file; both end up only in the credential
 * record. Methods are ordered by the account's own auth type, so the picker offers the right one first.
 */
export function buildLinearFlow(account: FlowAccount, deps?: LinearSigninDeps): { key: string; label: string; methods: Array<{ id: string; label: string }>; run: (session: SessionLike) => Promise<void> } {
  const methods = account.authType === 'oauth_user'
    ? [{ id: 'oauth_user', label: 'Sign in as yourself (browser)' }]
    : [{ id: 'oauth_app', label: 'Sign in as the app (client credentials)' }]
  return {
    key: linearCredentialKey(account.alias),
    label: 'Linear — ' + (account.label || account.alias),
    methods,
    async run(session: SessionLike): Promise<void> {
      const o = defaults(deps)
      const clientId = (await session.prompt({ kind: 'text', message: 'Linear OAuth application client id' })).trim()
      if (clientId === '') throw new Error('a client id is required')
      if (session.method === 'oauth_app') {
        const clientSecret = (await session.prompt({ kind: 'secret', message: 'Linear OAuth application client secret' })).trim()
        if (clientSecret === '') throw new Error('a client secret is required')
        session.notify({ message: 'Asking Linear for an app token with scope ' + LINEAR_SCOPE })
        const got = await signInApp({ alias: account.alias, clientId, clientSecret, orgId: account.orgId, urlKey: account.urlKey }, deps, session.signal)
        if (got.ok === false) throw new Error(failure(got))
        await session.commit({ kind: 'grant', payload: got.payload })
        return
      }
      // oauth_user: authorization code with PKCE, loopback first and paste as the fallback.
      const clientSecret = (await session.prompt({ kind: 'secret', message: 'Linear OAuth application client secret (leave empty when the app is PKCE-only)' })).trim()
      const verifier = b64url(o.randomBytes(48))
      const challenge = b64url(await o.sha256(verifier))
      const state = hex(o.randomBytes(16))
      const redirectUri = 'http://127.0.0.1:' + o.redirectPort + '/callback'
      const url = buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge: challenge })
      const listener = o.listen ? await o.listen(o.redirectPort, session.signal) : null
      session.notify({ message: listener ? 'Approve access in your browser; this window continues by itself.' : 'Approve access in your browser, then paste the code or the full address Linear shows.', url })
      let received = ''
      try {
        received = listener ? await listener.wait : await session.prompt({ kind: 'text', message: 'Paste the code or the redirect address' })
      } finally {
        if (listener) listener.close()
      }
      const cb = parseCallback(received)
      if (cb.ok === false) throw new Error('the callback could not be read (' + cb.reason + ')')
      if (cb.state !== '' && cb.state !== state) throw new Error('the callback belongs to a different sign-in attempt; start again')
      const got = await exchangeUserCode({ alias: account.alias, clientId, clientSecret: clientSecret || undefined, code: cb.code, redirectUri, codeVerifier: verifier }, deps, session.signal)
      if (got.ok === false) throw new Error(failure(got))
      await session.commit({ kind: 'grant', payload: got.payload })
    },
  }
}

/**
 * Register one flow per configured account on the authorization seam and return the disposer. A missing
 * seam is not an error of this call: a headless composition simply has nothing to register, and the
 * accounts then read as needs_auth, which is the correct state.
 */
export function registerLinearFlows(ctx: any, accounts: FlowAccount[], deps?: LinearSigninDeps): () => void {
  let authorization: any = null
  try { authorization = ctx && typeof ctx.get === 'function' ? ctx.get('authorization') : null } catch (e) { authorization = null }
  if (!authorization || typeof authorization.registerFlow !== 'function') return () => {}
  const disposers: Array<() => void> = []
  for (const account of accounts) {
    if (account.authType !== 'oauth_user' && account.authType !== 'oauth_app') continue
    try { disposers.push(authorization.registerFlow(buildLinearFlow(account, deps))) } catch (e) { /* one duplicate flow must not stop the others */ }
  }
  return () => { for (const d of disposers) { try { d() } catch (e) { /* already withdrawn */ } } }
}

/** Exposed so the gate and the host wiring agree on the record id without re-deriving it. */
export const LINEAR_SIGNIN_RECORD_SCOPE = LINEAR_CREDENTIAL_SCOPE
export { linearCredentialId }
