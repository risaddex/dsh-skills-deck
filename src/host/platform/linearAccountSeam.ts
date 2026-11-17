/**
 * src/host/platform/linearAccountSeam.ts — the factory that builds the account seam a tracker room talks to
 *
 * 为什么单独一个文件（#14，2026-11-17）：列账进缝那天，`linearAccounts.ts` 越过仓库的 20 KB 上限，
 * 而这两半回答的问题本来就不同 —— 那个文件读账号文档、解析凭据、探活；这个文件把解析结果收窄成
 * 房间允许看见的形状（一个 Authorization 值或一档分类过的失败），并把本机配置的账列出来。
 *
 * 这个文件存在的规矩只有一条：token 永不过边界。结果逐字段构造，不整份拷贝再删。
 */
import { LINEAR_GRAPHQL_ENDPOINT } from '../../shared/linear-accounts/src/resolve.js'
import { readLinearAccounts, linearRegistryPath, resolveLinearAccountWithHost, probeThroughChannel } from '../linearAccounts.js'
import type { AccountSeam, AccountSeamResult, AccountSeamEntry, AccountSeamListResult } from '../../tracker/contract/accounts.js'

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
    /**
     * List every account this machine has configured, without resolving any token.
     *
     * Why it does not probe: probing is one network round trip per account, and `deck_context` — the
     * tool every session calls first — must stay cheap. Whether an account still works is answered by
     * `resolve` on the first real read, which is where the status was always reported.
     *
     * The reader here repeats the locate/read steps of `resolve` on purpose. Extracting them would have
     * to thread `home`, `env` and the failure mapping through a second signature, and the two callers
     * differ in what they do with the document; keeping them apart keeps each one readable.
     */
    list: async function (signal?: AbortSignal): Promise<AccountSeamListResult> {
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
      if (signal && signal.aborted) return { ok: false, status: 'error', message: 'the caller gave up before the Linear accounts were listed' }
      const doc: any = read.value
      const rows: any[] = (doc && Array.isArray(doc.accounts) ? doc.accounts : []).filter((a: any) => a && typeof a.alias === 'string' && a.alias)
      const accounts: AccountSeamEntry[] = rows.map(function (a: any): AccountSeamEntry {
        const entry: AccountSeamEntry = {
          alias: String(a.alias),
          teams: Array.isArray(a.teams) ? a.teams.map(function (t: any): string { return String(t) }) : [],
          // 文档在读取时已补默认值；这里再兜一次是为了让「形状不全的旧文档」不至于把 null 漏给房间。
          reviewPattern: String(a.reviewPattern || 'review|revisando|revisão|revisao|qa'),
          reviewScope: String(a.reviewScope || 'subscribed'),
        }
        if (typeof a.label === 'string' && a.label) entry.label = a.label
        return entry
      })
      return { ok: true, accounts: accounts }
    },
  }
}

/** 探活依赖：平台（家目录/环境）、宿主上下文（凭据面）、以及走名额闸的 HTTP 通道。 */
export interface LinearSeamDeps { ctx: any; getPlatform?: () => Promise<any>; http?: any }
