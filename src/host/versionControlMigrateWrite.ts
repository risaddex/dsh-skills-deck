/**
 * src/host/versionControlMigrateWrite.ts —— 迁移与备份域的凭票执行层（#1759 T23）。
 *
 * 判定顺序与分支、同步两域一致：
 *   requestId 重放 → 票号形状 → 请求号形状 → 票据存在 → 动作相符 → 票据新鲜度 → 需确认动作是否带确认 →
 *   重算现场（仓库根、HEAD、票据里登记为「预检时不存在」的路径当前仍不存在）→ 只执行一次。
 *
 * init 不进长任务通道（它只是一次快速的 git init，没有进度可看）；其余动作一律交给 #1740 的长任务通道，
 * 连进程都不在本文件里起。fast-import 是唯一碰标准输入的动作：先建新目录、git init，再把预检核对过的
 * 文件（路径、大小、sha256 都在票据里）作为 stdinFile 交给任务通道。
 */
import { ticketPureVerdict, requestIdProblem } from '../shared/version-control/src/write-ticket.js'
import { failPhone, failureFromExec } from '../shared/version-control/exec-envelope.js'
import { migrateActionOf } from '../shared/version-control/src/migrate-actions.js'
import { VC_BRANCH_READ_TIMEOUT_MS as READ_TIMEOUT_MS } from '../shared/time-config/src/values.js'

export const MIGRATE_WRITE_SOURCE = 'src/host/versionControlMigrateWrite.ts'

function failWith(failPhoneFn: any, kind: string, reason: string, message: string): any {
  return failPhoneFn(kind, message, { reason: reason })
}

// 票据里的「目录里有哪些东西」摘要：与预检同一口径，目录变化就拒票。
function listingDigest(entries: string[]): string {
  const sorted = entries.slice().sort()
  return 'dir:' + sorted.length + ':' + sorted.join('|')
}

export function createMigrateWrite(deps: any): any {
  const failPhoneFn: any = deps.failPhone
  const nowMs: any = (typeof deps.now === 'function') ? deps.now : Date.now
  const measure: any = deps.measure
  const tickets: Map<string, any> = deps.tickets
  const results: Map<string, any> = deps.results
  const startTask: any = deps.startTask
  const probe: any = deps.probe
  const resolveGitExecutable: any = deps.resolveGitExecutable
  const runPinned: any = deps.runPinned
  const records = results

  function fail(kind: string, reason: string, message: string): any {
    return failWith(failPhoneFn, kind, reason, message)
  }
  function remember(key: string, value: any): void { if (records.size > 500) { const first = records.keys().next(); if (!first.done) records.delete(first.value) } records.set(key, value) }
  function idShapeProblem(value: any): boolean { return typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value) }

  async function verifyInit(plan: any, ticket: any): Promise<any> {
    const stat: any = await probe.stat(plan.path)
    if (stat === null) return { ok: false, reason: 'env' }
    const boundAbsent: string[] = (ticket.bindings && ticket.bindings.preconditions && ticket.bindings.preconditions.pathAbsent) || []
    if (boundAbsent.indexOf(plan.path) >= 0) {
      if (stat.exists) return { ok: false, reason: 'target-changed', message: 'Content appeared at this path before execution; confirm again' }
      return { ok: true, snapshot: { entries: [] } }
    }
    if (!stat.exists || stat.isDirectory !== true) return { ok: false, reason: 'target-changed', message: 'The destination directory was deleted or replaced by a file before execution; confirm again' }
    const entries: any = await probe.list(plan.path)
    if (entries === null) return { ok: false, reason: 'env' }
    if (listingDigest(entries) !== String((ticket.bindings && ticket.bindings.preconditions && ticket.bindings.preconditions.worktreeDigest) || '')) return { ok: false, reason: 'target-changed', message: 'The destination directory contents changed before execution; confirm again' }
    return { ok: true, snapshot: { entries: entries } }
  }

  async function handleGitMigrateWrite(args: any): Promise<any> {
    const a = args || {}
    const done = typeof a.requestId === 'string' && records.has(a.requestId) ? records.get(a.requestId) : null
    if (done) return { ok: true, reused: true, result: done }
    if (idShapeProblem(a.ticketId)) return fail('args', 'bad-target', 'Invalid ticket ID format; no git process was started')
    if (typeof a.requestId === 'string' && a.requestId !== '' && requestIdProblem(a.requestId)) return fail('args', 'bad-request-id', 'Request IDs may contain only letters, digits, underscores and hyphens, up to 64 characters')
    const ticket: any = tickets.get(String(a.ticketId || ''))
    if (!ticket) return fail('blocked', 'ticket-missing', 'This ticket does not exist or expired and was cleared; run preflight again. No git process was started')
    const plan: any = ticket.target || {}
    const entry = migrateActionOf(a.action)
    if (entry === null || plan.action !== entry.action) return fail('args', 'ticket-op-mismatch', 'The ticket\'s action differs from this request; no git process was started')
    const pure: any = ticketPureVerdict(ticket, plan.op as any, nowMs())
    if (!pure.ok) return fail('blocked', pure.reason || 'ticket-expired', pure.message || 'The ticket has expired; run preflight again')
    if (plan.needsConfirm === true && a.confirmed !== true) return fail('blocked', 'need-confirm', 'Confirm this action on the confirmation card, then execute it again')
    const exe: any = await resolveGitExecutable()
    if (!exe) return fail('env', 'no-git', 'Cannot find git (platform.resolveExecutable("git") returned no path)')
    let workRoot = String(plan.path || '')
    if (plan.action === 'init') {
      const check: any = await verifyInit(plan, ticket)
      if (!check.ok) return fail('blocked', check.reason, check.message || 'The target state changed before execution; confirm again')
      const argv: any[] = ['init']
      if (plan.bare === true) argv.push('--bare')
      if (plan.initMode === 'initial-branch') argv.push('--initial-branch=' + plan.branch)
      argv.push(plan.path)
      const res: any = await runPinned(exe, plan.path, argv, { stdoutLimit: 256 * 1024, timeoutMs: READ_TIMEOUT_MS })
      const bad: any = failureFromExec(res, 'Initialising the repository')
      if (bad) return bad
      if (plan.initMode !== 'initial-branch') {
        const rename: any = await runPinned(exe, plan.path, ['symbolic-ref', 'HEAD', 'refs/heads/' + plan.branch], { stdoutLimit: 8192, timeoutMs: READ_TIMEOUT_MS })
        const badRename: any = failureFromExec(rename, 'Renaming the initial branch')
        if (badRename) return badRename
      }
      const result: any = { ok: true, action: plan.action, ticketId: ticket.id, command: plan.commandText, level: plan.level, init: { path: plan.path, branch: plan.branch, mode: plan.initMode, created: true }, atMs: nowMs() }
      if (typeof a.requestId === 'string' && a.requestId !== '') remember(a.requestId, result)
      return result
    }
    // 仓库内动作：先重算现场，再只执行一次。
    const cur: any = await measure(String(a.cwd || ''))
    if (!cur || cur.ok !== true) return cur && cur.envelope ? cur.envelope : fail('env', 'measure-failed', 'Failed to recompute repository state; no write process was started')
    if (String(ticket.repoRoot || '') !== String(cur.root || '')) return fail('blocked', 'stale-repo', 'This ticket was issued for another repository; no git process was started')
    if (String(ticket.headOid || '') !== '' && String(ticket.headOid) !== String(cur.headOid || '')) return fail('blocked', 'stale-head', 'HEAD changed after preflight; run preflight again. No git process was started')
    const absent: string[] = plan.pathAbsent || []
    for (let i = 0; i < absent.length; i = i + 1) {
      const stat: any = await probe.stat(absent[i])
      if (stat === null) return fail('env', 'path-unreadable', 'Cannot read the path state; no write process was started')
      if (stat.exists) return fail('blocked', 'target-changed', 'Paths absent during preflight but present now: ' + absent[i] + '; nothing was overwritten. Run preflight again')
    }
    workRoot = String(cur.root || '')
    if (plan.action === 'fast-import') {
      const made: any = await probe.makeDir(plan.targetPath)
      if (made === null || made.ok !== true) return fail('env', 'mkdir-failed', 'Failed to create the import destination directory: ' + String((made && made.message) || 'The file service gave no reason'))
      const initRes: any = await runPinned(exe, plan.targetPath, ['init'], { stdoutLimit: 256 * 1024, timeoutMs: READ_TIMEOUT_MS })
      const badInit: any = failureFromExec(initRes, 'Running git init for the new repository')
      if (badInit) return badInit
      if (plan.branch !== '' && plan.branch !== 'main' && plan.branch !== 'master') {
        const rename: any = await runPinned(exe, plan.targetPath, ['symbolic-ref', 'HEAD', 'refs/heads/' + plan.branch], { stdoutLimit: 8192, timeoutMs: READ_TIMEOUT_MS })
        const badRename: any = failureFromExec(rename, 'Renaming the initial branch')
        if (badRename) return badRename
      }
      const started: any = await startTask({ requestId: typeof a.requestId === 'string' && a.requestId !== '' ? a.requestId : ticket.id, op: 'fast-import', args: {}, cwd: plan.targetPath, confirm: true, stdinFile: plan.input })
      if (!started || started.ok !== true) return started
      const result: any = { ok: true, action: plan.action, ticketId: ticket.id, command: plan.commandText, level: plan.level, task: started.task, targetPath: plan.targetPath, init: { path: plan.targetPath, branch: plan.branch, mode: 'initial-branch', created: true }, atMs: nowMs() }
      if (typeof a.requestId === 'string' && a.requestId !== '') remember(a.requestId, result)
      return result
    }
    const started: any = await startTask({ requestId: typeof a.requestId === 'string' && a.requestId !== '' ? a.requestId : ticket.id, op: plan.op, args: plan.taskArgs, cwd: workRoot, confirm: true })
    if (!started || started.ok !== true) return started
    const result: any = { ok: true, action: plan.action, ticketId: ticket.id, command: plan.commandText, level: plan.level, task: started.task, path: plan.outputPath || plan.inputPath || '', atMs: nowMs() }
    if (typeof a.requestId === 'string' && a.requestId !== '') remember(a.requestId, result)
    return result
  }

  return { handleGitMigrateWrite: handleGitMigrateWrite, tickets: tickets, results: results }
}
