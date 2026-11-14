/**
 * src/host/versionControlMaintenanceCheck.ts —— 维护动作的预检签票与只读电话（#1758 T22，规格 #1586 域 11）
 *
 * 为什么单独一叶：维护动作要在动手前把「这个仓库现在是什么样、版本够不够、备份放哪、会删多少」
 * 一次读完并钉在票据里；执行层凭票再验一次现场，任何一格变了就零进程拒绝。
 * 本文件只签票、不执行：真正起任务或起本地维护命令在 versionControlMaintenanceWrite.ts。
 *
 * 铁律（改之前先读）：
 *   1. 票据只证明预检结论新鲜（120 秒），不管执行时长；长任务本身走任务通道，不占票据时限。
 *   2. 危险动作（清除不可达对象）必须先给出备份计划、并把「删了就找不回」写进确认卡；
 *      备份是否成功由执行层在动手前实测，预检只把计划和路径钉进票里。
 *   3. 版本不够的动作直接拒绝并说明替代做法，不签一张注定失败的命令票。
 */
import { failPhone } from '../shared/version-control/exec-envelope.js'
import { makeTicket } from '../shared/version-control/src/write-ticket.js'
import { humanBytesOf } from '../shared/version-control/src/recovery-point.js'
import {
  MAINTENANCE_CHECK_CONTRACT,
  MAINTENANCE_CHECK_VERSION,
  MAINTENANCE_VERSION_HIDE,
  maintenancePlanOf,
  maintenanceWriteOpOf,
  maintenanceSceneProblem,
  maintenanceVersionProblem,
  maintenanceRequiresBackupOf,
} from '../shared/version-control/src/maintenance-ops.js'

/** 票表上限：超过就删最旧的一张，免得长时间开着面板把内存攒成一个仓库历史。 */
const TICKET_MAX: number = 200

/** 造预检层；依赖全部由装配壳显式传入。 */
export function createMaintenanceCheck(deps: any): any {
  const read: any = deps.read
  const tickets: Map<string, any> = new Map()
  const results: Map<string, any> = new Map()
  const now = function (): number { try { return typeof deps.now === 'function' ? Number(deps.now()) : Date.now() } catch (e) { return Date.now() } }
  const nextId = function (): string { try { return String(deps.randomId()) } catch (e) { return 'm' + Math.random().toString(36).slice(2, 12) } }

  /** 失败信封：与其它页同一形状，reason 同时写进 error 与顶层。 */
  function fail(kind: any, reason: any, message: any, extra?: any): any {
    const base: any = failPhone(kind, message)
    base.error.reason = String(reason || '')
    base.reason = String(reason || '')
    if (extra) Object.assign(base, extra)
    return base
  }

  /** 拒绝信封：带上契约、动作与决策，界面据此画「为什么不让做」。 */
  function blocked(op: string, reason: string, message: string, extra?: any): any {
    const out: any = fail('blocked', reason, message)
    out.contract = MAINTENANCE_CHECK_CONTRACT
    out.version = MAINTENANCE_CHECK_VERSION
    out.op = op
    out.decision = { verdict: 'block', reasons: [reason] }
    out.reasons = [reason]
    out.readAtMs = now()
    if (extra) Object.assign(out, extra)
    return out
  }

  /** 界面/票据用的一句话现场摘要：不把整个 screen 塞进回包。 */
  function sceneSummaryOf(scene: any): any {
    return {
      repoRoot: scene.repoRoot,
      repoName: scene.repoName,
      headOid: scene.headOid,
      branch: scene.branch,
      gitVersion: scene.gitVersion,
      objects: scene.objects,
      maintenance: scene.maintenance,
      repoSizeBytes: scene.repoSizeBytes,
      freeBytes: scene.freeBytes,
      operation: scene.operation,
      dirty: scene.dirty,
      readAtMs: scene.readAtMs,
    }
  }

  /** 四段确认卡：做什么、不做什么、能不能恢复、按下去会发生什么。 */
  function confirmOf(op: string, scene: any, extra: any): any {
    const name: string = scene.repoName || scene.repoRoot
    if (op === 'prune') {
      const preview: any = extra.preview || {}
      const backup: any = extra.backup || {}
      const when: string = preview.earliestAtMs ? new Date(Number(preview.earliestAtMs)).toISOString() : 'Time unavailable (object is packed)'
      return {
        what: 'From "' + name + '", delete ' + String(preview.count || 0) + ' unreachable objects (oldest: ' + when + '). No ref or reflog points to them; deletion is irreversible. A full-repository backup will first be made at ' + String(backup.path || '') + ' (' + (backup.kind === 'bundle' ? 'full repository bundle' : 'mirror clone') + ', approximately ' + humanBytesOf(Number(backup.estimateBytes) || 0) + ').',
        wont: 'Commits protected by refs or reflogs are kept; history is not rewritten. Backup restoration steps are provided, but the panel does not restore automatically.',
        reversible: false,
        verb: 'Backup runs first; cleanup starts only after it succeeds. If backup fails, cleanup stops without deleting any objects.',
        command: 'git prune',
        backup: backup,
        preview: preview,
      }
    }
    if (op === 'gc') {
      return {
        what: 'For "' + name + '", run garbage collection: pack loose objects and remove expired objects no longer protected by a ref or reflog, using the default retention period. Commits, branches and tags will not change.',
        wont: 'No branches are deleted, history is unchanged, and remotes are untouched.',
        reversible: true,
        verb: 'Start collection; progress is shown in the task area and cancellation is allowed. Cancellation stops only the process; objects already reorganised are not restored.',
        command: 'git gc',
      }
    }
    if (op === 'maintenance-run') {
      return {
        what: 'Run one round of automatic git maintenance using the repository\'s configured tasks (garbage collection by default). Commits, branches and tags will not change.',
        wont: 'No background schedule is enabled, repository configuration is unchanged, and remotes are untouched.',
        reversible: true,
        verb: 'Start the task; progress is shown in the task area and cancellation is allowed.',
        command: 'git maintenance run',
      }
    }
    if (op === 'maintenance-enable') {
      return {
        what: 'Register "' + name + '" for local background maintenance and install a system scheduled task; git will periodically maintain the object database.',
        wont: 'Commits and refs are unchanged; no maintenance runs immediately, and remotes are untouched.',
        reversible: true,
        verb: 'Install the scheduled task. To undo this, disable automatic maintenance at any time.',
        command: 'git maintenance start',
      }
    }
    return {
      what: 'Stop the system scheduled task, then unregister this repository from automatic maintenance. Existing commits and objects are unchanged.',
      wont: 'No objects are deleted, history is unchanged, and remotes are untouched.',
      reversible: true,
      verb: 'Run stop (remove the system schedule), then unregister (remove from the maintenance list).',
      command: 'git maintenance stop / unregister',
    }
  }

  /** 只读电话：一条命令读一类事实，界面与预检共用。 */
  async function handleMaintenanceRead(args: any): Promise<any> {
    const a: any = args || {}
    return read.readOf(String(a.cwd || ''), String(a.op || ''))
  }

  /**
   * 预检电话：认动作 → 量现场 → 版本门与现场闸 → 危险动作补预览与备份计划 → 签 120 秒票。
   * 拒绝对话仍回可读事实（例如不可达对象 0 个时把预览一起带回），界面不用为拒绝再跑一次读数。
   */
  async function handleMaintenanceCheck(args: any): Promise<any> {
    const a: any = args || {}
    const op: string = String(a.op || '')
    const meta: any = maintenanceWriteOpOf(op)
    if (meta === null) return fail('args', 'bad-target', 'The maintenance page issues tickets only for write actions; unrecognised action: ' + op)
    if (typeof a.cwd !== 'string' || a.cwd.trim() === '') return fail('args', 'bad-target', 'Missing repository directory; cannot identify which repository to maintain.')
    const plan: any = maintenancePlanOf({ op: op, mode: a.mode })
    const measured: any = await read.measure(a.cwd, plan)
    if (measured.ok !== true) return measured
    const scene: any = measured.scene
    const repoProblem: string | null = maintenanceSceneProblem({ repoBare: false, operation: scene.operation })
    if (repoProblem !== null) return blocked(op, repoProblem, repoProblem === 'operation-in-progress' ? 'A merge or rebase is in progress; finish it before maintaining the object database.' : 'This repository cannot run maintenance now.', { scene: sceneSummaryOf(scene) })
    const versionProblem: string | null = maintenanceVersionProblem(meta, scene.gitVersion)
    if (versionProblem !== null) {
      const need: string = MAINTENANCE_VERSION_HIDE[meta.capId] || ''
      return blocked(op, versionProblem, 'This git version (' + scene.gitVersion + ') does not support automatic maintenance (requires ' + need + ' or newer); use garbage collection on older versions.', { scene: sceneSummaryOf(scene), needed: need })
    }
    const facts: any = {}
    if (op === 'maintenance-enable' && scene.maintenance.registeredLocal === true) {
      return blocked(op, 'nothing-to-do', 'This repository is already registered for background maintenance; no need to enable it again.', { scene: sceneSummaryOf(scene) })
    }
    if (op === 'maintenance-disable' && scene.maintenance.registered !== true) {
      return blocked(op, 'nothing-to-do', 'This repository is not registered for background maintenance; there is no schedule to disable.', { scene: sceneSummaryOf(scene) })
    }
    if (maintenanceRequiresBackupOf(op)) {
      const preview: any = await read.prunePreviewOf(measured.exe || 'git', measured.repoRoot)
      if (preview.ok !== true) return preview
      if (Number(preview.count) === 0) {
        return blocked(op, 'nothing-to-do', 'There are no unreachable objects to clean up now; retry if any appear later.', { scene: sceneSummaryOf(scene), preview: preview })
      }
      facts.preview = preview
      facts.backup = read.backupPlanOf(scene)
    }
    const confirm: any = confirmOf(op, scene, facts)
    const bindings: any = read.bindingsOf(measured.screen, plan, scene.maintenance)
    const ticket: any = makeTicket({
      id: nextId(),
      op: op as any,
      nowMs: now(),
      headOid: scene.headOid,
      indexFingerprint: null,
      indexEntries: null,
      target: null,
      repoRoot: scene.repoRoot,
      changes: null,
      bindings: bindings,
    })
    ticket.plan = plan
    ticket.maintenance = { op: op, capId: meta.capId }
    ticket.decision = { verdict: 'allow', reasons: ['ok'] }
    ticket.confirmRequired = true
    ticket.confirm = confirm
    ticket.sceneSummary = sceneSummaryOf(scene)
    if (facts.backup) ticket.backup = facts.backup
    if (facts.preview) ticket.preview = facts.preview
    tickets.set(ticket.id, ticket)
    if (tickets.size > TICKET_MAX) { const keys: any[] = Array.from(tickets.keys()); tickets.delete(keys[0]) }
    const out: any = {
      ok: true,
      contract: MAINTENANCE_CHECK_CONTRACT,
      version: MAINTENANCE_CHECK_VERSION,
      op: op,
      decision: { verdict: 'allow', reasons: ['ok'] },
      reasons: ['ok'],
      confirmRequired: true,
      confirm: confirm,
      ticket: { id: ticket.id, op: op, checkedAtMs: ticket.checkedAtMs, expiresAtMs: ticket.expiresAtMs },
      plan: plan,
      scene: sceneSummaryOf(scene),
      readAtMs: now(),
    }
    if (facts.backup) out.backup = facts.backup
    if (facts.preview) out.preview = facts.preview
    return out
  }

  return {
    handleMaintenanceRead: handleMaintenanceRead,
    handleMaintenanceCheck: handleMaintenanceCheck,
    tickets: tickets,
    results: results,
    measure: read.measure,
  }
}
