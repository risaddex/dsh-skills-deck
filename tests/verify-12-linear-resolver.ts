// tests/verify-12-linear-resolver.ts — the Linear credential resolver (#12, map ticket)
// The interesting cases are the ones nobody reproduces by hand, so every one is pinned here with a
// stand-in credential store, a stand-in environment and a stand-in network:
//   R1  a stored credential record outranks the environment key.
//   R2  with no record, LINEAR_KEY_<ALIAS> is used, including the hyphen-to-underscore mapping.
//   R3  an api-key record carrying no key states "ambient auth", so the environment key is next.
//   R4  a grant record answers with its access token, sent with the Bearer scheme.
//   R5  a grant record with no access token reports needs_auth instead of sending nothing.
//   R6  a record of an unknown kind is refused as unsupported, not silently ignored.
//   R7  a context with no credentials service still resolves through the environment.
//   R8  the identity probe yields the organization to pin and the person behind the token.
//   R9  a token answering for another organization is an identity mismatch, not issues from elsewhere.
//   R10 HTTP 401 is needs_auth while a network failure is an error: they point a person differently.
//   R11 no token ever appears in a status, a reason or a message.
//   R12 with the probe off, an account keeps the organization its document pins.
//   R13 the registry override path is read from the one variable that names it.
//   R14 the account file reader follows an override path and reports a missing file as missing.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-12-linear-resolver.ts
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT: string = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}

const TOKEN = 'lin_api_' + 'test-token-value'
const OAUTH = 'oauth-' + 'token-value'

function ctxWith(record: any) {
  return { get: (name: string) => (name === 'credentials' ? { readRecord: async () => record } : null) }
}
function envOf(map: Record<string, string>) {
  return (name: string) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined)
}
function fetchAnswering(status: number, body: any) {
  return async () => ({ status, json: async () => body })
}
const identityBody = {
  data: { viewer: { id: 'u1', name: 'Danilo', displayName: 'Danilo R', email: 'd@example.com', organization: { id: 'org-1', name: 'Ombrello', urlKey: 'ombrello' } } },
}

async function main() {
  console.log('Linear credential resolver gate (#12)')
  const host = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'linearAccounts.js')).href)
  const { resolveLinearAccountWithHost, probeLinearIdentity, linearRegistryPath } = host

  // —— R1: record outranks the environment ——
  {
    const r = await resolveLinearAccountWithHost(
      ctxWith({ kind: 'api-key', key: TOKEN }),
      { alias: 'ombrello', authType: 'api_key' },
      { env: envOf({ LINEAR_KEY_OMBRELLO: 'from-env' }), probe: false },
    )
    check(r.status === 'ok' && r.token === TOKEN && r.source === 'record', 'R1 a stored record outranks the environment key', JSON.stringify(r))
  }

  // —— R2: environment fallback and the variable name ——
  {
    const r = await resolveLinearAccountWithHost(ctxWith(undefined), { alias: 'ombrello-two' }, { env: envOf({ LINEAR_KEY_OMBRELLO_TWO: 'from-env' }), probe: false })
    check(r.status === 'ok' && r.token === 'from-env' && r.source === 'env' && r.authType === 'api_key', 'R2 the environment key is used, hyphen alias mapped to underscores', JSON.stringify(r))
    const none = await resolveLinearAccountWithHost(ctxWith(undefined), { alias: 'ghost' }, { env: envOf({}), probe: false })
    check(none.status === 'needs_auth' && /LINEAR_KEY_GHOST/.test(none.message), 'R2 with nothing configured the account says needs_auth and names the variable', JSON.stringify(none))
  }

  // —— R3: an empty api-key record defers to the environment ——
  {
    const r = await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key' }), { alias: 'ombrello' }, { env: envOf({ LINEAR_KEY_OMBRELLO: 'from-env' }), probe: false })
    check(r.status === 'ok' && r.source === 'env', 'R3 an api-key record with no key defers to the environment', JSON.stringify(r))
  }

  // —— R4/R5/R6: the record kinds ——
  {
    const grant = await resolveLinearAccountWithHost(ctxWith({ kind: 'grant', payload: { accessToken: OAUTH } }), { alias: 'ombrello', authType: 'oauth_user' }, { env: envOf({}), probe: false })
    check(grant.status === 'ok' && grant.token === OAUTH && grant.authorization === 'Bearer ' + OAUTH && grant.source === 'record', 'R4 a grant answers with its access token and the Bearer scheme', JSON.stringify(grant))

    const empty = await resolveLinearAccountWithHost(ctxWith({ kind: 'grant', payload: {} }), { alias: 'ombrello', authType: 'oauth_user' }, { env: envOf({}), probe: false })
    check(empty.status === 'needs_auth' && /sign in again/.test(empty.message), 'R5 a grant with no access token reports needs_auth', JSON.stringify(empty))

    const odd = await resolveLinearAccountWithHost(ctxWith({ kind: 'cookie', payload: {} }), { alias: 'ombrello' }, { env: envOf({}), probe: false })
    check(odd.status === 'unconfigured' && odd.reason === 'unsupported_credential', 'R6 an unknown record kind is refused as unsupported', JSON.stringify(odd))
  }

  // —— R7: no credentials service at all ——
  {
    const r = await resolveLinearAccountWithHost({}, { alias: 'ombrello' }, { env: envOf({ LINEAR_KEY_OMBRELLO: 'from-env' }), probe: false })
    check(r.status === 'ok' && r.source === 'env', 'R7 a context without the credentials service still resolves through the environment', JSON.stringify(r))
  }

  // —— R8/R9/R12: the identity probe and the pin ——
  {
    const ok = await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello' }, { env: envOf({}), fetchImpl: fetchAnswering(200, identityBody) })
    check(ok.status === 'ok' && ok.orgId === 'org-1' && ok.urlKey === 'ombrello' && ok.viewerName === 'Danilo R', 'R8 the probe yields the organization to pin and the person behind the token', JSON.stringify(ok))

    const mismatch = await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello', orgId: 'org-OTHER' }, { env: envOf({}), fetchImpl: fetchAnswering(200, identityBody) })
    check(mismatch.status === 'identity_mismatch' && /org-OTHER/.test(mismatch.message) && /org-1/.test(mismatch.message), 'R9 a token answering for another organization is an identity mismatch', JSON.stringify(mismatch))

    const skipped = await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello', orgId: 'org-pinned' }, { env: envOf({}), probe: false })
    check(skipped.status === 'ok' && skipped.orgId === 'org-pinned', 'R12 with the probe off the pinned organization is kept', JSON.stringify(skipped))
  }

  // —— R10: how a failure is classified ——
  {
    const denied = await probeLinearIdentity('Bearer x', { fetchImpl: fetchAnswering(401, {}) })
    check(denied.ok === false && denied.reason === 'needs_auth', 'R10 a 401 is needs_auth', JSON.stringify(denied))

    const broken = await probeLinearIdentity('Bearer x', { fetchImpl: async () => { throw new Error('connect ECONNREFUSED') } })
    check(broken.ok === false && broken.reason === 'upstream_error' && /ECONNREFUSED/.test(broken.message), 'R10 a network failure is an upstream error, not a sign-in problem', JSON.stringify(broken))

    const graphQl = await probeLinearIdentity('Bearer x', { fetchImpl: fetchAnswering(200, { errors: [{ message: 'Authentication required' }] }) })
    check(graphQl.ok === true, 'R10 a GraphQL answer with errors still reaches the parser, which reports them', JSON.stringify(graphQl))
    const fromBody = await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello' }, { env: envOf({}), fetchImpl: fetchAnswering(200, { errors: [{ message: 'Authentication required' }] }) })
    check(fromBody.status === 'error' && /Authentication required/.test(fromBody.message), 'R10 a GraphQL errors array becomes an error naming the reason', JSON.stringify(fromBody))
  }

  // —— R11: no token in any message ——
  {
    const cases = [
      await resolveLinearAccountWithHost(ctxWith({ kind: 'grant', payload: {} }), { alias: 'ombrello', authType: 'oauth_user' }, { env: envOf({ LINEAR_KEY_OMBRELLO: '' }), probe: false }),
      await resolveLinearAccountWithHost(ctxWith(undefined), { alias: 'ghost' }, { env: envOf({}), probe: false }),
      await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello', orgId: 'org-OTHER' }, { env: envOf({}), fetchImpl: fetchAnswering(200, identityBody) }),
      await resolveLinearAccountWithHost(ctxWith({ kind: 'api-key', key: TOKEN }), { alias: 'ombrello' }, { env: envOf({}), fetchImpl: fetchAnswering(500, {}) }),
    ]
    const leaked = cases.filter((c: any) => JSON.stringify(c).indexOf(TOKEN) >= 0 || JSON.stringify(c).indexOf(OAUTH) >= 0)
    check(leaked.length === 0, 'R11 no failing result carries a token value', JSON.stringify(leaked))
  }


  // —— R14: the file reader honours the override and reports a missing file as missing ——
  {
    const seen: string[] = []
    const io = {
      readText: async (p: string) => { seen.push(p); return 'version: 1\naccounts:\n  - alias: alpha\n' },
      writeText: async () => undefined,
    }
    const read = await host.readLinearAccounts('/home/x', io, '/tmp/registry.yml')
    check(read.ok === true && seen[0] === '/tmp/registry.yml' && read.value.accounts[0].alias === 'alpha', 'R14 an override path is read instead of the default one', JSON.stringify({ read, seen }))
    const missingIo = { readText: async () => { const e: any = new Error('nope'); e.code = 'ENOENT'; throw e }, writeText: async () => undefined }
    const missing = await host.readLinearAccounts('/home/x', missingIo)
    check(missing.ok === false && missing.reason === 'missing', 'R14 a missing account file reads as missing, not as a failure', JSON.stringify(missing))
  }

  // —— R13: the registry override ——
  {
    check(linearRegistryPath(envOf({ DSH_DECK_LINEAR_REGISTRY: ' /tmp/accounts.yml ' })) === '/tmp/accounts.yml', 'R13 the override path is trimmed and returned', linearRegistryPath(envOf({ DSH_DECK_LINEAR_REGISTRY: ' /tmp/accounts.yml ' })))
    check(linearRegistryPath(envOf({})) === '', 'R13 with the variable unset there is no override', linearRegistryPath(envOf({})))
  }

  console.log('\n' + (total - (failed ? 1 : 0)) + '/' + total + ' checks passed' + (failed ? ' — SOME FAILED' : ' — OK'))
  process.exit(failed ? 1 : 0)
}

main().catch((e: unknown) => {
  console.error('gate crashed:', e)
  process.exit(1)
})