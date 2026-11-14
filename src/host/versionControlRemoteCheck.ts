/**
 * src/host/versionControlRemoteCheck.ts —— 远端四条写动作的预检签票与凭票复核（#1776 M4b，规格 #1586 域 8）
 *
 * 为什么有这一层：远端写动作（登记 / 改名 / 删除 / 改地址）在界面上是「先预检、弹确认卡、
 * 用户读几秒再点确认」。这几秒里仓库仍可能被终端里的命令改动：远端被删掉、地址被改、
 * 远端列表多了一条。没有票据的话，用户确认的是「刚才那张列表」，执行的却是「现在这张」。
 * 办法照贮藏写动作（versionControlStashTicket.ts）与 #841 的既有先例：预检把「这一次要动的
 * 远端与整张远端列表」量成绑定值写进票里；执行前用同一套口径重新读一遍再逐格比对，任何一格
 * 变了就零命令拒绝（stale-repo / target-changed），绝不猜。
 *
 * 票只活在宿主进程内存里：不落盘、不进日志；有效期是中央配置的 TICKET_TTL_MS（120 秒）。
 * 重放保护只做 requestId 去重：同一个 requestId 再来一次，直接回上次那份结果，不重复起进程；
 * 不采用「票用一次就烧掉」那套语义（与 write-ticket.ts 头注释同一口径）。
 *
 * 本文件只做判定，不起任何 git 进程：远端列表由装配方（versionControlRemote.ts）读好再传进来。
 * 这样「票过期 / 动作不符 / 没有票 / 没经过确认卡」这几种情况都能在读列表之前就拒绝。
 */
import { failPhone } from '../shared/version-control/exec-envelope.js'
import {
  remoteWriteActionOf,
  remoteNameProblem,
  remoteUrlProblem,
} from '../shared/version-control/src/remote.js'
import {
  bindingsVerdict,
  canonicalJson,
  hash16,
  makeTicket,
  requestIdProblem,
  ticketPureVerdict,
} from '../shared/version-control/src/write-ticket.js'
import { idShapeProblem } from '../shared/version-control/src/write-reasons.js'

/** 远端列表的绑定摘要：名字、fetch 地址、push 地址按名字排序后逐条拼起来。
 *  只收这三样：跟踪分支数是本地缓存，凭据标记是显示派生物，它们变化不该让票据失效。 */
function remoteListDigestOf(remotes: any[]): string {
  const rows: any[] = (remotes || []).map(function (one: any) {
    return { name: String((one && one.name) || ''), fetchUrl: String((one && one.fetchUrl) || ''), pushUrl: String((one && one.pushUrl) || '') }
  })
  rows.sort(function (a: any, b: any) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0) })
  return hash16(canonicalJson(rows))
}

/** 回包里的远端列表摘要（只给界面与门禁看，不含跟踪分支与凭据原文）。 */
function remoteSummaryOf(remotes: any[]): any[] {
  return (remotes || []).map(function (one: any) {
    return {
      name: String((one && one.name) || ''),
      fetchUrl: String((one && one.fetchUrl) || ''),
      pushUrl: String((one && one.pushUrl) || ''),
      hasCredential: !!(one && one.hasCredential),
    }
  })
}

function remoteOf(remotes: any[], name: string): any {
  for (let i = 0; i < (remotes || []).length; i += 1) if (String(remotes[i].name) === name) return remotes[i]
  return null
}

/**
 * 造远端票据层：预检签票、执行前复核。装配方注入时钟；不注入任何进程出口（本层不起进程）。
 * 票与 requestId 结果表住在这个闭包里，只活在宿主进程内存里。
 */
export function createRemoteTickets(deps: any): any {
  const tickets: Map<string, any> = new Map()
  const results: Map<string, any> = new Map()
  const now: any = function (): number { try { return typeof deps.nowMs === 'function' ? Number(deps.nowMs()) : Date.now() } catch (e) { return Date.now() } }

  /** 失败信封：沿用宿主既有形状 {ok:false,error:{kind,message}}，另带稳定 reason 供界面/门禁对账。 */
  function fail(kind: any, reason: any, message: any, hint?: any): any {
    const base: any = failPhone(kind, message)
    base.error.reason = String(reason || '')
    base.error.hint = String(hint || '')
    return base
  }

  /**
   * 把「动作 + 这次输入 + 此刻的远端列表」折成这一次要动的计划；同时做完目标门槛：
   * 名字/地址不合法、要登记的已经存在、要改名/删除/改地址的远端不在、改了等于没改，都在这里拒绝。
   * 计划会进票据的 target，执行前按同一函数重算并比摘要：列表里任何一条远端变了都会判 target-changed。
   */
  function planOf(action: string, input: any, remotes: any[]): any {
    const reg: any = remoteWriteActionOf(action)
    if (!reg) return { ok: false, fail: fail('args', 'remote-action', 'Unrecognised remote action: ' + String(action || ''), 'Choose one of the four actions: add, rename, delete or change URL.') }
    const a: any = input || {}
    if (action === 'add') {
      const name: string = String(a.name || '')
      const url: string = String(a.url || '')
      if (remoteNameProblem(name)) return { ok: false, fail: fail('args', 'remote-name', 'A remote name cannot be empty, start with a hyphen, or contain whitespace or control characters.', 'Use another name and retry.') }
      if (remoteUrlProblem(url)) return { ok: false, fail: fail('args', 'remote-url', 'The panel does not accept this URL (supported: https, http, ssh, git, file, local paths and git@host:path).', 'Check that the URL is complete and contains no whitespace.') }
      if (remoteOf(remotes, name)) return { ok: false, fail: fail('args', 'remote-exists', 'A remote named ' + name + ' already exists.', 'Delete or rename the existing remote, or use another name.') }
      return { ok: true, plan: { action: 'add', name: name, url: url } }
    }
    if (action === 'rename') {
      const from: string = String(a.from || '')
      const to: string = String(a.to || '')
      if (remoteNameProblem(from) || remoteNameProblem(to)) return { ok: false, fail: fail('args', 'remote-name', 'A remote name cannot be empty, start with a hyphen, or contain whitespace or control characters.', 'Use another name and retry.') }
      if (from === to) return { ok: false, fail: fail('args', 'remote-unchanged', 'The old and new names are the same; this rename has no effect.', 'Use a different new name and retry.') }
      const target: any = remoteOf(remotes, from)
      if (!target) return { ok: false, fail: fail('args', 'remote-missing', 'There is no remote named ' + from + '; it cannot be renamed.', 'Refresh the remote list and select again.') }
      return { ok: true, plan: { action: 'rename', from: from, to: to, fromUrl: String(target.fetchUrl || ''), fromPushUrl: String(target.pushUrl || '') } }
    }
    if (action === 'remove') {
      const name: string = String(a.name || '')
      if (remoteNameProblem(name)) return { ok: false, fail: fail('args', 'remote-name', 'A remote name cannot be empty, start with a hyphen, or contain whitespace or control characters.', 'Select a remote from the list and retry.') }
      const target: any = remoteOf(remotes, name)
      if (!target) return { ok: false, fail: fail('args', 'remote-missing', 'There is no remote named ' + name + '; it cannot be deleted.', 'Refresh the remote list and select again.') }
      return { ok: true, plan: { action: 'remove', name: name, url: String(target.fetchUrl || ''), pushUrl: String(target.pushUrl || '') } }
    }
    // setUrl
    const name: string = String(a.name || '')
    const url: string = String(a.url || '')
    if (remoteNameProblem(name)) return { ok: false, fail: fail('args', 'remote-name', 'A remote name cannot be empty, start with a hyphen, or contain whitespace or control characters.', 'Select a remote from the list and retry.') }
    if (remoteUrlProblem(url)) return { ok: false, fail: fail('args', 'remote-url', 'The panel does not accept this URL (supported: https, http, ssh, git, file, local paths and git@host:path).', 'Check that the URL is complete and contains no whitespace.') }
    const target: any = remoteOf(remotes, name)
    if (!target) return { ok: false, fail: fail('args', 'remote-missing', 'There is no remote named ' + name + '; its URL cannot be changed.', 'Refresh the remote list and select again.') }
    if (String(target.fetchUrl || '') === url && String(target.pushUrl || '') === url) return { ok: false, fail: fail('args', 'remote-unchanged', 'The new URL is the same as the current one; nothing changed.', 'Use a different URL and retry.') }
    return { ok: true, plan: { action: 'setUrl', name: name, oldUrl: String(target.fetchUrl || ''), oldPushUrl: String(target.pushUrl || ''), url: url } }
  }

  /** 预检签票：facts 是调用方刚读到的仓库根与远端列表（本层不自己起进程）。 */
  function issue(action: any, input: any, facts: any): any {
    const act: string = String(action || '')
    const reg: any = remoteWriteActionOf(act)
    if (!reg) return fail('args', 'remote-action', 'Unrecognised remote action; preflight was not started.', 'Choose one of the four actions: add, rename, delete or change URL.')
    const f: any = facts || {}
    const planOut: any = planOf(act, input, f.remotes || [])
    if (planOut.ok !== true) return planOut.fail
    const plan: any = planOut.plan
    const t0: number = now()
    const id: string = 'rt' + t0.toString(36) + Math.random().toString(36).slice(2, 8)
    const ticket: any = makeTicket({
      id: id,
      op: act as any,
      nowMs: t0,
      headOid: '',
      indexFingerprint: null,
      indexEntries: null,
      target: plan,
      repoRoot: String(f.root || ''),
      bindings: {
        preconditions: { planDigest: hash16(canonicalJson(plan)), worktreeDigest: remoteListDigestOf(f.remotes || []) },
        counters: { indexEntries: null },
      },
    })
    tickets.set(ticket.id, ticket)
    // 票只活在内存里，也要有上限：只保留最近两百张，避免长时间开着面板越攒越多。
    while (tickets.size > 200) {
      const first: any = tickets.keys().next()
      if (first.done) break
      tickets.delete(first.value)
    }
    return {
      ok: true,
      action: reg.action,
      command: reg.command,
      ticket: { id: ticket.id, op: ticket.op, checkedAtMs: ticket.checkedAtMs, expiresAtMs: ticket.expiresAtMs },
      plan: plan,
      remotes: remoteSummaryOf(f.remotes || []),
      readAtMs: typeof f.readAtMs === 'number' ? f.readAtMs : now(),
    }
  }

  /**
   * 执行前的纯判定：请求号形状、重放去重、票在不在、动作对不对、过期没有、有没有经过确认卡。
   * 这一关不碰任何进程；过了这一关才会去读远端列表、再走 confirmState。
   */
  function precheck(action: any, input: any): any {
    const a: any = input || {}
    const requestId: string = String(a.requestId || '')
    const ridProblem: any = requestIdProblem(requestId)
    if (ridProblem) return fail('usage', 'usage', 'Invalid request ID format: ' + requestId, 'Use a request ID containing only letters, digits, underscores or hyphens.')
    if (requestId && results.has(requestId)) return { ok: true, replay: results.get(requestId) }
    const ticketId: string = String(a.ticketId || a.ticket || '')
    const idProblem: any = idShapeProblem(ticketId)
    if (idProblem) return fail('confirm', 'ticket-missing', 'This write has no preflight credential; reopen the confirmation card and click again.', 'Successful preflight returns a ticket; the panel will not send a write without one.')
    if (a.confirmed !== true) return fail('confirm', 'not-confirmed', 'This write has not gone through the confirmation card, so the panel will not send it.', 'Confirm the preflight result first, then execute.')
    const ticket: any = tickets.get(ticketId) || null
    const pure: any = ticketPureVerdict(ticket, action as any, now())
    if (pure.ok !== true) {
      if (pure.reason === 'ticket-expired') return fail('stale', 'ticket-expired', 'This confirmation card has expired (over 120000 ms); run preflight again.', 'Click the original action again, then confirm the new ticket.')
      if (pure.reason === 'ticket-op-mismatch') return fail('confirm', 'ticket-op-mismatch', 'This confirmation card does not match the current action; run preflight again.', 'Click the original action again, then confirm the new ticket.')
      return fail('confirm', 'ticket-missing', 'This write has no preflight credential; reopen the confirmation card and click again.', 'Successful preflight returns a ticket; the panel will not send a write without one.')
    }
    return { ok: true, ticket: ticket }
  }

  /**
   * 执行前复核绑定状态：ticket 存在与否在 precheck 已判过；这里比仓库根与「远端列表摘要 + 这一次的计划摘要」。
   * fresh 由调用方在读一遍远端列表后传进来（本层不自己读）。
   */
  function confirmState(action: any, input: any, fresh: any): any {
    const a: any = input || {}
    const f: any = fresh || {}
    const ticket: any = tickets.get(String(a.ticketId || a.ticket || '')) || null
    if (!ticket) return fail('confirm', 'ticket-missing', 'This write has no preflight credential; reopen the confirmation card and click again.', 'Successful preflight returns a ticket; the panel will not send a write without one.')
    if (String(f.root || '') !== String(ticket.repoRoot || '')) return fail('stale', 'stale-repo', 'The repository at the working directory changed after confirmation; run preflight again.', 'Return to the original repository and retry.')
    const planOut: any = planOf(String(action || ''), a, f.remotes || [])
    if (planOut.ok !== true) return fail('stale', 'target-changed', 'The remote list changed after confirmation; this action was not executed. Run preflight again.', 'Refresh to view the latest list, then select again.')
    const current: any = {
      preconditions: { planDigest: hash16(canonicalJson(planOut.plan)), worktreeDigest: remoteListDigestOf(f.remotes || []) },
      counters: { indexEntries: null },
    }
    if (bindingsVerdict(ticket, current) !== null) {
      return fail('stale', 'target-changed', 'The remote list changed after confirmation; this action was not executed. Run preflight again.', 'Refresh to view the latest list, then select again.')
    }
    return { ok: true, ticket: ticket, plan: planOut.plan }
  }

  /** 成功回包按请求号记一份：同一个请求号再来一次直接回这份，不重复执行。
   *  失败回包不记：失败没有副作用，重试应当真的再走一遍预检/复核。 */
  function remember(requestId: any, reply: any): void {
    const rid: string = String(requestId || '')
    if (rid === '') return
    results.set(rid, reply)
    while (results.size > 200) {
      const first: any = results.keys().next()
      if (first.done) break
      results.delete(first.value)
    }
  }

  return {
    precheck: precheck,
    issue: issue,
    confirmState: confirmState,
    remember: remember,
    tickets: function (): Map<string, any> { return tickets },
    results: function (): Map<string, any> { return results },
  }
}
