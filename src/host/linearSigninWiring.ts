/**
 * src/host/linearSigninWiring.ts — the one place the host decides which accounts get a sign-in flow
 * (map ticket #19).
 *
 * Kept apart from src/host/index.ts on purpose: that entry is at its line ceiling, and a wrong line there
 * stops every deck tool from registering, not only Linear. This function takes everything it needs as
 * arguments and does nothing at import time, so the entry needs exactly one call to it and the rest can
 * be pinned offline.
 *
 * What it does, in order, and what each failure costs:
 *   1. Read the account document. A missing file is a machine with no Linear account: nothing to register,
 *      which is the correct state, not an error. A file that exists but does not parse is reported to the
 *      caller and nothing is registered, because registering flows for accounts nobody could read would
 *      invite a sign-in that the resolver then cannot find.
 *   2. Keep only the accounts that authenticate with OAuth. An `api_key` account has no conversation to
 *      have: its key comes from the environment or a stored record.
 *   3. Register one flow per account on `ctx.authorization`, and hand back the disposer so a reload does
 *      not leave a flow claiming a key (a second registration for the same key is `DUPLICATE_FLOW`).
 */

import { readLinearAccounts, linearRegistryPath } from './linearAccounts.js'
import { registerLinearFlows } from './linearSignin.js'
import type { FlowAccount, LinearSigninDeps } from './linearSignin.js'

/**
 * The file io the account reader takes, over Node's own fs. The settings module keeps its io private, and
 * a second copy of the same three-line mapping is cheaper than widening that module's public surface for
 * one caller. Read maps to readFile and write to writeFile; a missing file is left to throw ENOENT, which
 * the account reader already turns into "missing".
 */
export function nodeFileIo(): { readText(p: string): Promise<string>; writeText(p: string, text: string): Promise<void> } {
  const fsp: any = (globalThis as any).process && (globalThis as any).process.getBuiltinModule ? (globalThis as any).process.getBuiltinModule('node:fs/promises') : null
  return {
    async readText(p: string): Promise<string> { if (!fsp) throw new Error('no filesystem in this runtime'); return fsp.readFile(String(p), 'utf8') },
    async writeText(p: string, text: string): Promise<void> { if (!fsp) throw new Error('no filesystem in this runtime'); await fsp.writeFile(String(p), String(text), 'utf8') },
  }
}

/** What the wiring reports back, so the caller can log one line without parsing anything. */
export interface LinearSigninWiringResult {
  registered: number
  skipped: 'no_accounts_file' | 'unreadable' | 'no_oauth_accounts' | 'no_seam' | ''
  detail: string
  dispose: () => void
}

export async function wireLinearSignin(args: {
  ctx: any
  homeDir: string
  io: any
  env?: (name: string) => string | undefined
  deps?: LinearSigninDeps
}): Promise<LinearSigninWiringResult> {
  const nothing = (skipped: LinearSigninWiringResult['skipped'], detail: string): LinearSigninWiringResult => ({ registered: 0, skipped, detail, dispose: () => {} })
  const env = args.env || (() => undefined)
  const read = await readLinearAccounts(args.homeDir, args.io, linearRegistryPath(env))
  if (read.ok !== true) {
    return read.reason === 'missing'
      ? nothing('no_accounts_file', 'this machine has no Linear account configured')
      : nothing('unreadable', String(read.message || read.reason).slice(0, 200))
  }
  const doc: any = read.value
  const accounts: FlowAccount[] = (doc && Array.isArray(doc.accounts) ? doc.accounts : [])
    .filter((a: any) => a && (a.authType === 'oauth_user' || a.authType === 'oauth_app'))
    .map((a: any) => ({ alias: String(a.alias), label: a.label ? String(a.label) : undefined, authType: String(a.authType), orgId: a.orgId ? String(a.orgId) : undefined, urlKey: a.urlKey ? String(a.urlKey) : undefined }))
  if (accounts.length === 0) return nothing('no_oauth_accounts', 'no account uses OAuth, so there is nothing to sign in to')

  let seam: any = null
  try { seam = args.ctx && typeof args.ctx.get === 'function' ? args.ctx.get('authorization') : null } catch (e) { seam = null }
  if (!seam || typeof seam.registerFlow !== 'function') return nothing('no_seam', 'this composition has no authorization seam; the accounts read as needs_auth')

  const dispose = registerLinearFlows(args.ctx, accounts, args.deps)
  return { registered: accounts.length, skipped: '', detail: accounts.map((a) => a.alias).join(','), dispose }
}
