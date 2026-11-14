/**
 * src/host/versionControlStashTicket.ts —— 贮藏写动作的预检凭票与重放去重（#1751 T16，规格 #1586 域 7）
 *
 * 为什么有这一层：贮藏的写动作（新建、只贮藏已暂存、应用、弹出、删除、清空、从贮藏建分支、
 * 恢复丢弃）在界面上的流程是「预检一张确认卡 → 用户读几秒 → 点确认」。这几秒里仓库仍可能被
 * 终端里的命令改动：别的贮藏被丢弃、目标 stashes/<n> 指向了另一条记录、HEAD 被切走、工作区
 * 变干净。没有票据的话，用户确认的是「刚才那条」，执行的却是「现在这条」。
 *
 * 办法照 #841/#1742 的既有先例：预检读真实现场并把「这次要动的那一条 / 那份清单 / 那个 HEAD /
 * 那个工作区形状」量成绑定值写进票里；执行时重读同一批事实逐格比对，任何一格变了就零命令拒绝
 * （target-changed / stale-head），绝不猜。票的有效期是中央配置的 TICKET_TTL_MS（120 秒）。
 *
 * 重放保护只做 requestId 去重：同一个 requestId 再来一次，直接回上次那份结果，不重复起进程；
 * 不采用「票用一次就烧掉」那种自创语义（与 write-ticket.ts 头注释同一口径）。
 *
 * 本文件不直接起 git 进程：读事实用装配处注入的 runPinned（只读命令），真正执行写动作交给
 * deps.exec —— 那是 versionControlStash.ts 的执行层，进程出口、日志包装、失败信封全在父文件那侧。
 */
import { failPhone, firstLine } from '../shared/version-control/exec-envelope.js'
import { checkRefArgs, stashListArgs } from '../shared/version-control/src/commands.js'
import { parseStashList } from '../shared/version-control/src/parse-stash.js'
import { capabilityAvailability } from '../shared/version-control/src/capabilities.js'
import { TICKET_TTL_MS } from '../shared/time-config/values.js'
import {
  makeTicket,
  ticketPureVerdict,
  bindingsVerdict,
  canonicalJson,
  hash16,
  requestIdProblem,
} from '../shared/version-control/src/write-ticket.js'
import { idShapeProblem } from '../shared/version-control/src/write-reasons.js'
import {
  STASH_VERSION_FLOOR,
  stashNeedsTicketOf,
  stashOpOf,
  vcStashMessageError,
  vcStashSelectorOk,
  vcStashBranchError,
  stashRestoreArgs,
} from '../shared/version-control/src/stash-rules.js'

/** 一条贮藏记录：与 parse-stash.ts 的解析结果同一形状。 */
interface StashEntry {
  selector: string
  oid: string
  atMs: number
  subject: string
}

/** 现场事实：预检量一次、执行前再量一次，两次用同一套口径才能比出「变没变」。 */
interface StashFacts {
  root: string
  entries: StashEntry[]
  listDigest: string
  head: string
  statusDigest: string
  hasChanges: boolean
}

/** 贮藏清单的绑定摘要：选择器与提交号按选择器排序后逐行拼起来。 */
function listDigestOf(entries: StashEntry[]): string {
  const lines: string[] = entries.map(function (one: StashEntry) { return one.selector + '\u0000' + one.oid })
  lines.sort()
  return hash16(lines.join('\n'))
}

/** 工作区形状的绑定摘要：HEAD、贮藏清单、git status 原始输出三者一起，任一条变了都算现场变了。 */
function worktreeDigestOf(facts: StashFacts): string {
  return hash16(canonicalJson({ head: facts.head, list: facts.listDigest, status: facts.statusDigest }))
}

/**
 * 造贮藏票据层：check 签票、write 凭票执行。装配处注入进程出口、仓库解析、时钟与真正执行层。
 * 票与 requestId 结果表住在这个闭包里，只活在宿主进程内存里，不落盘、不进日志。
 */
export function createStashTickets(deps: any): any {
  const tickets: Map<string, any> = new Map()
  const results: Map<string, any> = new Map()
  const now = function (): number { try { return typeof deps.nowMs === 'function' ? Number(deps.nowMs()) : Date.now() } catch (e) { return Date.now() } }
  const mkId = function (): string { return 'st' + now().toString(36) + Math.random().toString(36).slice(2, 8) }
  const runPinned: any = deps.runPinned
  const timeoutMs: number = Number(deps.timeoutMs) || 30000
  const stdoutLimit: number = Number(deps.stdoutLimit) || 8 * 1024 * 1024

  /** 失败信封：沿用宿主既有形状 {ok:false,error:{kind,message}}，另带稳定 reason 供界面/门禁对账。 */
  function fail(kind: any, reason: any, message: any, extra?: any): any {
    const base: any = failPhone(kind, message)
    base.error.reason = String(reason || '')
    if (extra) Object.assign(base, extra)
    return base
  }

  /** 跑一条只读命令并翻成 {ok:true,stdout} 或失败信封；非零退出不当作成功。 */
  async function readOut(exe: string, root: string, args: string[], limit?: number): Promise<any> {
    let res: any
    try { res = await runPinned(exe, root, args, { timeoutMs: timeoutMs, stdoutLimit: limit || stdoutLimit }) } catch (e) { return fail('env', 'unknown', 'The read-only command did not start a process: ' + firstLine(String((e && (e as any).message) || e))) }
    if (res && res.kind === 'ok') return { ok: true, stdout: String(res.stdout || ''), truncated: res.truncated === true }
    if (res && res.kind === 'non-zero') return fail('read', 'unknown', firstLine(res.stderr) || 'The read-only command exited with a non-zero exit code')
    return fail('read', 'unknown', firstLine(res && res.message) || 'The read-only command did not finish normally')
  }

  /** 解析仓库：找不到 git 或不是仓库都回明确失败信封（与执行层同一口径）。 */
  async function repoOf(cwd: string): Promise<any> {
    let exe: any = null
    try { exe = await deps.resolveGitExecutable() } catch (e) { exe = null }
    if (!exe) return fail('env', 'unknown', 'Cannot find git; stash records cannot be read.')
    const repo: any = await deps.resolveRepoRoot(exe, cwd)
    if (!repo || repo.ok !== true) return repo && repo.error ? repo : fail('not-repo', 'unknown', 'The current directory is not a git repository: ' + cwd)
    return { ok: true, exe: String(exe), root: String(repo.root) }
  }

  /** 读现场事实：贮藏清单、HEAD、工作区形状一次量齐。 */
  async function factsOf(exe: string, root: string): Promise<any> {
    const listed: any = await readOut(exe, root, stashListArgs())
    if (listed.ok !== true) return listed
    const parsed: any = parseStashList(String(listed.stdout || ''))
    if (!parsed.ok) return fail('read', 'unknown', 'Cannot read the stash list: ' + String(parsed.detail || parsed.error || 'Malformed format'))
    const entries: StashEntry[] = parsed.entries || []
    const headOut: any = await readOut(exe, root, ['rev-parse', '--verify', '-q', 'HEAD'], 64 * 1024)
    let head: string = ''
    if (headOut.ok === true) head = String(headOut.stdout || '').trim()
    else if (headOut.error && headOut.error.kind === 'read') head = 'none'
    else return headOut
    const statusOut: any = await readOut(exe, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    if (statusOut.ok !== true) return statusOut
    const raw: string = String(statusOut.stdout || '')
    const facts: StashFacts = { root: root, entries: entries, listDigest: listDigestOf(entries), head: head, statusDigest: hash16(raw), hasChanges: raw !== '' }
    return { ok: true, exe: exe, facts: facts }
  }

  /** 某个选择器当前指向哪一条：不在清单里回 null（预检与执行前的复核都靠它）。 */
  function entryOf(entries: StashEntry[], selector: string): StashEntry | null {
    for (let i = 0; i < entries.length; i += 1) if (entries[i].selector === selector) return entries[i]
    return null
  }

  /** 「只贮藏已暂存」的 2.35 版本门：预检与执行前各查一次，低版本一律拒绝（隐藏不等于静默，界面另有替代做法）。 */
  async function versionGate(exe: string, root: string): Promise<any> {
    const res: any = await readOut(exe, root, ['--version'], 64 * 1024)
    if (res.ok !== true) return res
    const versionText: string = String(res.stdout || '').trim()
    const avail: any = capabilityAvailability({ minVersion: '2.35', versionPolicy: 'hide', versionAlternative: 'g' }, versionText)
    if (avail.state === 'full') return { ok: true }
    return fail('version-hidden', 'version-hidden', 'This action requires git ' + String(avail.needed || '2.35') + ' or newer; current version: ' + (versionText || 'Unknown version') + '.', { needed: avail.needed, gitVersion: versionText })
  }

  /** 建分支前重做两道校验：名字合法（git 自己判）与名字仍然不存在（本地分支）。 */
  async function branchGate(exe: string, root: string, branch: string): Promise<any> {
    const bad: any = vcStashBranchError(branch)
    if (bad) return fail('branch', 'branch', 'Invalid branch name: ' + String(bad))
    const check: any = await runPinned(exe, root, checkRefArgs(branch), { timeoutMs: timeoutMs, stdoutLimit: 64 * 1024 })
    if (check.kind === 'non-zero') return fail('branch', 'branch', 'Invalid branch name: ' + branch)
    if (check.kind !== 'ok') return fail('env', 'unknown', 'Checking the branch name failed: ' + branch)
    const lookup: any = await runPinned(exe, root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], { timeoutMs: timeoutMs, stdoutLimit: 64 * 1024 })
    if (lookup.kind === 'ok') return { ok: true, exists: true }
    if (lookup.kind === 'non-zero' && Number(lookup.exitCode) === 1) return { ok: true, exists: false }
    return fail('env', 'unknown', 'Checking whether the branch exists failed: ' + branch)
  }

  /** 预检的动作输入校验：动作名、选择器、分支名、消息都在这里先拒一次，坏输入不签票。 */
  function inputVerdict(op: string, a: any): any {
    if (!stashNeedsTicketOf(op)) return fail('usage', 'usage', 'This action does not use a ticketed write: ' + op)
    const selector: string = String(a.selector || '')
    const def: any = stashOpOf(op)
    if (def && def.needsSelector && !vcStashSelectorOk(selector)) return fail('selector', 'selector', 'Invalid stash selector: ' + selector)
    if (def && def.needsMessage) {
      const msgProblem: any = vcStashMessageError(String(a.message || ''))
      if (msgProblem) return fail('message', 'message', 'Invalid stash message: ' + String(msgProblem))
    }
    if (op === 'branch') {
      const bad: any = vcStashBranchError(String(a.branch || ''))
      if (bad) return fail('branch', 'branch', 'Invalid branch name: ' + String(bad))
    }
    if (op === 'restore') {
      const built: any = stashRestoreArgs(a.subject, a.oid)
      if (!built.ok) return fail('usage', 'usage', 'Invalid stash-restore parameters: ' + String((built.error && built.error.message) || ''))
    }
    return null
  }

  /** 预检：读现场 → 判输入与可用性 → 签票。blocked 时也回现场（界面照样能画清单，只是按钮不可用）。 */
  async function handleCheck(args: any): Promise<any> {
    const a: any = args || {}
    const op: string = String(a.op || '')
    const cwd: string = String(a.cwd || deps.defaultCwd || '')
    const bad: any = inputVerdict(op, a)
    if (bad) return bad
    const repo: any = await repoOf(cwd)
    if (repo.ok !== true) return repo
    const read: any = await factsOf(repo.exe, repo.root)
    if (read.ok !== true) return read
    const facts: StashFacts = read.facts
    const selector: string = String(a.selector || '')
    const def: any = stashOpOf(op)
    const plan: any = { op: op, selector: '', oid: '', branch: '', message: String(a.message || '') }

    if (def && def.needsSelector) {
      const found: StashEntry | null = entryOf(facts.entries, selector)
      if (!found) return fail('stash-missing', 'stash-missing', 'This stash record does not exist (it may have been dropped): ' + selector, { entries: facts.entries })
      plan.selector = selector
      plan.oid = found.oid
    }
    if (op === 'restore') {
      plan.oid = String(a.oid || '')
      plan.selector = String(a.selector || '')
    }
    if (op === 'branch') {
      plan.branch = String(a.branch || '')
      const gate: any = await branchGate(repo.exe, repo.root, plan.branch)
      if (gate.ok !== true) return gate
      if (gate.exists) return fail('branch-exists', 'branch-exists', 'This branch name already exists: ' + plan.branch, { branch: plan.branch })
    }
    if (op === 'push-staged') {
      const gate: any = await versionGate(repo.exe, repo.root)
      if (gate.ok !== true) return gate
      const staged: any = await readOut(repo.exe, repo.root, ['diff', '--cached', '--name-only', '-z'])
      if (staged.ok !== true) return staged
      if (String(staged.stdout || '') === '') return fail('nothing', 'nothing-to-do', 'There are no staged changes to stash.', { entries: facts.entries })
    }
    if (op === 'push' || op === 'push-untracked') {
      if (!facts.hasChanges) return fail('nothing', 'nothing-to-do', 'There are no changes to stash.', { entries: facts.entries })
      if (op === 'push-untracked') {
        const others: any = await readOut(repo.exe, repo.root, ['ls-files', '--others', '--exclude-standard', '-z'])
        if (others.ok !== true) return others
        if (String(others.stdout || '') === '') return fail('nothing', 'nothing-to-do', 'There are no untracked files to stash.', { entries: facts.entries })
      }
    }
    if ((op === 'drop' || op === 'clear') && facts.entries.length === 0) {
      return fail('nothing', 'nothing-to-do', 'The stash list is empty.', { entries: facts.entries })
    }

    const planDigest: string = hash16(canonicalJson(plan))
    const ticket: any = makeTicket({
      id: mkId(),
      // 贮藏九条动作名走同一套票据机制，但共享层 WriteOp 联合类型目前只列提交/拉取/推送/抓取与改动页动作；
      // 这里按任意字符串入票（扩联合要连带改七个登记点门禁与跨票评审，留给后续票）。
      op: op as any,
      nowMs: now(),
      headOid: facts.head,
      indexFingerprint: null,
      indexEntries: null,
      target: plan,
      repoRoot: facts.root,
      bindings: { preconditions: { planDigest: planDigest, worktreeDigest: worktreeDigestOf(facts) }, counters: { indexEntries: null } },
    })
    tickets.set(ticket.id, ticket)
    if (tickets.size > 200) { const oldest: any = tickets.keys().next().value; tickets.delete(oldest) }
    return {
      ok: true,
      op: op,
      atMs: ticket.checkedAtMs,
      ticket: { id: ticket.id, op: ticket.op, checkedAtMs: ticket.checkedAtMs, expiresAtMs: ticket.expiresAtMs },
      entries: facts.entries,
      plan: plan,
      facts: { head: facts.head, listDigest: facts.listDigest, hasChanges: facts.hasChanges },
    }
  }

  /** 凭票执行：requestId 重放 → 票与动作形状 → 过期 → 仓库 → 现场逐格重验 → 执行。写命令只在最后一步起。 */
  async function handleWrite(args: any): Promise<any> {
    const a: any = args || {}
    const op: string = String(a.op || '')
    const requestId: string = String(a.requestId || '')
    const ridProblem: string | null = requestIdProblem(requestId)
    if (ridProblem) return fail('usage', 'usage', 'Invalid request ID format: ' + requestId)
    if (requestId !== '' && results.has(requestId)) return results.get(requestId)
    // 读动作（list / show）不签票也不拦：直接交给执行层，与加票据层之前的行为一模一样；
    // 写动作才要求凭票。这样界面上的只读刷新不会被票据流程误伤。
    if (!stashNeedsTicketOf(op)) {
      const readReply: any = await deps.exec({ op: op, cwd: String(a.cwd || deps.defaultCwd || ''), selector: String(a.selector || ''), branch: '', message: '', oid: '', subject: '', confirm: false })
      if (requestId !== '') { results.set(requestId, readReply); if (results.size > 200) { const oldOne: any = results.keys().next().value; results.delete(oldOne) } }
      return readReply
    }
    const ticketId: string = String(a.ticketId || a.ticket || '')
    const idProblem: string | null = idShapeProblem(ticketId)
    if (idProblem) return fail('confirm', 'ticket-missing', 'This write has no preflight credential; reopen the confirmation card and click again.')
    const ticket: any = tickets.get(ticketId)
    const pure: any = ticketPureVerdict(ticket, op as any, now())
    if (!pure.ok) {
      const isExpired: boolean = pure.reason === 'ticket-expired'
      return fail(isExpired ? 'stale' : 'confirm', pure.reason, isExpired ? 'This confirmation card has expired (over ' + String(TICKET_TTL_MS) + ' ms); run preflight again.' : 'This confirmation card does not match the current action; run preflight again.')
    }
    const cwd: string = String(a.cwd || deps.defaultCwd || '')
    const repo: any = await repoOf(cwd)
    if (repo.ok !== true) return repo
    if (String(repo.root) !== String(ticket.repoRoot || '')) return fail('stale', 'stale-repo', 'The repository at the working directory changed after confirmation; run preflight again.')
    const read: any = await factsOf(repo.exe, repo.root)
    if (read.ok !== true) return read
    const facts: StashFacts = read.facts
    const plan: any = ticket.target || {}
    if (String(ticket.headOid || '') !== facts.head) return fail('stale', 'stale-head', 'HEAD changed after confirmation; run preflight again.')
    // 比对两格：计划摘要（要动的那一条/那个分支名）与工作区形状。两格都要给，缺一格会被当成「对不上」。
    const changed: string | null = bindingsVerdict(ticket, { preconditions: { planDigest: hash16(canonicalJson(plan)), worktreeDigest: worktreeDigestOf(facts) }, counters: { indexEntries: null } })
    if (changed === 'target-changed') return fail('stale', 'target-changed', 'The stash list or workspace changed after confirmation; run preflight again.')
    if (plan.selector) {
      const found: StashEntry | null = entryOf(facts.entries, String(plan.selector))
      if (!found) return fail('stale', 'target-changed', 'The target stash record no longer exists; run preflight again.')
      if (String(found.oid) !== String(plan.oid || '')) return fail('stale', 'target-changed', 'This stash record\'s commit ID changed after confirmation; run preflight again.')
    }
    if (plan.branch) {
      const gate: any = await branchGate(repo.exe, repo.root, String(plan.branch))
      if (gate.ok !== true) return gate
      if (gate.exists) return fail('stale', 'target-changed', 'This branch name was just taken; choose another name and run preflight again.')
    }
    if (op === 'push-staged') {
      const gate: any = await versionGate(repo.exe, repo.root)
      if (gate.ok !== true) return gate
    }
    const reply: any = await deps.exec({
      op: op,
      cwd: cwd,
      selector: String(plan.selector || ''),
      branch: String(plan.branch || ''),
      message: String(plan.message || ''),
      oid: String(plan.oid || ''),
      subject: String(a.subject || ''),
      confirm: true,
    })
    if (requestId !== '') {
      results.set(requestId, reply)
      if (results.size > 200) { const oldest: any = results.keys().next().value; results.delete(oldest) }
    }
    return reply
  }

  return { check: handleCheck, write: handleWrite, tickets: tickets, results: results }
}
