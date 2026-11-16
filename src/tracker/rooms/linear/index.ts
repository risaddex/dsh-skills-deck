/**
 * src/tracker/rooms/linear/index.ts —— Linear 房的公开面（第一个切片：预检、取票、列票）
 *
 * ── 为什么工厂收两样东西 ─────────────────────────────────────────────────────
 * `createLinearBackend(ctx, account)`：context 是进程级能力（HTTP 通道在这里），account 是
 * 「用哪本账」——它不能从 ctx 里摸，因为凭据解析住在宿主（`src/host/linearAccounts.ts`），
 * 而房间不许 import 宿主。装配点负责解出账号再交给工厂，这也是 deck 设置里账号模式那条线的接口。
 *
 * ── 这个切片还没有的东西（都在票据上记着）───────────────────────────────────
 *   · 模块对象（id / label / matches / budget）：matches 要回答「这个工作区是不是 Linear」，
 *     得先有绑定声明与账号解析的路，属于账号模式那条线；
 *   · 其余操作：写侧、评论、标签、关系、子票、计数、翻页、预算读数；
 *   · 所以本房今天**不注册**进装配点 —— 一个认不出来的后端接进去只会抢别人的判定。
 */
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { RoomOperations } from '../../contract/operations.js'
import type { BackendModule } from '../../contract/backend-module.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { LinearAccount } from './client.js'
import { getIssue, listIssues } from './read.js'
import { preflightLinear } from './preflight.js'
import { failLinear } from './errors.js'

export type { LinearAccount } from './client.js'
export { gql } from './client.js'
export { issueOf, stateOf, issueTypeOf } from './normalize.js'
export { preflightLinear, readIdentity } from './preflight.js'
export { getIssue, listIssues, buildIssuesFilter } from './read.js'

/**
 * 造一个 Linear 后端。今天只交出三条能力，其余由注册表补「我不支持」的桩 ——
 * 契约允许后端实现自己那部分，缺的如实回 unsupported，不假装。
 */
export function createLinearBackend(ctx: BackendContext, account: LinearAccount | null): RoomOperations {
  /** 没有账号时每一条都按环境失败，并说清缺哪一步 —— 静默回空名单会让「没配」看起来像「没有票」。 */
  const noAccount = () =>
    failLinear(ERROR_KIND.ENV, 'the Linear account is not wired yet: no account was resolved for this process (see the Linear backend ticket)')
  return {
    id: 'linear',
    preflight: (_handle, opCtx) => (account ? preflightLinear(opCtx || (ctx as never), account) : Promise.resolve(noAccount() as never)),
    get: (_repo, key, opts, opCtx) => (account ? getIssue(opCtx || (ctx as never), account, key, opts) : Promise.resolve(noAccount() as never)),
    list: (_repo, filter, opCtx) => (account ? listIssues(opCtx || (ctx as never), account, filter) : Promise.resolve(noAccount() as never)),
  }
}

/**
 * 这一趟用哪本账。
 *
 * 今天恒为 `null`：凭据解析住在宿主（`src/host/linearAccounts.ts` 的 `resolveLinearAccountWithHost`），
 * 房间不许 import 宿主，而 `BackendContext` 里还没有「把账号交给房间」的那一格（账号模式那条线的接口）。
 * 所以本房现在注册在册、认不出任何工作区、被选到时会如实说「账号还没接上」——
 * 这比不注册更诚实：一个不存在的后端，界面上的人只能猜它去哪了。
 */
function resolveAccount(_ctx: BackendContext): LinearAccount | null {
  return null
}

/**
 * 模块对象：注册表启动时读的那一份静态描述。
 *
 * `matches` 恒为 false 是有意的：没有账号解析就连不上 Linear，认领一个工作区只会抢走别人的判定。
 * 等账号模式落地，这里换成「读绑定声明 + 账号可用」的判定，同时把 budget 之外的能力一条条补上。
 */
export const linearModule = {
  id: 'linear',
  label: 'Linear',
  create: (ctx: BackendContext) => createLinearBackend(ctx, resolveAccount(ctx)),
  matches: async () => false,
  budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
} satisfies BackendModule
