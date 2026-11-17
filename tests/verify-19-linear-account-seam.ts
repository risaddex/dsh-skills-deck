// tests/verify-19-linear-account-seam.ts — the host half of the account seam (#19, from the decision in #27)
//   A1  a successful resolution crosses as alias + authorization only: no token, no secret, no extra field.
//   A2  a field the resolver grows tomorrow does not cross (the result is built, not copied).
//   A3  every failure status the ADR names is kept; an unknown status becomes a plain error.
//   A4  a message that happens to contain the token or the header is scrubbed.
//   A5  a success with no header is reported as an error instead of handing over an empty header.
//   A6  endpoint is passed through only when given.
//   A7  the real resolver, with a stored grant, produces a result that crosses clean.
//   A8  the file imports nothing from the tracker rooms and no DSH service (it is a pure narrowing).
// Usage: node --import ./scripts/ts-hook.mts tests/verify-19-linear-account-seam.ts
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const ROOT: string = path.resolve(__dirname, '..')
let failed = false
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}

const TOKEN = 'tok_' + 'abcdef1234567890'
const SECRET = 'client-secret-' + 'VALUE-9999'
const resolved = (extra?: Record<string, unknown>) => ({
  status: 'ok', alias: 'ombrello', authType: 'oauth_app', token: TOKEN, authorization: 'Bearer ' + TOKEN, source: 'record',
  orgId: 'org-1', urlKey: 'ombrello', viewerName: 'dsh', teams: ['OMB'], reviewPattern: 'review', reviewScope: 'subscribed', ...(extra || {}),
})

async function main() {
  console.log('Linear account seam gate (#19 / #27)')
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'linearAccountSeam.js')).href)
  const { toAccountResolution } = mod

  {
    const r = toAccountResolution(resolved())
    check(r.ok === true && r.alias === 'ombrello' && r.authorization === 'Bearer ' + TOKEN, 'A1 success carries alias and the ready header', JSON.stringify(r))
    check(Object.keys(r).sort().join(',') === 'alias,authorization,ok', 'A1 and nothing else: ' + Object.keys(r).sort().join(','), Object.keys(r))
    check(JSON.stringify(r).indexOf('"token"') < 0 && !('token' in r), 'A1 no token field')
    check(!('orgId' in r) && !('teams' in r) && !('authType' in r) && !('source' in r), 'A1 no resolver metadata crosses (it arrives later as an added payload field)')
  }

  {
    const r = toAccountResolution(resolved({ clientSecret: SECRET, refreshToken: 'rt_' + 'zzzzzzzz1234', rawPayload: { accessToken: TOKEN }, futureField: 'x' }))
    const text = JSON.stringify(r)
    check(text.indexOf(SECRET) < 0 && text.indexOf('rt_zzzzzzzz1234') < 0 && text.indexOf('futureField') < 0, 'A2 a new resolver field does not cross', text)
    check(text.indexOf(TOKEN) === text.lastIndexOf(TOKEN) && text.split(TOKEN).length - 1 === 1, 'A2 the token appears only inside the header, once', text)
  }

  {
    for (const status of ['needs_auth', 'identity_mismatch', 'error', 'unconfigured']) {
      const r = toAccountResolution({ status, alias: 'x', authType: 'oauth_app', reason: status, message: 'because ' + status })
      check(r.ok === false && r.status === status && r.message === 'because ' + status, 'A3 ' + status + ' is kept', JSON.stringify(r))
    }
    const odd = toAccountResolution({ status: 'rate_limited', alias: 'x', authType: 'oauth_app', reason: 'r', message: 'slow down' })
    check(odd.ok === false && odd.status === 'error', 'A3 an unknown status becomes a plain error', JSON.stringify(odd))
    const none = toAccountResolution(undefined as never)
    check(none.ok === false && none.status === 'error', 'A3 a missing resolution is an error, not a crash', JSON.stringify(none))
  }

  {
    const r = toAccountResolution({ status: 'error', alias: 'x', authType: 'oauth_app', reason: 'upstream_error', message: 'Linear refused ' + TOKEN + ' and the header Bearer ' + TOKEN, token: TOKEN, authorization: 'Bearer ' + TOKEN } as never)
    check(r.ok === false && r.message.indexOf(TOKEN) < 0, 'A4 a token inside a failure message is scrubbed', JSON.stringify(r))
    const clean = toAccountResolution({ status: 'needs_auth', alias: 'x', authType: 'oauth_app', reason: 'needs_auth', message: 'sign in again' })
    check(clean.ok === false && clean.message === 'sign in again', 'A4 a clean message is left alone', JSON.stringify(clean))
  }

  {
    const a = toAccountResolution(resolved({ authorization: '' }))
    check(a.ok === false && a.status === 'error', 'A5 no header is an error, not an empty header', JSON.stringify(a))
    const b = toAccountResolution(resolved({ alias: '' }))
    check(b.ok === false && b.status === 'error', 'A5 no alias is an error', JSON.stringify(b))
  }

  {
    const none = toAccountResolution(resolved())
    const given = toAccountResolution(resolved(), { endpoint: 'https://api.linear.app/graphql' })
    const blank = toAccountResolution(resolved(), { endpoint: '' })
    check(!('endpoint' in none) && (given as { endpoint?: string }).endpoint === 'https://api.linear.app/graphql' && !('endpoint' in blank), 'A6 endpoint only when given', JSON.stringify([none, given, blank]))
  }

  {
    const host = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'linearAccounts.js')).href)
    const ctx = { get: (n: string) => (n === 'credentials' ? { readRecord: async () => ({ kind: 'grant', payload: { accessToken: TOKEN } }) } : null) }
    const raw = await host.resolveLinearAccountWithHost(ctx, { alias: 'ombrello', authType: 'oauth_app' }, { env: () => undefined, probe: false })
    check(raw.status === 'ok' && raw.token === TOKEN, 'A7 the real resolver does carry the token (so the narrowing is needed)', JSON.stringify(Object.keys(raw)))
    const seam = toAccountResolution(raw)
    check(seam.ok === true && !('token' in seam) && seam.authorization === 'Bearer ' + TOKEN, 'A7 after the seam it crosses clean', JSON.stringify(seam))
    const missing = await host.resolveLinearAccountWithHost({ get: () => null }, { alias: 'nobody', authType: 'oauth_app' }, { env: () => undefined, probe: false })
    const seam2 = toAccountResolution(missing)
    check(seam2.ok === false && seam2.status === 'needs_auth', 'A7 no record becomes needs_auth', JSON.stringify(seam2))
  }

  {
    const text: string = fs.readFileSync(path.join(ROOT, 'src', 'host', 'linearAccountSeam.ts'), 'utf8')
    const imports = text.split('\n').filter((l: string) => /^import /.test(l))
    check(imports.every((l: string) => /^import type /.test(l) && /shared\/linear-accounts/.test(l)), 'A8 only a type import from the shared resolver', imports.join(' | '))
    check(!/tracker\/rooms|ctx\.get\(|fetch\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), 'A8 no room import, no DSH service, no network in the code')
  }

  if (failed) { console.log('\nFAILED'); process.exit(1) }
  console.log('\nOK')
}
main().catch((e) => { console.error(e); process.exit(1) })
