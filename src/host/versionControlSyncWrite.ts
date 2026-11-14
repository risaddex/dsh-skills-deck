// 同步动作的凭票执行：票验完才交给长任务通道起那唯一一条 git 进程（#1755 T19）。
//
// 这个文件自己不起进程：fetch/pull/push 一律交给 T05 的长任务通道（开始/查询/取消、软取消、残留说明），
// 这样取消、进度、重启后如实报告中断这些行为与其它长任务共用一套，不另造轮子。
// 核对顺序与 branch-write 同一条路子：
//   ① requestId 重放回同一份结果（不再签票、不再起任务）；
//   ② 票号/requestId 形状；③ 票不存在 ticket-missing；④ 动作不符 ticket-op-mismatch；
//   ⑤ 过期 ticket-expired；⑥ 仓库不一致 stale-repo；⑦ HEAD 漂了 stale-head；⑧ 计划摘要变了 target-changed；
//   ⑨ 需要确认却没带 confirmed:true → need-confirm；⑩ 唯一一次 startTask。
// 失败信封里 git/step/expected/actual/cause 放在顶层，界面按「结果贴触发点」的失败画法显示。

import { bindingsVerdict, requestIdProblem, ticketPureVerdict } from '../shared/version-control/src/write-ticket.js'
import { idShapeProblem } from '../shared/version-control/src/write-reasons.js'
import { syncPlanDigestInput } from '../shared/version-control/src/sync-actions.js'

export const SYNC_WRITE_SOURCE = 'src/host/versionControlSyncWrite.ts'

function stepOf(action: string): string {
  if (action === 'fetch') return 'Fetching remote updates'
  if (action === 'pull-merge' || action === 'pull-rebase' || action === 'pull-ff-only') return 'Pulling and integrating upstream'
  if (action === 'delete-remote-ref') return 'Deleting remote refs'
  if (action === 'force-push') return 'Force-pushing with lease'
  if (action === 'atomic-push') return 'Pushing atomically'
  if (action === 'push-tags') return 'Pushing tags'
  if (action === 'push-upstream') return 'Pushing and setting upstream'
  return 'Pushing'
}

export function createSyncWrite(d: any): any {
  const failPhone: any = d.failPhone
  const now: any = d.now
  const measure: any = d.measure
  const tickets: Map<string, any> = d.tickets
  const results: Map<string, any> = d.results
  const startTask: any = d.startTask

  function wfail(kind: string, reason: string, message: string, extra?: any): any {
    return failPhone(kind, message, Object.assign({ reason: reason }, extra || {}))
  }

  function remember(requestId: any, out: any): void {
    if (!requestId) return
    results.set(String(requestId), out)
    while (results.size > 500) {
      const key: any = results.keys().next().value
      results.delete(key)
    }
  }

  async function handleGitSyncWrite(rawArgs: any): Promise<any> {
    const a: any = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
    const requestId: string = String(a.requestId || '')
    if (requestId && results.has(requestId)) {
      const prev: any = results.get(requestId)
      return { ok: prev && prev.ok === true, reused: true, result: prev }
    }
    const ticketId: string = String(a.ticketId || '')
    const idProblem: any = idShapeProblem(ticketId)
    if (idProblem) return wfail('args', 'bad-target', 'Invalid ticket ID: ' + String(ticketId).slice(0, 80))
    const ridProblem: any = requestIdProblem(requestId)
    if (ridProblem) return wfail('args', ridProblem, 'Invalid requestId: use only letters, digits, underscores and hyphens, at most 64 characters')
    const ticket: any = tickets.get(ticketId)
    if (!ticket) return wfail('blocked', 'ticket-missing', 'This ticket does not exist or has already been executed; run preflight again for a new ticket')
    const plan: any = ticket.target || {}
    const action: string = String(a.action || plan.action || '')
    if (String(plan.action || '') !== action) return wfail('args', 'ticket-op-mismatch', 'This ticket was not issued for this sync action; run preflight again')
    const pure: any = ticketPureVerdict(ticket, ticket.op, now())
    if (!pure || pure.ok !== true) return wfail('blocked', String((pure && pure.reason) || 'ticket-expired'), 'This ticket has expired or is unusable; run preflight again')
    const cwd: string = typeof a.cwd === 'string' && a.cwd.trim() !== '' ? a.cwd : ''
    if (!cwd) return wfail('args', 'bad-target', 'Missing working directory: execution must identify the repository')
    const cur: any = await measure(cwd)
    if (!cur || cur.ok !== true) return cur && cur.envelope ? cur.envelope : wfail('blocked', 'target-changed', 'Cannot reread repository state before execution; nothing was executed. Refresh first')
    if (String(cur.root || '') !== String(ticket.repoRoot || '')) return wfail('blocked', 'stale-repo', 'This ticket was not issued for this repository; run preflight again')
    if (String(cur.headOid || '') !== String(ticket.headOid || '')) return wfail('blocked', 'stale-head', 'HEAD changed after preflight; nothing was executed. Run preflight again')
    const bind: any = bindingsVerdict(ticket, { preconditions: { planDigest: syncPlanDigestInput(plan) }, counters: { indexEntries: ticket.indexEntries } })
    if (bind) return wfail('blocked', String(bind), 'The action to execute changed after preflight; nothing was executed. Run preflight again')
    if (plan.needsConfirm === true && a.confirmed !== true) return wfail('need-confirm', 'need-confirm', 'This action requires confirmation (the card states the consequences); confirm, then resend with confirmed:true', { decision: 'warn', confirm: ticket.confirm || null })
    const started: any = await startTask({ requestId: requestId || ticketId, op: plan.op, args: plan.taskArgs, cwd: cwd, confirm: true })
    if (!started || started.ok !== true) {
      if (started && started.error) return started
      return wfail('env', 'env', 'The long-running task channel returned no result; no process was started')
    }
    const out: any = {
      ok: true,
      action: action,
      ticketId: ticketId,
      command: String(plan.commandText || ''),
      level: String(plan.level || ''),
      task: started.task || null,
      reused: started.reused === true,
      atMs: now()
    }
    remember(requestId, out)
    return out
  }

  return { handleGitSyncWrite: handleGitSyncWrite, results: results }
}
