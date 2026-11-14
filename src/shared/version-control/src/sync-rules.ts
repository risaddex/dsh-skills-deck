// 版本管理「同步」动作的现场判定与确认文案（#1755 T19，域 8 的 8.5–8.14）。
//
// 这个文件和 sync-actions.ts 一样故意零 import：共享层同层互相 import 会被依赖门禁拦下。
// 判定只吃宿主归一好的现场（scene），不自己去读仓库 —— 读现场与起进程是宿主的事。
// 判定结论只有三种：allow（可以直接执行）、warn（要用户确认，确认卡四段由 syncConfirmOf 给出）、
// block（禁用；原因写进 reasons，界面常驻展示，不许点得动）。
//
// 改之前先读：
// - 所有同步动作都是写动作，所以默认 needsConfirm 为真；fetch 也走确认，因为它在本地对象库落东西。
// - 强推没有租约基准一律 block（baseline-missing / force-lease-required），这是 ADR 与票面写死的红线。
// - delete-current 与 dirty-tree 只是提醒，不拦人；其余原因都是硬拦。

export const SYNC_RULES_SOURCE = 'src/shared/version-control/src/sync-rules.ts'

// 稳定的原因短名 → 给人看的一句中文。界面与宿主都用同一份，不许各处自己编。
export const SYNC_REASONS: any = {
  ok: 'the current state allows this action',
  'unknown-action': 'unknown sync action; the interface has not registered it',
  'bare-repo': 'the current directory is a bare repository with no working tree, so the sync action has nowhere to apply',
  'detached-head': 'not on any branch (detached HEAD); switch back to a branch before syncing',
  'mid-operation': 'the repository is in an unfinished merge, rebase, cherry-pick or revert; finish it before syncing',
  'no-remote': 'this remote does not exist in the repository; register it on the remotes and sync page first',
  'conflicts-unresolved': 'the working tree has unresolved conflicts; resolve them before pulling',
  'upstream-gone': 'the upstream branch no longer exists on the remote; set the upstream again first',
  'baseline-missing': 'the remote branch cannot be read now, so force push has no lease baseline',
  'baseline-bad': 'the commit id returned by ls-remote cannot be used as a lease baseline',
  'force-lease-required': 'force push requires an explicit lease; force push without a baseline is not accepted',
  'delete-current': 'this is the currently checked-out branch; confirm before deleting the remote branch of the same name',
  'dirty-tree': 'the working tree has uncommitted changes; handle them before pull with rebase',
  'bad-plan': 'this action plan is incomplete: a required target is missing'
}

const BLOCKING: any = {
  'unknown-action': true,
  'bare-repo': true,
  'detached-head': true,
  'mid-operation': true,
  'no-remote': true,
  'conflicts-unresolved': true,
  'upstream-gone': true,
  'baseline-missing': true,
  'baseline-bad': true,
  'force-lease-required': true,
  'bad-plan': true
}

export function syncReasonTextOf(reason: any): string {
  const id = String(reason === undefined || reason === null ? '' : reason)
  const text = SYNC_REASONS[id]
  return typeof text === 'string' ? text : 'unknown reason: ' + id
}

function pushReason(list: string[], reason: string): void {
  if (list.indexOf(reason) < 0) list.push(reason)
}

// scene 由宿主归一：{ bare, detached, currentBranch, midOperation, conflicts, dirty, remotes, upstreamGone }
export function judgeSync(scene: any, plan: any): any {
  const s = scene === undefined || scene === null ? {} : scene
  const reasons: string[] = []
  if (!plan || typeof plan.action !== 'string') {
    pushReason(reasons, 'bad-plan')
    return { decision: 'block', reasons: reasons, blockingReasons: reasons.slice(), warningReasons: [], confirmRequired: false }
  }
  const action = plan.action
  const isFetch = action === 'fetch'
  if (s.bare === true) pushReason(reasons, 'bare-repo')
  if (!isFetch && s.detached === true) pushReason(reasons, 'detached-head')
  if (!isFetch && s.midOperation === true) pushReason(reasons, 'mid-operation')
  // 远端清单有两种状态必须分开：remotesKnown===false 表示「这次没读到」；读到空数组表示「一个远端都没有」。
  // 后者照样要 block——空清单上 push 注定失败，不能拿空数组兼表「没读」而放过。
  const remotes = Array.isArray(s.remotes) ? s.remotes : []
  if (s.remotesKnown !== false && plan.remote && remotes.indexOf(plan.remote) < 0) pushReason(reasons, 'no-remote')
  if (action === 'pull-merge' || action === 'pull-rebase' || action === 'pull-ff-only') {
    if (s.conflicts === true) pushReason(reasons, 'conflicts-unresolved')
    if (s.upstreamGone === true) pushReason(reasons, 'upstream-gone')
  }
  if (action === 'force-push') {
    if (typeof plan.leaseOid !== 'string' || plan.leaseOid === '') pushReason(reasons, 'force-lease-required')
    else if (!/^[0-9a-fA-F]{7,64}$/.test(plan.leaseOid)) pushReason(reasons, 'baseline-bad')
  }
  const blocking: string[] = []
  const warning: string[] = []
  for (let i = 0; i < reasons.length; i = i + 1) {
    if (BLOCKING[reasons[i]] === true) blocking.push(reasons[i])
    else warning.push(reasons[i])
  }
  if (action === 'delete-remote-ref' && s.currentBranch && plan.branch && plan.branch === s.currentBranch) pushReason(warning, 'delete-current')
  if ((action === 'pull-merge' || action === 'pull-rebase') && s.dirty === true) pushReason(warning, 'dirty-tree')
  const decision = blocking.length > 0 ? 'block' : warning.length > 0 ? 'warn' : plan.needsConfirm === true ? 'warn' : 'allow'
  // confirmRequired 只表示「界面要不要弹确认卡」：block 不弹（只显示理由），warn 弹，allow 不弹。
  return { decision: decision, reasons: blocking.concat(warning), blockingReasons: blocking, warningReasons: warning, confirmRequired: decision === 'warn' }
}

function verbOf(action: any): string {
  if (action === 'fetch') return 'Fetch'
  if (action === 'pull-merge' || action === 'pull-rebase' || action === 'pull-ff-only') return 'Pull'
  if (action === 'delete-remote-ref') return 'Delete remote refs'
  if (action === 'force-push') return 'Force push'
  if (action === 'atomic-push') return 'Atomic push'
  if (action === 'push-tags') return 'Push tags'
  if (action === 'push-upstream') return 'Push and set upstream'
  return 'Push'
}

function shortOid(oid: any): string {
  const text = typeof oid === 'string' ? oid : ''
  return text.length > 12 ? text.slice(0, 12) : text
}

// 确认卡四段：会动什么 / 不会动什么 / 可逆性与恢复路径 / 动词写后果。
// extra 里带 oldOid（ls-remote 读到的远端当前位置）与 newOid（本地准备推上去的提交号），强推卡必须点名这两个号。
export function syncConfirmOf(plan: any, extra?: any): any {
  const e = extra === undefined || extra === null ? {} : extra
  const action = plan && typeof plan.action === 'string' ? plan.action : ''
  const verb = verbOf(action)
  let target = plan && typeof plan.targetText === 'string' ? plan.targetText : ''
  if (action === 'force-push') {
    const remote = plan && typeof plan.remote === 'string' ? plan.remote : 'origin'
    const branch = plan && typeof plan.branch === 'string' ? plan.branch : ''
    target = 'remote branch ' + remote + '/' + branch + ' (remote currently at ' + shortOid(e.oldOid) + ', will become ' + shortOid(e.newOid) + ')'
  }
  let what = ''
  let wont = ''
  let reversible = ''
  if (action === 'fetch') {
    what = 'Will fetch new objects from remote ' + (plan && plan.remote ? plan.remote : 'origin') + ' and update the locally recorded remote-tracking refs.'
    wont = 'Will not merge into the current branch or change working tree files.'
    reversible = 'Fetched content stays in the local object store, so fetching again will not download everything again.'
  } else if (action === 'pull-merge' || action === 'pull-rebase' || action === 'pull-ff-only') {
    const mode = action === 'pull-rebase' ? 'rebase' : action === 'pull-ff-only' ? 'fast-forward only' : 'merge'
    what = 'Will fetch remote updates first, then integrate them by ' + mode + ' into the current branch' + (plan && plan.upstream ? ' (upstream ' + plan.upstream + ')' : '') + '.'
    wont = 'Will not resolve conflicts automatically; conflicts stop the operation and are reported, and your uncommitted changes are not discarded.'
    reversible = action === 'pull-rebase' ? 'Original commits can be recovered from reflog after a rebase; conflicts stay in the working tree for you to resolve.' : 'A merge can be undone with git reset to the pre-merge commit; conflicts stay in the working tree for you to resolve.'
  } else if (action === 'delete-remote-ref') {
    const kind = plan && plan.refKind === 'tag' ? 'tag' : 'branch'
    what = 'Will delete, on remote ' + (plan ? plan.remote : 'origin') + ', the ' + kind + ' ' + (plan && plan.ref ? plan.ref : '') + '.'
    wont = 'Will not delete the local ' + kind + ' of the same name, and will not change the working tree.'
    reversible = kind === 'tag' ? 'After deletion, the same tag can be pushed again to point at the original object.' : 'After deletion, if you know the original commit id, push the ref again to point at it; otherwise recover it only while a local record remains.'
  } else if (action === 'force-push') {
    what = 'Will force-push ' + target + ', using the lease to confirm nobody changed the remote after your preflight.'
    wont = 'Will not force push without a lease, and will not overwrite remote commits that appeared after your preflight (a lease mismatch fails immediately).'
    reversible = 'The original remote commit id is on the confirmation card; if the push is wrong, force push it back with the same lease.'
  } else if (action === 'atomic-push') {
    what = 'Will push local branch' + (plan && plan.localBranch ? ' ' + plan.localBranch : '') + ' atomically to ' + target + ': either all refs succeed or none do.'
    wont = 'Will not partly succeed; if any ref is rejected, none of the others are applied.'
    reversible = 'If the remote receives nothing, nothing changes; after it does, you can roll back using the new remote commit id.'
  } else if (action === 'push-tags') {
    what = 'Will push tags to ' + target + '.'
    wont = 'Will not change branches or delete existing remote tags.'
    reversible = 'A wrong tag can be deleted and pushed again; the remote pointer record stays in the panel.'
  } else if (action === 'push-upstream') {
    what = 'Will push the local branch to ' + target + ', and set it as the local branch upstream.'
    wont = 'Will not change other branches or force-overwrite existing remote commits.'
    reversible = 'If the push is rejected, nothing changes; after success, you can pull back using the upstream information.'
  } else {
    what = 'Will push the local branch to ' + target + '.'
    wont = 'Will not force-overwrite existing remote commits or change other branches.'
    reversible = 'If the push is rejected, nothing changes; after success, you can pull back using the upstream information.'
  }
  return { verb: verb, target: target, what: what, wont: wont, reversible: reversible }
}
