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
 * 其余操作：写侧、评论、标签、关系、计数、翻页、预算读数（都在 #13 的票面上）。
 * 子票（listSubIssues）自 #50 起有了真实现，见 sub-issues.ts；地图薄查（listMaps）自 #89 起有了真实现，见 maps.ts。
 */
import type { BackendContext, OpContext, RepoHandle } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { AccountSeamResult } from '../../contract/accounts.js'
import type { RoomOperations } from '../../contract/operations.js'
import type { BackendModule } from '../../contract/backend-module.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { LinearAccount } from './client.js'
import { getIssue, listIssues } from './read.js'
import { listAccountIssues, getAccountIssue, listConfiguredAccounts } from './account-read.js'
import { commentOnIssue, updateIssue, setIssueStateType, createIssue, setParentOfIssue } from './write.js'
import { setLabelsOfIssue } from './labels.js'
import { listLabelsOfTeam } from './label-list.js'
import { setAssigneesOfIssue } from './assignees.js'
import { setBlockedByOfIssue } from './relations.js'
import { countsOf, listPageOf, readBudgetOf } from './paging.js'
import { listSubIssuesOf } from './sub-issues.js'
import { listMapsOf } from './maps.js'
import { preflightLinear } from './preflight.js'
import { failLinear } from './errors.js'
import { readBinding } from './binding.js'

export type { LinearAccount } from './client.js'
export { gql } from './client.js'
export { issueOf, stateOf, issueTypeOf } from './normalize.js'
export { preflightLinear, readIdentity } from './preflight.js'
export { getIssue, listIssues, buildIssuesFilter, unsupportedFilters } from './read.js'
export { commentOnIssue, updateIssue, setIssueStateType, createIssue, setParentOfIssue } from './write.js'
export { setLabelsOfIssue } from './labels.js'
export { listLabelsOfTeam } from './label-list.js'
export { setAssigneesOfIssue } from './assignees.js'
export { setBlockedByOfIssue } from './relations.js'
export { countsOf, listPageOf, readBudgetOf } from './paging.js'
export { listSubIssuesOf } from './sub-issues.js'
export { listMapsOf } from './maps.js'
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
      const requestCtx = opCtx || (ctx as never)
      const configured = await listConfiguredAccounts(requestCtx)
      const metadata = configured.ok ? { accounts: configured.data } : { accountsError: configured.error }
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error, ...metadata }
      return { ...await preflightLinear(requestCtx, got.account), ...metadata }
    },
    get: async (_repo, key, opts, opCtx) => {
      if (opts?.account !== undefined) return getAccountIssue(opCtx || (ctx as never), key, opts)
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return getIssue(opCtx || (ctx as never), got.account, key, opts)
    },
    list: async (_repo, filter, opCtx) => {
      if (filter?.account !== undefined || filter?.scope !== undefined) return listAccountIssues(opCtx || (ctx as never), filter)
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return listIssues(opCtx || (ctx as never), got.account, filter)
    },
    counts: async (_repo, filter, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return countsOf(opCtx || (ctx as never), got.account, filter)
    },
    listPage: async (_repo, filter, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      // 页大小由 opts.limit 决定（缺省与上限在共享表）；不在这里写死一个数。
      return listPageOf(opCtx || (ctx as never), got.account, filter, opts)
    },
    readBudget: async (opCtx) => readBudgetOf(opCtx || (ctx as never)),
    // 一张票的子票（#50）：键是文本（ENG-12 或 UUID），原样交下去；翻页、上限与「不全」的交代都在 sub-issues.ts。
    listSubIssues: async (_repo, mapKey, _opts, opCtx) => {
      const requestCtx = opCtx || (ctx as never)
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error }
      return listSubIssuesOf(requestCtx, got.account, mapKey)
    },
    // 地图薄查（#89）：只收仓库，本房不读 repo（账号来自绑定声明）；翻页、上限与「不全」的交代都在 maps.ts。
    listMaps: async (_repo, opCtx) => {
      const requestCtx = opCtx || (ctx as never)
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error }
      return listMapsOf(requestCtx, got.account)
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
    setLabels: async (_repo, key, labels, opts, opCtx) => {
      const requestCtx = opCtx || (ctx as never)
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error }
      // 团队 key 来自绑定：新建标签时决定标签归属哪个团队（见 labels.ts 的注释）。
      const binding = await readBinding(requestCtx)
      return setLabelsOfIssue(requestCtx, got.account, key, labels, opts, binding ? binding.team : '')
    },
    setAssignees: async (_repo, key, assignees, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setAssigneesOfIssue(opCtx || (ctx as never), got.account, key, assignees, opts)
    },
    setBlockedBy: async (_repo, key, blockedBy, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setBlockedByOfIssue(opCtx || (ctx as never), got.account, key, blockedBy, opts)
    },
    setParent: async (_repo, key, parentKey, opts, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setParentOfIssue(opCtx || (ctx as never), got.account, key, parentKey, opts)
    },
    listLabels: async (_repo, opCtx) => {
      const requestCtx = opCtx || (ctx as never)
      const got = await using(requestCtx)
      if (!got.ok) return { ok: false, error: got.error }
      // 团队 key 来自绑定：「团队的标签」是哪个团队，只有声明说了算（见 label-list.ts 的头注释）。
      const binding = await readBinding(requestCtx)
      return listLabelsOfTeam(requestCtx, got.account, binding ? binding.team : '')
    },
    reopen: async (_repo, key, opCtx) => {
      const got = await using(opCtx || (ctx as never))
      if (!got.ok) return { ok: false, error: got.error }
      return setIssueStateType(opCtx || (ctx as never), got.account, key, 'unstarted')
    },
  }
}

/**
 * 仓库身份（#45）：Linear 没有 owner/name 这种远端仓库，它的「仓库」就是声明了绑定的工作区目录。
 *
 * 为什么必须给：本房间所有操作都不读 `repo` 参数，但宿主的详情、评论与写评论入口在调房间之前，
 * 先要求 `repoRef.refId` 非空，否则回「cannot resolve the target repository (refId missing)」。
 * 以前模块没有 describe，注册表回退的骨架只给本地 Markdown 填目录，Linear 的 refId 是空串：
 * 列表能出（快照路径自己兜了一个 refId=cwd），点开一张票却报这句话。
 * 取 handle.refId 优先、没有再取 cwd，与本地 Markdown 同口径；url 留空，不替 Linear 编网址。
 * 反例：不要拿它给 GitHub / GitLab 兜底，那两家的目录名不是仓库，空 refId 对它们是诚实的失败（见 tracker/session/repo-ref-note.ts）。
 */
export function describe(handle: RepoHandle, backendId: string = 'linear'): RepositoryRef {
  const cwd = handle && handle.cwd ? String(handle.cwd) : ''
  const refId = handle && handle.refId ? String(handle.refId) : cwd
  const out: RepositoryRef = { backend: backendId, refId: refId, name: refId ? (refId.split(/[\\/]/).pop() || refId) : backendId, url: '' }
  if (handle && handle.effortId !== undefined && handle.effortId !== null) out.effortId = String(handle.effortId)
  return out
}

/** 模块对象：注册表启动时读的那一份静态描述。 */
export const linearModule = {
  id: 'linear',
  label: 'Linear',
  create: (ctx: BackendContext) => createLinearBackend(ctx),
  describe,
  /** 有声明就认领（见文件头）；读不到声明才回 false。 */
  matches: async (_handle, opCtx) => (await readBinding(opCtx)) !== null,
  // #65：setupRun 这条通用提示词按这四个词条键填空。不声明就会落到 GitHub 的默认键组，把「GitHub Issues」写进一个 Linear 工作区；
  //   声明了它们，通用路径（检查页那颗「初始化」、切换后端的对齐）说的也是 Linear。真正写绑定的是横幅那颗按钮（wf.linearBindingPrompt），
  //   所以备注里只交代这一点，不重复一份写文件的步骤。
  setupPrompt: {
    trackerLine: 'setup.linear.trackerLine',
    trackerChoice: 'setup.linear.trackerChoice',
    backendNote: 'setup.linear.backendNote',
    labelReqs: 'setup.linear.labelReqs',
  },
  // 命令词表：Linear 没有命令行工具，只声明站点名（{cli} 留空，渲染时回落中性说法），与本地 Markdown 同口径。
  prompts: {
    commandVocabulary: { cliBrand: 'Linear' },
  },
  budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
} satisfies BackendModule
