/**
 * src/tracker/rooms/linear/index.ts —— Linear 房的公开面（预检、取票、列票）
 *
 * ── 账号从哪来（#27 的决定） ─────────────────────────────────────────────────
 * 三步：①房间读仓库自己的声明（`docs/agents/issue-tracker.md` 的 `# Issue tracker: linear` 一节）
 * 拿到别名；②把别名交给契约里的账号缝 `ctx.accounts.resolve(alias)`（形状见
 * `src/tracker/contract/accounts.ts`，实现见 `src/host/linearAccounts.ts`）；③把回来的
 * `authorization` 当成这一趟的身份发请求。房间不认识 token，也不管它什么时候过期。
 *
 * 解析是**懒**的：`create` 时不读盘也不打网络，第一次要用账号时才问一次，然后这一份后端实例
 * 记住结果 —— 一趟刷新里读十张票不该解析十次。
 *
 * ── matches 为什么要认领 ────────────────────────────────────────────────────
 * 有声明就认领：一个写了 Linear 绑定却还没登录的工作区，应该在选中后收到「去登录」那句话，
 * 而不是看起来像「这不是 Linear 仓库」。没声明才回 false（那是 GitHub/GitLab 工作区）。
 *
 * ── 这个切片还没有的东西 ─────────────────────────────────────────────────────
 * 其余操作：写侧、评论、标签、关系、子票、计数、翻页、预算读数（都在 #13 的票面上）。
 */
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { AccountSeamResult } from '../../contract/accounts.js'
import type { RoomOperations } from '../../contract/operations.js'
import type { BackendModule } from '../../contract/backend-module.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { LinearAccount } from './client.js'
import { getIssue, listIssues } from './read.js'
import { commentOnIssue, updateIssue, setIssueStateType, createIssue, setParentOfIssue } from './write.js'
import { preflightLinear } from './preflight.js'
import { failLinear } from './errors.js'
import { readBinding } from './binding.js'

export type { LinearAccount } from './client.js'
export { gql } from './client.js'
export { issueOf, stateOf, issueTypeOf } from './normalize.js'
export { preflightLinear, readIdentity } from './preflight.js'
export { getIssue, listIssues, buildIssuesFilter, unsupportedFilters } from './read.js'
export { commentOnIssue, updateIssue, setIssueStateType, createIssue, setParentOfIssue } from './write.js'
export { parseBinding, readBinding, BINDING_PATH } from './binding.js'

/** 契约的账号缝回包 → 这一层要的那三格；缺 authorization 就当没解出来。 */
function toAccount(result: AccountSeamResult): LinearAccount | null {
  if (!result.ok) return null
  const authorization = String(result.authorization || '')
  if (!authorization) return null
  return { alias: String(result.alias || ''), endpoint: String(result.endpoint || 'https://api.linear.app/graphql'), authorization }
}

/** 账号状态 → 房间的错误档：要重新登录是 auth，其余都按环境问题交出去。 */
function kindOfStatus(status: string): typeof ERROR_KIND.AUTH | typeof ERROR_KIND.ENV {
  return status === 'needs_auth' || status === 'identity_mismatch' ? ERROR_KIND.AUTH : ERROR_KIND.ENV
}

/**
 * 造一个 Linear 后端。
 *
 * `account` 只给测试用：给了就不问声明也不问账号缝，直接以它为准。
 */
export function createLinearBackend(ctx: BackendContext, account?: LinearAccount): RoomOperations {
  async function resolveOnce(opCtx: OpContext): Promise<{ ok: true; account: LinearAccount } | { ok: false; error: any }> {
    if (account) return { ok: true, account }
    const seam = ctx.accounts
    if (!seam || typeof seam.resolve !== 'function') {
      return { ok: false, error: failLinear(ERROR_KIND.ENV, 'the room has no account seam wired (ctx.accounts is missing)').error }
    }
    const binding = await readBinding(opCtx)
    if (!binding) return { ok: false, error: failLinear(ERROR_KIND.ENV, 'this workspace has no Linear binding: add a `# Issue tracker: linear` section with an `alias:` line to docs/agents/issue-tracker.md').error }
    const resolved = await seam.resolve(binding.alias)
    const ready = toAccount(resolved)
    if (!ready) {
      const why = resolved.ok ? 'the resolved Linear account carried no authorization' : String(resolved.message || 'the Linear account could not be resolved')
      const kind = resolved.ok ? ERROR_KIND.ENV : kindOfStatus(String(resolved.status || ''))
      return { ok: false, error: failLinear(kind, why).error }
    }
    return { ok: true, account: ready }
  }
  /**
   * 每一次操作都按**这一次**的绑定解析。
   *
   * 不在实例上缓存：`createRegistry` 一个模块只造一份后端实例，而一份实例会被不同工作区复用
   * （PR #29 review 指出过：两个工作区会拿第一份的凭据发请求）。探活结果的缓存留在宿主，
   * 按 (别名, token) 记，那才是跨工作区正确的粒度。
   */
  async function using(opCtx: OpContext): Promise<{ ok: true; account: LinearAccount } | { ok: false; error: any }> {
    return resolveOnce(opCtx)
  }
  return {
    id: 'linear',
    preflight: async (_handle, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error } as never
      return preflightLinear(opCtx || (ctx as never), got.account) as never
    },
    get: async (_repo, key, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return getIssue(opCtx || (ctx as never), got.account, key, opts)
    },
    list: async (_repo, filter, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return listIssues(opCtx || (ctx as never), got.account, filter)
    },
    comment: async (_repo, key, body, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return commentOnIssue(opCtx || (ctx as never), got.account, key, body)
    },
    update: async (_repo, key, patch, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return updateIssue(opCtx || (ctx as never), got.account, key, patch)
    },
    close: async (_repo, key, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      const requestCtx = opCtx || (ctx as never)
      // 契约要求关闭原因被记下来。Linear 的状态改动不存原因，所以先把原因写成一条评论；
      // 评论写不成就不关 —— 关掉却不留原因，等于把调用方给的解释丢了。
      const reason = String(((opts || {}) as { reason?: string }).reason || '').trim()
      if (reason) {
        const noted = await commentOnIssue(requestCtx, got.account, key, reason)
        if (!noted.ok) return { ok: false, error: noted.error }
      }
      return setIssueStateType(requestCtx, got.account, key, 'completed')
    },
    create: async (_repo, input, opCtx) => {
      const requestCtx = opCtx || (ctx as never)
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error }
      // 团队来自绑定声明：Linear 的 issueCreate 必须带 teamId，而声明里写的是团队 key。
      const binding = await readBinding(requestCtx)
      return createIssue(requestCtx, got.account, input, binding ? binding.team : '')
    },
    setParent: async (_repo, key, parentKey, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setParentOfIssue(opCtx || (ctx as never), got.account, key, parentKey, opts)
    },
    reopen: async (_repo, key, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setIssueStateType(opCtx || (ctx as never), got.account, key, 'unstarted')
    },
  }
}

/** 模块对象：注册表启动时读的那一份静态描述。 */
export const linearModule = {
  id: 'linear',
  label: 'Linear',
  create: (ctx: BackendContext) => createLinearBackend(ctx),
  /** 有声明就认领（见文件头）；读不到声明才回 false。 */
  matches: async (_handle, opCtx) => (await readBinding(opCtx)) !== null,
  budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
} satisfies BackendModule
