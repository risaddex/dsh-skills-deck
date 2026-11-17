/**
 * src/host/linearAccounts.ts — the host half of the Linear account layer (map ticket #12).
 *
 * The decision of which token to use, and whether it is the right one, lives in
 * src/shared/linear-accounts/src/resolve.ts and is a pure function of its inputs. This file supplies
 * the three inputs it asks for, and nothing else:
 *
 *   - the credential record, read through the DSH credential seam (`ctx.get('credentials')`). The
 *     plugin never stores a token itself and never writes one here: writing belongs to the sign-in
 *     flows (ticket #19), which go through `modifyRecord` so two processes cannot lose a rotation.
 *   - the environment, for the `LINEAR_KEY_<ALIAS>` convention carried over from the plugin this
 *     fork replaces.
 *   - the network, for the identity probe. Node's built-in `fetch` is the transport the harness
 *     already routes through its proxy policy, so no HTTP dependency is added to the package; the
 *     implementation is injectable so the gate can run without a network.
 *
 * No token ever appears in a log line, a status or a message from this file.
 */

import { LINEAR_GRAPHQL_ENDPOINT, LINEAR_IDENTITY_QUERY, resolveLinearAccount, parseLinearIdentity, checkLinearIdentity } from '../shared/linear-accounts/src/resolve.js'
import { parseConfig, stringifyConfig, needIo, isMissingFile, envFail } from './configStore.js'
import { LINEAR_ACCOUNTS_REL_SEGMENTS } from '../shared/config-store/src/linear-accounts.js'
// 时间参数只有一处真源：config/timeouts.yaml 的 linearProbeMs，由构建期生成的 values.ts 带进来。
import { LINEAR_PROBE_TIMEOUT_MS } from '../shared/time-config/src/values.js'
import type { LinearAccountInput, LinearResolution, LinearCredentialRecord } from '../shared/linear-accounts/src/resolve.js'
import type { AccountSeam, AccountSeamResult } from '../tracker/contract/accounts.js'

/** Read the accounts file from this path instead of the default one (CI, tests, an administrator with one shared file). */
export const LINEAR_ACCOUNTS_REGISTRY_ENV = 'DSH_DECK_LINEAR_REGISTRY'


/** The registry override as a path, or '' when the variable is unset or empty. Kept in one place because the host is the only side that may read the environment. */
export function linearRegistryPath(env: (name: string) => string | undefined): string {
  const raw = env(LINEAR_ACCOUNTS_REGISTRY_ENV)
  return typeof raw === 'string' ? raw.trim() : ''
}

/** What a probe answers: the parsed body, or why there is none. Never the token, never a header. */
export type LinearProbeResult = { ok: true; body: unknown } | { ok: false; reason: string; message: string }

/**
 * Ask Linear who the token belongs to. The status code is read before the body: a `401` means the
 * token is spent or revoked, while any other failure is an upstream or network problem, and telling a
 * person to sign in again after a network blip sends them in the wrong direction.
 */
export async function probeLinearIdentity(
  authorization: string,
  opts?: { fetchImpl?: any; endpoint?: string; timeoutMs?: number },
): Promise<LinearProbeResult> {
  const fetchImpl = (opts && opts.fetchImpl) || (globalThis as unknown as { fetch?: any }).fetch
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'upstream_error', message: 'this runtime has no fetch implementation, so Linear cannot be reached' }
  const endpoint = String((opts && opts.endpoint) || LINEAR_GRAPHQL_ENDPOINT)
  const rawTimeout = opts && typeof opts.timeoutMs === 'number' ? opts.timeoutMs : LINEAR_PROBE_TIMEOUT_MS
  const timeoutMs = rawTimeout
  let timer: any = null
  let signal: any = undefined
  const Controller = (globalThis as unknown as { AbortController?: any }).AbortController
  if (typeof Controller === 'function') {
    const controller = new Controller()
    signal = controller.signal
    timer = setTimeout(function () { try { controller.abort() } catch (e) { /* already settled */ } }, timeoutMs)
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ query: LINEAR_IDENTITY_QUERY }),
      signal,
    })
    const status = typeof response?.status === 'number' ? response.status : 0
    if (status === 401 || status === 403) {
      return { ok: false, reason: 'needs_auth', message: 'Linear rejected this token (HTTP ' + status + '); it was revoked, spent, or belongs to another environment' }
    }
    if (status === 429) {
      return { ok: false, reason: 'rate_limited', message: 'Linear is rate-limiting this account right now; try again in a minute' }
    }
    if (status < 200 || status >= 300) {
      return { ok: false, reason: 'upstream_error', message: 'Linear answered HTTP ' + (status || 'without a status') + ' to the identity query' }
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch (e) {
      return { ok: false, reason: 'upstream_error', message: 'Linear answered with a body that is not JSON' }
    }
    return { ok: true, body }
  } catch (e) {
    const msg = String((e && (e as Error).message) || e)
    if (/abort/i.test(msg)) return { ok: false, reason: 'timeout', message: 'Linear did not answer within ' + timeoutMs + ' ms, so the identity check was abandoned' }
    return { ok: false, reason: 'upstream_error', message: 'the identity query could not be sent: ' + msg.slice(0, 160) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The dependencies this file can take from a live context, each optional so a gate can pass stand-ins. */
export interface LinearHostDeps {
  env?: (name: string) => string | undefined
  fetchImpl?: any
  endpoint?: string
  timeoutMs?: number
  /** When false the identity probe is skipped and the account keeps whatever organization its document pins. */
  probe?: boolean
}

/**
 * Resolve one account against a live host context: the credential seam through `ctx.get`, the
 * environment through `process.env` by default, and the probe through fetch. A missing credentials
 * service is not an error of this call: the account then falls back to its environment key, exactly
 * as it would on a machine where nothing was stored.
 */
export async function resolveLinearAccountWithHost(ctx: any, account: LinearAccountInput, deps?: LinearHostDeps): Promise<LinearResolution> {
  const options: LinearHostDeps = deps || {}
  const env: (name: string) => string | undefined = options.env || function (name: string) {
    const value = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
    return typeof value === 'string' ? value : undefined
  }
  let credentials: any = null
  try {
    credentials = ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : null
  } catch (e) {
    credentials = null
  }
  const readRecord = function (key: string): LinearCredentialRecord | undefined | Promise<LinearCredentialRecord | undefined> {
    if (!credentials || typeof credentials.readRecord !== 'function') return undefined
    return credentials.readRecord(key)
  }
  const probe = options.probe === false
    ? undefined
    : function (authorization: string) { return probeLinearIdentity(authorization, { fetchImpl: options.fetchImpl, endpoint: options.endpoint, timeoutMs: options.timeoutMs }) }
  return resolveLinearAccount(account, { readRecord, env, probe })
}
// ── the account file itself ──

/** 用户主目录 → Linear 账号文件的绝对路径（#12）。 */
function accountsPath(homeDir: any): string {
  return String(homeDir || '').replace(/[\\/]+$/, '') + '/' + LINEAR_ACCOUNTS_REL_SEGMENTS.join('/')
}

/**
 * Read the Linear account document (#12). `overridePath` wins when given, which is how
 * `DSH_DECK_LINEAR_REGISTRY` (read through `linearRegistryPath`) points several machines at one file.
 * A missing file is `missing`, not an error: a machine that has never configured Linear should look
 * exactly like this.
 *
 * It lives here rather than in the config-store adapter because that adapter is at the repository's
 * file-size ceiling, and because this file is the only caller.
 */
export async function readLinearAccounts(homeDir: any, io: any, overridePath?: any): Promise<any> {
  needIo(io)
  const given: string = typeof overridePath === 'string' ? overridePath.trim() : ''
  const abs: any = given !== '' ? given : accountsPath(homeDir)
  const rel: any = given !== '' ? given : LINEAR_ACCOUNTS_REL_SEGMENTS.join('/')
  let text: string | null = null
  try {
    text = await io.readText(abs)
  } catch (e: any) {
    if (isMissingFile(e)) {
      return { ok: false, reason: 'missing', message: 'The Linear accounts file (' + rel + ') does not exist yet, so this machine has no Linear account configured.', from: 'none', warnings: [] }
    }
    return envFail('Failed to read the Linear accounts file', rel, 'The current account may lack read permission, or another program may be using the file. Check and retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  const parsed: any = parseConfig(text, 'linear-accounts')
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message, from: 'yaml', warnings: [] }
  return { ok: true, value: parsed.value, from: 'yaml', readonly: parsed.readonly === true, legacyPresent: false, warnings: [...(parsed.warnings || [])] }
}

/** Write the account document (#12): the whole file at once, the same contract as the local settings writer. */
export async function writeLinearAccounts(value: any, homeDir: any, io: any, overridePath?: any): Promise<any> {
  needIo(io)
  const given: string = typeof overridePath === 'string' ? overridePath.trim() : ''
  const abs: any = given !== '' ? given : accountsPath(homeDir)
  const rel: any = given !== '' ? given : LINEAR_ACCOUNTS_REL_SEGMENTS.join('/')
  const made: any = stringifyConfig(value, 'linear-accounts')
  if (!made.ok) return { ok: false, reason: made.reason, message: made.message, keys: made.keys, warnings: [] }
  try {
    await io.writeText(abs, made.text)
    const back: string = await io.readText(abs)
    if (String(back) !== made.text) {
      return envFail('Save failed: reading the file back returned content different from what was just written', rel, 'The save cannot be confirmed. Open the file, check its content, and retry.')
    }
  } catch (e: any) {
    return envFail('Save failed: could not write this file', rel, 'Check that its parent directory exists and the current account can write to it, then retry. Original error: ' + String((e && e.message) || e).slice(0, 120))
  }
  return { ok: true, from: 'yaml', legacyDeleted: false, warnings: [] }
}

/**
 * 账号缝的宿主实现（#27 的决定，形状在 `src/tracker/contract/accounts.ts`）。
 *
 * 放在本文件而不是新开一个宿主模块：它要读的账号文档与解析函数都在这里，另起文件会多出两条
 * `same-layer-import-host` 边（`tests/verify-dependency-rules.ts` 只许减不许增）。
 *
 * 三件事值得记住：
 *   1. **按别名解析**：工作区用哪本账是仓库的声明，房间把别名交进来；本文件不认识项目绑定。
 *   2. **身份探活走 `http`（bucket probe），不用全局 fetch**，并且按 (别名, token) 缓存在进程里：
 *      同一本账同一个 token 一趟进程只探一次；token 变了（登录刷新过）就重新探 —— 否则一个从别的
 *      组织粘来的 token 会安静地读回那家的票，看起来还像成功。
 *   3. **过边界的是可直接用的 Authorization，不是 token 本身**；失败用账号状态说
 *      （`needs_auth` / `identity_mismatch` / `error` / `unconfigured`），下一步动作按这四档分。
 */
export function createLinearAccountSeam(deps: LinearSeamDeps): AccountSeam {
  const ctx = deps.ctx
  const probeCache = new Map<string, true>()
  const io = {
    async readText(p: string): Promise<string> {
      const fsp: any = (globalThis as any).process && (globalThis as any).process.getBuiltinModule ? (globalThis as any).process.getBuiltinModule('node:fs/promises') : null
      if (!fsp) throw new Error('no filesystem in this runtime')
      return fsp.readFile(String(p), 'utf8')
    },
    async writeText(p: string, text: string): Promise<void> {
      const fsp: any = (globalThis as any).process && (globalThis as any).process.getBuiltinModule ? (globalThis as any).process.getBuiltinModule('node:fs/promises') : null
      if (!fsp) throw new Error('no filesystem in this runtime')
      await fsp.writeFile(String(p), String(text), 'utf8')
    },
  }
  return {
    resolve: async function (alias: string, signal?: AbortSignal): Promise<AccountSeamResult> {
      const wanted = String(alias || '').trim()
      if (!wanted) return { ok: false, status: 'unconfigured', message: 'the binding names no Linear account alias' }
      const pl: any = typeof deps.getPlatform === 'function' ? await deps.getPlatform().catch(() => null) : null
      if (!pl || typeof pl.getHome !== 'function') return { ok: false, status: 'error', message: 'this composition cannot reach the platform, so the Linear account file cannot be located' }
      let home = ''
      try { home = String((await pl.getHome()) || '') } catch { home = '' }
      if (!home) return { ok: false, status: 'error', message: 'this composition cannot read the home directory, so the Linear account file cannot be located' }
      const env = function (name: string): string | undefined { try { return pl.env && typeof pl.env.get === 'function' ? pl.env.get(name) : undefined } catch { return undefined } }
      const read: any = await readLinearAccounts(home, io, linearRegistryPath(env))
      if (read.ok !== true) {
        return read.reason === 'missing'
          ? { ok: false, status: 'unconfigured', message: 'this machine has no Linear account configured (' + String(read.message || '').slice(0, 160) + ')' }
          : { ok: false, status: 'error', message: String(read.message || read.reason || 'the Linear account document could not be read').slice(0, 200) }
      }
      const doc: any = read.value
      const list: any[] = (doc && Array.isArray(doc.accounts) ? doc.accounts : []).filter((a: any) => a && typeof a.alias === 'string' && a.alias)
      const chosen = list.find((a: any) => a.alias === wanted)
      if (!chosen) return { ok: false, status: 'unconfigured', message: 'the Linear account document has no account called ' + wanted }
      const probe = false
      const resolved: any = await resolveLinearAccountWithHost(ctx, chosen, { env, probe })
      if (!resolved || resolved.status !== 'ok') {
        const status = resolved && resolved.status === 'needs_auth' ? 'needs_auth' : (resolved && resolved.status === 'identity_mismatch' ? 'identity_mismatch' : 'error')
        return { ok: false, status: status, message: String((resolved && resolved.message) || 'the Linear account could not be resolved').slice(0, 300) }
      }
      if (signal && signal.aborted) return { ok: false, status: 'error', message: 'the caller gave up before the Linear account was resolved' }
      const token = String(resolved.token || '')
      const cacheKey = wanted + ':' + token
      if (deps.http && !probeCache.has(cacheKey)) {
        const probed = await probeThroughChannel(deps.http, wanted, String(resolved.authorization || ''), chosen)
        if (!probed.ok) {
          // 探活失败对人是三种不同的下一步：组织对不上要去改这本账配的 token，token 不再被承认要去
          // 重新登录，其余（网络、上游）等一等再试。一律报成「组织不对」会把人指去做没用的事。
          const status = probed.status === 'needs_auth' || probed.status === 'identity_mismatch' ? probed.status : 'error'
          return { ok: false, status: status, message: String(probed.message || 'the identity probe failed').slice(0, 220) }
        }
        probeCache.set(cacheKey, true)
      }
      return { ok: true, alias: String(resolved.alias || wanted), authorization: String(resolved.authorization || ''), endpoint: LINEAR_GRAPHQL_ENDPOINT }
    },
  }
}

/** 探活依赖：平台（家目录/环境）、宿主上下文（凭据面）、以及走名额闸的 HTTP 通道。 */
export interface LinearSeamDeps { ctx: any; getPlatform?: () => Promise<any>; http?: any }

/**
 * 经房间同一条 HTTP 通道探一次身份（bucket=probe）：不走全局 fetch，也不额外记账。
 *
 * 失败要带上「这是哪一档」，因为调用方会把它翻成账号状态给人看：401/403 是 token 不再被承认
 * （去重新登录），组织对不上是这本账配错了 token（去改账），其余是网络或上游（等一等再试）。
 */
async function probeThroughChannel(http: any, alias: string, authorization: string, account?: any): Promise<{ ok: true } | { ok: false; status: string; message: string }> {
  try {
    const response = await http.request({
      method: 'POST',
      url: LINEAR_GRAPHQL_ENDPOINT,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: LINEAR_IDENTITY_QUERY, variables: {} }),
      bucket: 'probe',
      service: 'linear',
    })
    if (response.status < 200 || response.status >= 300) {
      const refused = response.status === 401 || response.status === 403
      return { ok: false, status: refused ? 'needs_auth' : 'error', message: 'the identity probe answered HTTP ' + response.status }
    }
    const payload: any = JSON.parse(String(response.body || '{}'))
    if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first: any = payload.errors[0] || {}
      const type = String((first.extensions && first.extensions.type) || '').toLowerCase()
      // 探活只分两档：凭据本身不行（要去重新登录）与其它（上游/网络/格式）。房间自己那份更细的分类
      // 在 `src/tracker/rooms/linear/errors.ts`，宿主不许 import 房间，所以这里按同一套关键词只取
      // 「认证类」这一档 —— 把认证失败说成 error，会把「去登录」这句唯一有用的动作丢掉。
      const authLike = type.indexOf('authentication') >= 0 || type.indexOf('forbidden') >= 0 || type.indexOf('not accessible') >= 0
      return { ok: false, status: authLike ? 'needs_auth' : 'error', message: 'the identity probe was refused: ' + String(first.message || 'unknown reason').slice(0, 160) }
    }
    if (!payload || !payload.data || !payload.data.viewer) return { ok: false, status: 'needs_auth', message: 'the identity probe answered without a viewer (' + alias + ')' }
    // 只看「有没有 viewer」不够：钉住组织 A 的账如果配了组织 B 的 token，那本票会被当成 A 的票读回来。
    // 所以按共享解析层同一套判定：先解出身份，再比对账号钉住的组织（与 resolveLinearAccount 内部同源）。
    const parsed: any = parseLinearIdentity(payload)
    if (!parsed || parsed.ok !== true) return { ok: false, status: parsed && parsed.reason === 'needs_auth' ? 'needs_auth' : 'error', message: 'the identity probe answered with something that is not an identity (' + alias + ')' }
    const pinned: any = account ? checkLinearIdentity(account, parsed.identity) : { ok: true }
    if (pinned && pinned.ok !== true) return { ok: false, status: 'identity_mismatch', message: String(pinned.message || 'the token belongs to another organization than the account pins').slice(0, 180) }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, status: 'error', message: 'the identity probe could not be sent: ' + String((e && e.message) || e).slice(0, 160) }
  }
}
