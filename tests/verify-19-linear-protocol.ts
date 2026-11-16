// tests/verify-19-linear-protocol.ts — the pure wire shapes of Linear sign-in (#19, map ticket)
//   P1  the authorize URL carries PKCE S256, prompt=consent and the fixed scope read,write.
//   P2  the callback parser accepts a full URL, a query string and a bare code, and reports a provider error.
//   P3  the code exchange body carries the verifier, and leaves the secret out when there is none.
//   P4  the client-credentials body carries the fixed scope and both halves of the client.
//   P5  a token answer is read; 200 without an access token is a bad response, not a silent empty token.
//   P6  an app without client credentials enabled is named as such, so a person knows what to switch on.
//   P7  a rotation that returns no refresh token keeps the one already held.
//   P8  the renewal window: inside it renews, outside does not, and no expiry is never renewed on the clock.
//   P9  no secret value appears in any error message these functions build.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-19-linear-protocol.ts
const path = require('path')
const { pathToFileURL } = require('url')
const ROOT: string = path.resolve(__dirname, '..')
let failed = false
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}

async function main() {
  console.log('Linear sign-in protocol gate (#19)')
  const p = await import(pathToFileURL(path.join(ROOT, 'src', 'shared', 'linear-signin', 'src', 'protocol.js')).href)

  {
    const url = new URL(p.buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:4801/callback', state: 'st', codeChallenge: 'ch' }))
    const q = url.searchParams
    check(url.origin + url.pathname === 'https://linear.app/oauth/authorize', 'P1 authorize endpoint', url.href)
    check(q.get('code_challenge_method') === 'S256' && q.get('code_challenge') === 'ch', 'P1 PKCE S256 challenge', url.href)
    check(q.get('prompt') === 'consent' && q.get('scope') === 'read,write' && q.get('actor') === 'user', 'P1 prompt=consent, scope read,write, actor user', url.href)
    check(q.get('redirect_uri') === 'http://127.0.0.1:4801/callback' && q.get('state') === 'st', 'P1 redirect uri and state survive encoding', url.href)
  }

  {
    const full = p.parseCallback('http://127.0.0.1:4801/callback?code=abc%2B1&state=xyz')
    check(full.ok && full.code === 'abc+1' && full.state === 'xyz', 'P2 full URL', JSON.stringify(full))
    const query = p.parseCallback('code=abc&state=xyz')
    check(query.ok && query.code === 'abc' && query.state === 'xyz', 'P2 query string', JSON.stringify(query))
    const bare = p.parseCallback('  abc123  ')
    check(bare.ok && bare.code === 'abc123' && bare.state === '', 'P2 bare code has an empty state', JSON.stringify(bare))
    const denied = p.parseCallback('http://127.0.0.1:4801/callback?error=access_denied&state=xyz')
    check(!denied.ok && /access_denied/.test(denied.reason), 'P2 provider error is reported', JSON.stringify(denied))
    check(!p.parseCallback('   ').ok, 'P2 empty input is refused')
  }

  {
    const withSecret = p.codeExchangeBody({ code: 'c', redirectUri: 'http://127.0.0.1:1/callback', clientId: 'cid', clientSecret: 's3', codeVerifier: 'ver' })
    const without = p.codeExchangeBody({ code: 'c', redirectUri: 'http://127.0.0.1:1/callback', clientId: 'cid', codeVerifier: 'ver' })
    check(/grant_type=authorization_code/.test(withSecret) && /code_verifier=ver/.test(withSecret) && /client_secret=s3/.test(withSecret), 'P3 exchange body with secret', withSecret)
    check(!/client_secret/.test(without) && /code_verifier=ver/.test(without), 'P3 PKCE exchange omits an absent secret', without)
  }

  {
    const body = p.clientCredentialsBody({ clientId: 'cid', clientSecret: 's3' })
    check(body === 'grant_type=client_credentials&client_id=cid&client_secret=s3&scope=read%2Cwrite', 'P4 client-credentials body', body)
  }

  {
    const ok = p.parseTokenResponse(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 86399, scope: 'read write' })
    check(ok.ok && ok.accessToken === 'AT' && ok.refreshToken === 'RT' && ok.expiresInMs === 86399000 && ok.scope.join(',') === 'read,write', 'P5 token answer is read', JSON.stringify(ok))
    const none = p.parseTokenResponse(200, { token_type: 'Bearer' })
    check(!none.ok && none.reason === 'oauth_bad_response', 'P5 200 without an access token is a bad response', JSON.stringify(none))
    const noExpiry = p.parseTokenResponse(200, { access_token: 'AT' })
    check(noExpiry.ok && noExpiry.expiresInMs === 0, 'P5 no expires_in reads as 0, not NaN', JSON.stringify(noExpiry))
    const http = p.parseTokenResponse(500, {})
    check(!http.ok && http.reason === 'oauth_http_error' && /500/.test(http.message), 'P5 non-2xx is an http error with the status', JSON.stringify(http))
  }

  {
    const off = p.parseTokenResponse(400, { error: 'invalid_request', error_description: 'Client does not support the client_credentials grant type' })
    check(!off.ok && off.reason === 'client_credentials_disabled' && /client credentials/i.test(off.message), 'P6 disabled client credentials is named', JSON.stringify(off))
    const badClient = p.parseTokenResponse(401, { error: 'invalid_client' })
    check(!badClient.ok && badClient.reason === 'invalid_client', 'P6 invalid_client is told apart', JSON.stringify(badClient))
  }

  {
    const kept = p.grantPayload({ mode: 'oauth_user', alias: 'ombrello', clientId: 'cid', parsed: { accessToken: 'AT2', refreshToken: '', expiresInMs: 1000, scope: [] }, now: 5000, previous: { refreshToken: 'RT1', orgId: 'org-1' } })
    check(kept.refreshToken === 'RT1' && kept.orgId === 'org-1' && kept.expiresAt === 6000, 'P7 a rotation without a refresh token keeps the held one', JSON.stringify(kept))
    const rotated = p.grantPayload({ mode: 'oauth_user', alias: 'o', clientId: 'cid', parsed: { accessToken: 'AT3', refreshToken: 'RT2', expiresInMs: 0, scope: ['read'] }, now: 1, previous: { refreshToken: 'RT1' } })
    check(rotated.refreshToken === 'RT2' && rotated.expiresAt === 0, 'P7 a new refresh token replaces the old; no expiry stays 0', JSON.stringify(rotated))
    const app = p.grantPayload({ mode: 'oauth_app', alias: 'o', clientId: 'cid', clientSecret: 's3', parsed: { accessToken: 'AT4', refreshToken: '', expiresInMs: 2592000000, scope: [] }, now: 0 })
    check(app.clientSecret === 's3' && app.refreshToken === undefined && app.scope.join(',') === 'read,write', 'P7 oauth_app keeps its secret, has no refresh token', JSON.stringify(app))
    check(JSON.stringify(JSON.parse(JSON.stringify(app))) === JSON.stringify(app), 'P7 the payload survives a JSON round trip')
  }

  {
    const now = 1000000
    check(p.needsRenewal({ expiresAt: now + 60000 }, now) === true, 'P8 inside the window renews')
    check(p.needsRenewal({ expiresAt: now + 3600000 }, now) === false, 'P8 outside the window does not')
    check(p.needsRenewal({ expiresAt: now - 1 }, now) === true, 'P8 already expired renews')
    check(p.needsRenewal({ expiresAt: 0 }, now) === false && p.needsRenewal(null, now) === false, 'P8 no expiry is never renewed on the clock')
  }

  {
    const SECRET = 'sekret-' + 'value-xyz'
    const msgs = [
      p.parseTokenResponse(401, { error: 'invalid_client', error_description: SECRET }),
      p.parseTokenResponse(400, { error: SECRET }),
      p.parseTokenResponse(200, { error: SECRET }),
    ].map((r: any) => (r.ok ? '' : r.message))
    check(msgs.every((m: string) => m.indexOf(SECRET) < 0), 'P9 no secret leaks into an error message', msgs.join(' | '))
  }

  if (failed) { console.log('\nFAILED'); process.exit(1) }
  console.log('\nOK')
}
main().catch((e) => { console.error(e); process.exit(1) })
