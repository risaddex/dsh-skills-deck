// tests/verify-19-linear-signin.ts — the host half of Linear sign-in (#19, map ticket), fully offline
//   S1  oauth_app: prompts for id and secret, posts client_credentials, commits a grant that keeps the secret.
//   S2  oauth_app: an app without client credentials enabled fails with a sentence that says what to switch on.
//   S3  oauth_user: PKCE flow via the loopback listener; the verifier sent matches the challenge in the URL.
//   S4  oauth_user: paste fallback when no listener is available; a callback from another attempt is refused.
//   S5  renewal is single-flight: two callers on a stale token cause exactly one token request.
//   S6  the rotated grant is persisted BEFORE the shared promise resolves, and a failed write fails the renewal.
//   S7  a token outside the renewal window is returned with no network call; force renews it.
//   S8  sign-out revokes at Linear and removes the record even when Linear is unreachable.
//   S9  flows are registered per account on the seam, keyed by the record the resolver reads; no seam is not an error.
//   S10 no secret reaches a notice or an error message.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-19-linear-signin.ts
const path = require('path')
const { pathToFileURL } = require('url')
const ROOT: string = path.resolve(__dirname, '..')
let failed = false
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}

const SECRET = 'client-secret-' + 'VALUE'
const sha = async (text: string) => new Uint8Array(require('crypto').createHash('sha256').update(text).digest())
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function storeWith(initial: any, opts?: { failWrite?: boolean }) {
  const rec: Record<string, any> = {}
  if (initial) rec['skills-deck/linear-ombrello'] = initial
  const log: string[] = []
  return {
    rec, log,
    readRecord: async (k: string) => rec[k],
    modifyRecord: async (k: string, mutate: (c: any) => Promise<any>) => {
      log.push('write:start')
      if (opts && opts.failWrite) throw new Error('disk full')
      const next = await mutate(rec[k]); if (next !== undefined) rec[k] = next
      log.push('write:done'); return rec[k]
    },
    deleteRecord: async (k: string) => { delete rec[k]; log.push('delete') },
  }
}
function fakeFetch(handler: (url: string, body: string) => { status: number; body: any } | Promise<{ status: number; body: any }>) {
  const calls: Array<{ url: string; body: string }> = []
  const fn = async (url: string, init: any) => {
    calls.push({ url, body: String(init.body) })
    const r = await handler(url, String(init.body))
    return { status: r.status, json: async () => r.body }
  }
  return { fn, calls }
}
function sessionOf(method: string, answers: string[]) {
  const notices: any[] = []; const committed: any[] = []
  const ac = new AbortController()
  return {
    notices, committed,
    session: {
      method, signal: ac.signal,
      commit: async (r: any) => { committed.push(r) },
      notify: (n: any) => { notices.push(n) },
      prompt: async (_p: any) => { const a = answers.shift(); if (a === undefined) throw new Error('unexpected prompt'); return a },
    },
  }
}

async function main() {
  console.log('Linear sign-in host gate (#19)')
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'linearSignin.js')).href)
  const { buildLinearFlow, ensureFreshGrant, signOut, registerLinearFlows } = mod
  const NOW = 1_000_000

  {
    const ff = fakeFetch(() => ({ status: 200, body: { access_token: 'AT', expires_in: 2592000, scope: 'read write' } }))
    const s = sessionOf('oauth_app', ['cid', SECRET])
    const flow = buildLinearFlow({ alias: 'ombrello', authType: 'oauth_app' }, { fetchImpl: ff.fn, now: () => NOW })
    await flow.run(s.session)
    const rec = s.committed[0]
    check(flow.key === 'skills-deck/linear-ombrello', 'S1 the flow is keyed by the record the resolver reads', flow.key)
    check(ff.calls.length === 1 && /grant_type=client_credentials/.test(ff.calls[0].body) && /scope=read%2Cwrite/.test(ff.calls[0].body), 'S1 one client_credentials POST with the fixed scope', ff.calls[0]?.body)
    check(rec && rec.kind === 'grant' && rec.payload.accessToken === 'AT' && rec.payload.clientSecret === SECRET && rec.payload.mode === 'oauth_app', 'S1 the grant keeps the secret so the next token can be requested', JSON.stringify(rec))
    check(rec.payload.expiresAt === NOW + 2592000000, 'S1 expiry is computed from expires_in', rec.payload.expiresAt)
  }

  {
    const ff = fakeFetch(() => ({ status: 400, body: { error: 'invalid_request', error_description: 'Client does not support the client_credentials grant type' } }))
    const s = sessionOf('oauth_app', ['cid', SECRET])
    const flow = buildLinearFlow({ alias: 'ombrello', authType: 'oauth_app' }, { fetchImpl: ff.fn, now: () => NOW })
    let msg = ''
    try { await flow.run(s.session) } catch (e: any) { msg = String(e.message) }
    check(/client credentials/i.test(msg) && s.committed.length === 0, 'S2 disabled client credentials is explained and nothing is committed', msg)
    check(msg.indexOf(SECRET) < 0, 'S10 the secret is not in the error', msg)
  }

  {
    let captured = ''
    const ff = fakeFetch((_u, body) => { captured = body; return { status: 200, body: { access_token: 'UAT', refresh_token: 'URT', expires_in: 86399 } } })
    const listen = async () => ({ url: 'x', wait: Promise.resolve(''), close: () => {} })
    const state: { url?: string } = {}
    const s = sessionOf('oauth_user', ['cid', ''])
    const origNotify = s.session.notify
    s.session.notify = (n: any) => { if (n.url) state.url = n.url; origNotify(n) }
    const l2 = async (_port: number) => ({ url: 'x', close: () => {}, wait: new Promise<string>((resolve) => setTimeout(() => {
      const u = new URL(state.url as string); resolve('http://127.0.0.1:48719/callback?code=thecode&state=' + u.searchParams.get('state'))
    }, 5)) })
    const flow = buildLinearFlow({ alias: 'ombrello', authType: 'oauth_user' }, { fetchImpl: ff.fn, now: () => NOW, listen: l2 as any, sha256: sha })
    await flow.run(s.session)
    const authUrl = new URL(state.url as string)
    const verifier = new URLSearchParams(captured).get('code_verifier') as string
    check(authUrl.searchParams.get('code_challenge') === b64url(await sha(verifier)), 'S3 the verifier sent matches the challenge in the authorize URL')
    check(authUrl.searchParams.get('redirect_uri') === 'http://127.0.0.1:48719/callback', 'S3 the redirect URI uses the plugin-owned port', authUrl.href)
    check(s.committed[0] && s.committed[0].payload.refreshToken === 'URT' && s.committed[0].payload.mode === 'oauth_user', 'S3 a user grant keeps its refresh token', JSON.stringify(s.committed[0]))
    void listen
  }

  {
    const ff = fakeFetch(() => ({ status: 200, body: { access_token: 'UAT', refresh_token: 'URT', expires_in: 86399 } }))
    const s = sessionOf('oauth_user', ['cid', '', 'code=pasted&state=WRONG'])
    const flow = buildLinearFlow({ alias: 'ombrello', authType: 'oauth_user' }, { fetchImpl: ff.fn, now: () => NOW, sha256: sha })
    let msg = ''
    try { await flow.run(s.session) } catch (e: any) { msg = String(e.message) }
    check(/different sign-in attempt/.test(msg) && ff.calls.length === 0, 'S4 a callback from another attempt is refused before any token request', msg)
    const s2 = sessionOf('oauth_user', ['cid', '', 'barecode'])
    await buildLinearFlow({ alias: 'ombrello', authType: 'oauth_user' }, { fetchImpl: ff.fn, now: () => NOW, sha256: sha }).run(s2.session)
    check(s2.committed.length === 1 && /paste/i.test(s2.notices[0].message), 'S4 paste mode works and says so', JSON.stringify(s2.notices))
  }

  {
    const stale = { kind: 'grant', payload: { mode: 'oauth_user', alias: 'ombrello', clientId: 'cid', accessToken: 'OLD', refreshToken: 'RT1', expiresAt: NOW + 1000, scope: ['read', 'write'], obtainedAt: 0 } }
    const store = storeWith(stale)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const ff = fakeFetch(async () => { await gate; return { status: 200, body: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 86399 } } })
    const a = ensureFreshGrant(store, 'ombrello', undefined, { fetchImpl: ff.fn, now: () => NOW })
    const b = ensureFreshGrant(store, 'ombrello', undefined, { fetchImpl: ff.fn, now: () => NOW })
    await new Promise((r) => setTimeout(r, 5)); release()
    const [ra, rb] = await Promise.all([a, b])
    check(ff.calls.length === 1, 'S5 two callers on a stale token make exactly one request', ff.calls.length)
    check(ra.ok && rb.ok && ra.accessToken === 'NEW' && rb.accessToken === 'NEW', 'S5 both callers get the renewed token', JSON.stringify([ra, rb]))
    check(store.rec['skills-deck/linear-ombrello'].payload.refreshToken === 'RT2', 'S6 the rotated refresh token is the one stored', JSON.stringify(store.rec))
    check(store.log.join(',') === 'write:start,write:done', 'S6 the record was written exactly once, before resolving', store.log.join(','))
  }

  {
    const stale = { kind: 'grant', payload: { mode: 'oauth_user', alias: 'ombrello', clientId: 'cid', accessToken: 'OLD', refreshToken: 'RT1', expiresAt: NOW + 1000, scope: [], obtainedAt: 0 } }
    const store = storeWith(stale, { failWrite: true })
    const ff = fakeFetch(() => ({ status: 200, body: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 86399 } }))
    const r = await ensureFreshGrant(store, 'ombrello', undefined, { fetchImpl: ff.fn, now: () => NOW })
    check(r.ok === false && r.reason === 'credential_store_unavailable', 'S6 a failed write fails the renewal instead of handing out an unsaved token', JSON.stringify(r))
  }

  {
    const fresh = { kind: 'grant', payload: { mode: 'oauth_app', alias: 'ombrello', clientId: 'cid', clientSecret: SECRET, accessToken: 'FRESH', expiresAt: NOW + 10 * 24 * 3600 * 1000, scope: [], obtainedAt: 0 } }
    const ff = fakeFetch(() => ({ status: 200, body: { access_token: 'FORCED', expires_in: 2592000 } }))
    const store = storeWith(fresh)
    const r1 = await ensureFreshGrant(store, 'ombrello', undefined, { fetchImpl: ff.fn, now: () => NOW })
    check(r1.ok && r1.accessToken === 'FRESH' && ff.calls.length === 0, 'S7 a token outside the window costs no network call', JSON.stringify(r1))
    const r2 = await ensureFreshGrant(store, 'ombrello', { force: true }, { fetchImpl: ff.fn, now: () => NOW })
    check(r2.ok && r2.accessToken === 'FORCED' && /client_credentials/.test(ff.calls[0].body), 'S7 force renews, and an app grant asks again with its stored secret', JSON.stringify(r2))
  }

  {
    const grant = { kind: 'grant', payload: { mode: 'oauth_user', alias: 'ombrello', clientId: 'cid', accessToken: 'A', refreshToken: 'R', expiresAt: 0, scope: [], obtainedAt: 0 } }
    const down = async () => { throw new Error('network down') }
    const s1 = storeWith(grant)
    const out = await signOut(s1, 'ombrello', { fetchImpl: down })
    check(out.revoked === false && s1.rec['skills-deck/linear-ombrello'] === undefined, 'S8 the record is removed even when Linear is unreachable', JSON.stringify(out))
    const s2 = storeWith(grant)
    const ff = fakeFetch(() => ({ status: 200, body: {} }))
    const out2 = await signOut(s2, 'ombrello', { fetchImpl: ff.fn })
    check(out2.revoked === true && /token=R/.test(ff.calls[0].body) && /refresh_token/.test(ff.calls[0].body), 'S8 revoke sends the refresh token with its hint', ff.calls[0]?.body)
  }

  {
    const registered: any[] = []
    const ctx = { get: (n: string) => (n === 'authorization' ? { registerFlow: (f: any) => { registered.push(f); return () => {} } } : null) }
    registerLinearFlows(ctx, [{ alias: 'ombrello', authType: 'oauth_app' }, { alias: 'work', authType: 'api_key' }, { alias: 'two', authType: 'oauth_user' }])
    check(registered.map((f) => f.key).join(',') === 'skills-deck/linear-ombrello,skills-deck/linear-two', 'S9 one flow per OAuth account, none for api_key', registered.map((f) => f.key).join(','))
    const dispose = registerLinearFlows({ get: () => null }, [{ alias: 'ombrello', authType: 'oauth_app' }])
    check(typeof dispose === 'function', 'S9 no authorization seam is not an error')
  }

  {
    const ff = fakeFetch(() => ({ status: 200, body: { access_token: 'AT', expires_in: 100 } }))
    const s = sessionOf('oauth_app', ['cid', SECRET])
    await buildLinearFlow({ alias: 'ombrello', authType: 'oauth_app' }, { fetchImpl: ff.fn, now: () => NOW }).run(s.session)
    check(JSON.stringify(s.notices).indexOf(SECRET) < 0 && JSON.stringify(s.notices).indexOf('AT') < 0, 'S10 notices carry neither the secret nor the token', JSON.stringify(s.notices))
  }

  if (failed) { console.log('\nFAILED'); process.exit(1) }
  console.log('\nOK')
}
main().catch((e) => { console.error(e); process.exit(1) })
