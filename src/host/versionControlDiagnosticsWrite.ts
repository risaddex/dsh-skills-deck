/**
 * src/host/versionControlDiagnosticsWrite.ts —— 诊断域与替换对象的凭票执行叶子（#1761 T25）
 *
 * 为什么要票：二分五步与替换对象两条都会改仓库状态（.git/BISECT_* 与 refs/replace/*）。
 * 预检签一张票记下「动作计划 + 现场摘要 + HEAD」，这里拿同一张票表，执行前重算现场逐格比对：
 * 票不在、动作换过、票过期、仓库换了、HEAD 漂了、二分状态或替换清单变了——一律零进程拒绝。
 * 同一 requestId 重放回同一份结果，不再起第二次进程（网络与终端都可能让界面重发一次）。
 *
 * argv 只按票里的计划重拼（diagnosticsWriteArgvOf），客户端再送一遍参数也不采信；
 * 每个元素独立、不经 shell、不加固定前缀（前缀与 -C 钉仓库在注入的 runPinned 里）。
 */
import { diagnosticsWriteArgvOf, DIAGNOSTICS_WRITE_OPS } from '../shared/version-control/src/diagnostics-commands.js'
import { ticketPureVerdict, requestIdProblem, bindingsVerdict } from '../shared/version-control/src/write-ticket.js'
import { writeHintFor, idShapeProblem } from '../shared/version-control/src/write-reasons.js'
import { VC_DIAGNOSTICS_WRITE_TIMEOUT_MS as WRITE_TIMEOUT_MS } from '../shared/time-config/src/values.js'

/** 写命令的输出上限：bisect 与 replace 都只回一行状态，给 1 MB 足够。 */
const WRITE_LIMIT: number = 1024 * 1024

/** 执行失败时按动作给一句人话，说明这一步在做什么。 */
const STEP_TEXT: Record<string, string> = {
  'bisect-start': 'Start bisect', 'bisect-bad': 'Mark bad commit', 'bisect-good': 'Mark good commit',
  'bisect-skip': 'Skip this commit', 'bisect-reset': 'End bisect', 'replace-create': 'Create replacement', 'replace-delete': 'Remove replacement',
}
function stepOf(op: string): string { return STEP_TEXT[op] || 'This diagnostic action' }

/** 失败原因标识符 → 给人看的原因句（与界面词表分开：这里是执行层的排查说明）。 */
const CAUSE_TEXT: Record<string, string> = {
  'already-bisecting': 'A bisect is already running in this repository',
  'not-bisecting': 'No bisect is in progress in this repository',
  'not-a-commit': 'The commit ID or object name cannot be resolved to a commit',
  'already-replaced': 'This object already has a replacement record',
  'no-replace': 'This object has no replacement to remove',
  'no-permission': 'File permissions prevent writing records in .git',
  'not-a-repo': 'This directory is not inside a git repository',
  'unknown-write-failure': 'Git\'s message does not match a known failure category',
}
function causeOf(reason: string): string { return CAUSE_TEXT[reason] || 'Unclassified failure' }

/** 失败话术：票据那几类理由与共享层同一份写法（writeHintFor），诊断自己的理由给一句本地说明。 */
const DIAG_HINTS: Record<string, string> = {
  'already-bisecting': 'Finish this bisect before starting another',
  'not-bisecting': 'Start a bisect before marking good and bad commits',
  'not-a-commit': 'Check the commit ID or object name',
  'already-replaced': 'Remove the old replacement before creating a new one',
  'no-replace': 'List replacements first to confirm which object to remove',
  'unknown-write-failure': 'Retry once; if it still fails, inspect the git.exec exit code and error class in the diagnostic log',
}
function hintOf(reason: string): string { return DIAG_HINTS[reason] || writeHintFor(reason) }

/** 把 git 原话归进固定的失败类别；归类只认明确的说法，猜不到就如实记 unknown-write-failure。 */
function classifyFailure(argv0: string, exitCode: number, stderrText: string): string {
  const s: string = String(stderrText || '')
  if (/already a bisect|already in a bisect|a bisect session is already/i.test(s)) return 'already-bisecting'
  if (/We are not bisecting|You need to start by|not currently bisecting/i.test(s)) return 'not-bisecting'
  if (/could not lookup|bad revision|unknown revision|not a valid object|bad object|not a valid commit|fatal: ambiguous/i.test(s)) return 'not-a-commit'
  if (/not a git repository/i.test(s)) return 'not-a-repo'
  if (/permission denied|unable to create|unable to write|could not open/i.test(s)) return 'no-permission'
  return 'unknown-write-failure'
}

function firstLineOf(text: any): string { const t: string = String(text === undefined || text === null ? '' : text).replace(/\r/g, '').trim(); if (!t) return 'Git gave no explanation'; const i: number = t.indexOf('\n'); return (i >= 0 ? t.slice(0, i) : t).slice(0, 300) }

/** 造诊断域执行电话：票据表与结果表由装配处从预检叶子递进来，两边必须是同一张表。 */
export function createDiagnosticsWrite(deps: any): any {
  const d: any = deps || {}
  const failPhone: any = d.failPhone
  const failureFromExec: any = d.failureFromExec
  const runPinned: any = d.runPinned
  const resolveGitExecutable: any = d.resolveGitExecutable
  const measure: any = d.measure
  const nowFn: any = (typeof d.now === 'function') ? d.now : Date.now
  const tickets: Map<string, any> = (d.tickets instanceof Map) ? d.tickets : new Map()
  const results: Map<string, any> = (d.results instanceof Map) ? d.results : new Map()

  function wfail(kind: string, reason: string, message: string, extra?: any): any {
    return Object.assign({ ok: false, error: { kind: kind, reason: reason, message: message, hint: hintOf(reason) }, reason: reason }, extra || {})
  }
  function remember(requestId: any, out: any): void {
    results.set(String(requestId), out)
    while (results.size > 500) { const oldest: any = results.keys().next(); if (oldest.done) break; results.delete(oldest.value) }
  }
  function fieldsOf(plan: any): any {
    if (plan.op === 'bisect-start') return { bad: plan.bad, good: plan.good }
    if (plan.op === 'replace-create') return { from: plan.from, to: plan.to }
    if (plan.op === 'replace-delete') return { object: plan.object }
    if (plan.op === 'bisect-reset') return { active: false }
    return { active: true }
  }

  /** 凭票执行：所有拒绝都发生在起进程之前；真正起进程只有最后那一次。 */
  async function handleGitDiagnosticsWrite(args: any): Promise<any> {
    const a: any = args || {}
    if (a.requestId !== undefined && results.has(String(a.requestId))) return { ok: true, reused: true, result: results.get(String(a.requestId)) }
    const idBad: any = idShapeProblem(a.ticketId)
    if (idBad) return wfail('args', idBad, 'Invalid ticket ID format; it must come from preflight')
    const ridBad: any = requestIdProblem(a.requestId)
    if (ridBad) return wfail('args', ridBad, 'Invalid request ID: only letters, digits, underscores and hyphens are allowed')
    const ticket: any = tickets.get(String(a.ticketId)) || null
    if (!ticket) return wfail('blocked', 'ticket-missing', 'This ticket is not in host memory; run preflight and confirm again')
    const op: string = String(ticket.op || '')
    if (a.op !== undefined && String(a.op) !== op) return wfail('blocked', 'ticket-op-mismatch', 'This ticket was not issued for this action; run preflight again')
    if (DIAGNOSTICS_WRITE_OPS.indexOf(op) < 0) return wfail('args', 'bad-target', 'The ticket\'s action is not in the diagnostic action list')
    const pure: any = ticketPureVerdict(ticket, op as any, nowFn())
    if (!pure || pure.ok !== true) return wfail('blocked', (pure && pure.reason) || 'ticket-missing', 'This ticket has expired or does not match; run preflight again')
    if (ticket.confirmRequired === true && a.confirmed !== true) return wfail('blocked', 'need-confirm', 'This action changes repository state; confirm on the confirmation card first')
    const cwd: any = a.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') return wfail('args', 'bad-target', 'The execution repository is unspecified; supply the directory returned by the gateway')
    const cur: any = await measure(cwd, ticket.plan)
    if (!cur || cur.ok !== true) return cur || failPhone('env', 'Failed to recheck repository state before execution; no reason was given')
    if (String(cur.repoRoot) !== String(ticket.repoRoot)) return wfail('blocked', 'stale-repo', 'The ticket\'s repository differs from the current one; run preflight again')
    if (String(cur.headOid) !== String(ticket.headOid)) return wfail('blocked', 'target-changed', 'HEAD changed after preflight; run preflight again')
    const bindBad: any = bindingsVerdict(ticket, cur.bindings)
    if (bindBad) return wfail('blocked', bindBad, 'Repository state changed after preflight (bisect record or replacement list differs); run preflight again')
    const argv: string[] = diagnosticsWriteArgvOf(ticket.plan)
    const exe: any = await resolveGitExecutable()
    if (!exe) return failPhone('env', 'Cannot find git (platform.resolveExecutable("git") returned no path)')
    const res: any = await runPinned(exe, cur.repoRoot, argv, { stdoutLimit: WRITE_LIMIT, timeoutMs: WRITE_TIMEOUT_MS })
    if (!res || res.kind !== 'ok') {
      if (res && res.kind === 'non-zero') {
        const reason: string = classifyFailure(argv[0], Number(res.exitCode), String(res.stderr || ''))
        const says: string = firstLineOf(res.stderr)
        return wfail('git-failed', reason, stepOf(op) + ': failed; git reported: "' + says + '"', { git: says, step: stepOf(op), expected: 'Git writes this diagnostic record as planned', actual: 'Git refused this write (exit code ' + String(res.exitCode) + ')', cause: causeOf(reason), exitCode: Number(res.exitCode), decision: ticket.decision, argv: argv })
      }
      const bad: any = failureFromExec(res, stepOf(op) + ': this command')
      return bad || failPhone('env', stepOf(op) + ': did not finish and gave no reason')
    }
    const out: any = Object.assign({ ok: true, op: op, command: argv.slice(0, 2).join(' '), argv: argv, ticketId: ticket.id, decision: ticket.decision, atMs: nowFn() }, fieldsOf(ticket.plan))
    remember(a.requestId, out)
    return out
  }

  return { handleGitDiagnosticsWrite: handleGitDiagnosticsWrite, tickets: tickets, results: results }
}
