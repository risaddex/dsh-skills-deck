/**
 * src/shared/linear-accounts/src/resolve.ts — turning one configured Linear account into a usable
 * request (map ticket #12).
 *
 * This module decides, and the caller does the wire work: it is given a way to read one credential
 * record, a way to read an environment variable, and (when a token is found) a way to ask Linear who
 * the token belongs to. Everything here is a pure function of those inputs, so the behaviour can be
 * pinned offline — which matters, because the interesting cases are exactly the ones nobody can
 * reproduce by hand: a record that outranks the environment, a grant whose access token has expired,
 * a token that answers for a different organization than the account pins.
 *
 * The decision this module records, in order of precedence for one account:
 *
 *   1. The stored credential record `skills-deck/linear-<alias>` (written only through
 *      `ctx.credentials.modifyRecord`, see research/12-linear-accounts-facts.md).
 *   2. The environment convention `LINEAR_KEY_<ALIAS>`, kept from the plugin this fork replaces, so
 *      an existing setup keeps working with no file edit.
 *   3. Nothing usable: the account reports `needs_auth` and its issues are not asked for.
 *
 * A stored record outranking the environment is the platform's own rule for references, and it is
 * repeated here because it is the thing people are surprised by.
 *
 * Account statuses are fixed by the plugin this fork replaces and this module must not invent new
 * ones: `ok | needs_auth | identity_mismatch | error | unconfigured`. No token value ever leaves
 * this module in a message, a status or an error — only the fact that one was found and where.
 */

/** How an account authenticates. `oauth_app` is the actor=app installation (ticket #19). */
export const LINEAR_AUTH_TYPES: readonly string[] = ['api_key', 'oauth_user', 'oauth_app']

/** The account statuses later code, and the panel, already understand. */
export const LINEAR_ACCOUNT_STATUSES: readonly string[] = ['ok', 'needs_auth', 'identity_mismatch', 'error', 'unconfigured']

/** The DSH credential record that holds one account's secret: `<scope>/<id>`, rendered as one string because the seam takes a string at runtime. */
export const LINEAR_CREDENTIAL_SCOPE = 'skills-deck'

/** Default GraphQL endpoint; Linear has no per-workspace hostname. */
export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

/**
 * The identity probe. It answers the two questions the account layer needs: which organization is
 * this token good for (to pin it on first success) and who is behind it (to show a person). The field
 * set is the one the plugin this fork replaces used; research/12-linear-accounts-facts.md records
 * which of these fields Linear's own documentation confirms.
 */
export const LINEAR_IDENTITY_QUERY = 'query DeckLinearIdentity { viewer { id name displayName email organization { id name urlKey } } }'

/** One account, as the account document normalizes it (see config-store/src/linear-accounts.ts). */
export interface LinearAccountInput {
  alias: string
  label?: string
  authType?: string
  orgId?: string
  urlKey?: string
  teams?: string[]
  reviewPattern?: string
  reviewScope?: string
}

/** The record shape this module reads: the DSH seam's two kinds, narrowed to what matters here. */
export interface LinearCredentialRecord {
  kind?: string
  key?: string
  payload?: unknown
}

/** What a successful resolution hands back. The token is here and nowhere else. */
export interface LinearResolved {
  status: 'ok'
  alias: string
  authType: string
  token: string
  authorization: string
  source: 'record' | 'env'
  orgId: string
  urlKey: string
  viewerName: string
  teams: string[]
  reviewPattern: string
  reviewScope: string
}

/** What an account looks like when it cannot be used, and the one sentence a person can act on. */
export interface LinearUnresolved {
  status: 'needs_auth' | 'identity_mismatch' | 'error' | 'unconfigured'
  alias: string
  authType: string
  reason: string
  message: string
}

export type LinearResolution = LinearResolved | LinearUnresolved

/** What resolving a token can answer: the token and where it came from, or why there is none. */
export type LinearTokenResult =
  | { status: 'ok'; token: string; source: 'record' | 'env'; authType: string }
  | { status: 'needs_auth' | 'unconfigured'; reason: string; message: string }

/** The record id for one account: stable and derived, never typed by a person. */
export function linearCredentialId(alias: string): string {
  return 'linear-' + String(alias)
}

/** The record key the seam stores it under, as the single string the service receives at runtime. */
export function linearCredentialKey(alias: string): string {
  return LINEAR_CREDENTIAL_SCOPE + '/' + linearCredentialId(alias)
}

/**
 * The environment variable that carries a personal API key for an account. The alias is lowercased
 * with hyphens turned into underscores, so `ombrello-two` reads `LINEAR_KEY_OMBRELLO_TWO` — the
 * convention the plugin this fork replaces used, kept so an existing shell setup needs no change.
 */
export function linearApiKeyEnvName(alias: string): string {
  return 'LINEAR_KEY_' + String(alias).trim().toUpperCase().replace(/-/g, '_')
}

/**
 * The Authorization header value. Linear takes a personal API key bare and every OAuth token with the
 * `Bearer` scheme (research/12-linear-signin-protocol.md, "Authorization headers"); sending an OAuth
 * token bare, or a personal key as Bearer, is a 401 with no hint about which half was wrong.
 */
export function linearAuthorization(authType: string, token: string): string {
  return String(authType) === 'api_key' ? String(token) : 'Bearer ' + String(token)
}

/** A non-empty text value, or the empty string: every check below wants the same question answered. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The access token carried by a grant record, or '' when it carries none. */
function grantAccessToken(record: LinearCredentialRecord): string {
  const payload = record && record.payload
  if (!payload || typeof payload !== 'object') return ''
  return textOf((payload as Record<string, unknown>)['accessToken'])
}

/**
 * Resolve one account's token. Precedence, and why, is in the file header. `readRecord` and `env`
 * are injected so the caller owns the seam and this stays a decision.
 */
export function resolveLinearToken(
  account: LinearAccountInput,
  deps: {
    readRecord: (key: string) => LinearCredentialRecord | undefined | Promise<LinearCredentialRecord | undefined>
    env: (name: string) => string | undefined
  },
): LinearTokenResult | Promise<LinearTokenResult> {
  const alias = textOf(account && account.alias)
  const authType = textOf(account && account.authType) || 'api_key'
  if (alias === '') {
    return { status: 'unconfigured', reason: 'invalid_alias', message: 'this account has no alias, so no credential can be looked up for it' }
  }

  const fallback = (why: string): LinearTokenResult => {
    const name = linearApiKeyEnvName(alias)
    const fromEnv = textOf(deps.env(name))
    if (fromEnv !== '') return { status: 'ok', token: fromEnv, source: 'env', authType: 'api_key' }
    return {
      status: 'needs_auth',
      reason: 'needs_auth',
      message: why + ' No credential record is stored for ' + linearCredentialKey(alias) + ' and ' + name + ' is not set on this machine.',
    }
  }

  let record: LinearCredentialRecord | undefined
  try {
    record = deps.readRecord(linearCredentialKey(alias)) as LinearCredentialRecord | undefined
  } catch (e) {
    return { status: 'unconfigured', reason: 'credential_store_unavailable', message: 'the credential store could not be read for ' + alias + ': ' + String((e as Error) && (e as Error).message).slice(0, 160) }
  }

  const pending = record && typeof (record as unknown as { then?: unknown }).then === 'function' ? (record as unknown as Promise<LinearCredentialRecord | undefined>) : null
  const decide = (current: LinearCredentialRecord | undefined): LinearTokenResult => {
    if (current) {
      const kind = textOf(current.kind)
      if (kind === 'grant') {
        const access = grantAccessToken(current)
        if (access !== '') return { status: 'ok', token: access, source: 'record', authType: authType === 'api_key' ? 'oauth_user' : authType }
        return fallback('This account signs in with OAuth, but the stored authorization carries no usable access token; sign in again.')
      }
      if (kind === 'api-key') {
        const key = textOf(current.key)
        if (key !== '') return { status: 'ok', token: key, source: 'record', authType: 'api_key' }
        // An api-key record with no key is the seam's way of stating "ambient authentication is
        // intended", so the environment fallback is exactly the right next step here.
        return fallback('This account has a stored credential record, but it carries no key.')
      }
      return { status: 'unconfigured', reason: 'unsupported_credential', message: 'the stored record for ' + alias + ' is of an unknown kind (' + (kind || 'no kind') + '); only api-key and grant are understood' }
    }
    return fallback('No credential is configured for this account.')
  }

  if (pending) {
    return pending.then((current) => decide(current))
  }
  return decide(record as LinearCredentialRecord | undefined)
}

/** One identity, as this module needs it: which organization the token answers for, and who holds it. */
export interface LinearIdentity {
  viewerId: string
  viewerName: string
  orgId: string
  urlKey: string
}

/**
 * Read the identity out of a GraphQL response body. Written as a function of `unknown` because the
 * body comes off the network: a malformed answer must read as "could not tell who this is", never as
 * a crash, and never as an organization id that happens to be undefined.
 */
export function parseLinearIdentity(body: unknown): { ok: true; identity: LinearIdentity } | { ok: false; reason: string; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'upstream_error', message: 'Linear answered with something that is not a GraphQL response' }
  const root = body as Record<string, unknown>
  const errors = root['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | undefined
    const detail = first && typeof first['message'] === 'string' ? String(first['message']) : 'no message'
    return { ok: false, reason: 'upstream_error', message: 'Linear refused the identity query: ' + detail.slice(0, 200) }
  }
  const data = root['data']
  if (!data || typeof data !== 'object') return { ok: false, reason: 'upstream_error', message: 'Linear answered without a data object' }
  const viewer = (data as Record<string, unknown>)['viewer']
  if (!viewer || typeof viewer !== 'object') return { ok: false, reason: 'needs_auth', message: 'Linear did not recognise this token as a viewer; it may be revoked or spent' }
  const v = viewer as Record<string, unknown>
  const organization = v['organization']
  const org = organization && typeof organization === 'object' ? (organization as Record<string, unknown>) : {}
  const orgId = textOf(org['id'])
  if (orgId === '') return { ok: false, reason: 'upstream_error', message: 'Linear answered without naming the organization this token belongs to, so it cannot be pinned' }
  return {
    ok: true,
    identity: {
      viewerId: textOf(v['id']),
      viewerName: textOf(v['displayName']) || textOf(v['name']),
      orgId,
      urlKey: textOf(org['urlKey']),
    },
  }
}

/**
 * The pinned-organization rule. An account that names an organization only accepts a token that
 * answers for that same one: a token pasted from another workspace would otherwise fill this account
 * with issues that belong elsewhere, which looks like success and is the worst kind of failure.
 */
export function checkLinearIdentity(account: LinearAccountInput, identity: LinearIdentity): { ok: true } | { ok: false; reason: 'identity_mismatch'; message: string } {
  const pinned = textOf(account && account.orgId)
  if (pinned === '' || pinned === identity.orgId) return { ok: true }
  return {
    ok: false,
    reason: 'identity_mismatch',
    message: 'this account pins Linear organization ' + pinned + ', but the credential answers for ' + identity.orgId + '; either fix the pinned organization or use a token from the right workspace',
  }
}

/** The defaults an account document leaves out, applied once so every caller sees the same fields. */
function accountFields(account: LinearAccountInput): { teams: string[]; reviewPattern: string; reviewScope: string } {
  const rawTeams: unknown[] = account && Array.isArray(account.teams) ? (account.teams as unknown[]) : []
  const teams = rawTeams.map((t) => textOf(t).toUpperCase()).filter((t) => t !== '')
  return {
    teams,
    reviewPattern: textOf(account && account.reviewPattern) || 'review|revisando|revisão|revisao|qa',
    reviewScope: textOf(account && account.reviewScope) || 'subscribed',
  }
}

/**
 * Resolve one account end to end: a token, then who it belongs to, then the pin check. `probe` is
 * injected because the wire belongs to the caller; when it is absent the account still resolves to
 * `ok` with whatever organization the document already pins, which is what a read that never needed
 * the network should cost.
 */
export async function resolveLinearAccount(
  account: LinearAccountInput,
  deps: {
    readRecord: (key: string) => LinearCredentialRecord | undefined | Promise<LinearCredentialRecord | undefined>
    env: (name: string) => string | undefined
    probe?: (authorization: string) => Promise<{ ok: true; body: unknown } | { ok: false; reason: string; message: string }>
  },
): Promise<LinearResolution> {
  const alias = textOf(account && account.alias)
  const authType = textOf(account && account.authType) || 'api_key'
  const fields = accountFields(account)
  const token = await resolveLinearToken(account, deps)
  if (token.status !== 'ok') {
    return { status: token.status, alias, authType, reason: token.reason, message: token.message }
  }
  const authorization = linearAuthorization(token.authType, token.token)
  const base: Omit<LinearResolved, 'orgId' | 'urlKey' | 'viewerName'> = {
    status: 'ok',
    alias,
    authType: token.authType,
    token: token.token,
    authorization,
    source: token.source,
    teams: fields.teams,
    reviewPattern: fields.reviewPattern,
    reviewScope: fields.reviewScope,
  }
  if (typeof deps.probe !== 'function') {
    return { ...base, orgId: textOf(account && account.orgId), urlKey: textOf(account && account.urlKey), viewerName: '' }
  }
  const answer = await deps.probe(authorization)
  if (answer.ok !== true) {
    return { status: 'error', alias, authType: token.authType, reason: answer.reason, message: answer.message }
  }
  const identity = parseLinearIdentity(answer.body)
  if (identity.ok !== true) {
    return { status: identity.reason === 'needs_auth' ? 'needs_auth' : 'error', alias, authType: token.authType, reason: identity.reason, message: identity.message }
  }
  const pin = checkLinearIdentity(account, identity.identity)
  if (pin.ok !== true) {
    return { status: 'identity_mismatch', alias, authType: token.authType, reason: pin.reason, message: pin.message }
  }
  return {
    ...base,
    orgId: identity.identity.orgId,
    urlKey: identity.identity.urlKey || textOf(account && account.urlKey),
    viewerName: identity.identity.viewerName,
  }
}
