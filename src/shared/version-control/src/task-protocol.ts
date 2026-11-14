// 长任务通道的纯协议层（#1740）：动作清单、参数拼装、进度解析、任务记录字段。
//
// 这一层不碰进程、不碰文件、不碰界面：宿主侧的运行器与客户端侧的任务区都从这里取同一份
// 动作清单与同一套守卫规则。做这样切分的原因是三条硬要求：
//   1. 长任务只做票面点名的二十种动作（#1757 T21 加了子模块新增/抓取/更新到远端三条），
//      不许扩成「任意 git 命令执行」。清单只写在这里，
//      宿主注册、界面任务区、门禁都从这里读，另写一份就会漂移。
//   2. 参数一律逐项组成 argv，不拼 shell 字符串；任何以短横线开头的远程地址、目录、分支
//      都当选项注入拒掉。历史改写类动作还会进来问一次显式确认。
//   3. 进度能解析出真实百分比就画真实百分比，解析不出就返回 null，界面据此显示「不确定」
//      而不是编一个假进度。clone/fetch/pull/push 的 Receiving objects 行就是真实百分比来源。

/** 四类结束结论。中断专指宿主进程重启后对上一次在途任务的如实说明，不是进程自己退出。 */
import { filterRepoArgs } from './filter-repo-args.js'

export const TASK_CONCLUSIONS = ['succeeded', 'failed', 'cancelled', 'interrupted']

/** 任务状态只有两种：在途、已结束。四类结论只挂在已结束上。 */
export const TASK_STATES = ['running', 'done']

/** 任务记录允许落盘的字段。任务库按这份名单过滤，参数原文、输入文件内容、原始路径都不会进文件。 */
export const TASK_RECORD_FIELDS = [
  'taskId', 'requestId', 'op', 'cwdHash', 'state', 'conclusion', 'phase', 'percent',
  'receivedBytes', 'elapsedMs', 'startedAt', 'endedAt', 'exitCode', 'truncated',
  'failureKind', 'failureLine', 'residual', 'cancelRequested', 'stdinBytes', 'instanceId', 'interrupted',
]

export type TaskOpMeta = {
  id: string
  /** 动作名对应的文案键，界面用 t(keys) 取词条，不在这里写死中文。 */
  labelKey: string
  /** 这个动作的进度行是否可能带真实百分比。 */
  progress: boolean
  /** 只有 fast-import 允许从普通文件送输入；它是票面点名的唯一宽例外。 */
  stdinFile: boolean
  /** 危险动作必须由调用方显式带 confirm: true，否则开始前就拒。 */
  requiresConfirm: boolean
  /** 执行中途被取消时可能留下的残留说明，界面与结论都会带上。 */
  residual: string
}

function meta(id: any, labelKey: any, progress: any, extra?: any): TaskOpMeta {
  return {
    id, labelKey, progress,
    stdinFile: !!(extra && extra.stdinFile),
    requiresConfirm: !!(extra && extra.requiresConfirm),
    residual: (extra && extra.residual) || 'The task was cancelled and may have left incomplete output in the working tree; check as instructed before retrying',
  }
}

/**
 * 票面点名的二十种长任务，一个不多一个不少。
 * 这里刻意不接收任意命令名：命令名不在清单里就直接拒绝，避免把通道做成通用执行器。
 */
export const TASK_OPS: TaskOpMeta[] = [
  meta('clone', 'vc.task.op.clone', true, { residual: 'The target directory may be half-written; delete it, then retry' }),
  meta('fetch', 'vc.task.op.fetch', true, { residual: 'Downloaded objects stay in the local object store and will be reused when fetching again, without downloading everything again' }),
  meta('pull', 'vc.task.op.pull', true, { residual: 'The working tree may be left in an unfinished merge or rebase; the panel will show conflicts, and you can retry after handling them' }),
  meta('push', 'vc.task.op.push', true, { residual: 'The remote may have received only some refs; check the branch position on the remote before retrying' }),
  meta('submodule-init', 'vc.task.op.submoduleInit', true, { residual: 'The submodule directory may be half-initialized; running again resumes from that point' }),
  meta('submodule-update', 'vc.task.op.submoduleUpdate', true, { residual: 'The submodule content may be half-updated; running again resumes from that point' }),
  meta('submodule-add', 'vc.task.op.submoduleAdd', true, { residual: 'The submodule directory may be half-written; delete it, then retry' }),
  meta('submodule-fetch', 'vc.task.op.submoduleFetch', false, { residual: 'Objects fetched before cancellation stay in the local store and are reused by the next fetch' }),
  meta('submodule-remote-update', 'vc.task.op.submoduleRemoteUpdate', true, { residual: 'The submodule content may be half-updated; running again resumes from that point' }),
  meta('archive', 'vc.task.op.archive', false, { residual: 'The output file may be incomplete; delete it and retry' }),
  meta('bundle', 'vc.task.op.bundle', false, { residual: 'The output file may be incomplete; delete it and retry' }),
  meta('format-patch', 'vc.task.op.formatPatch', false, { residual: 'The output directory may contain incomplete patch files; check by date, delete them, and retry' }),
  meta('fast-export', 'vc.task.op.fastExport', false, { residual: 'The export file may be incomplete; delete it and retry' }),
  meta('fast-import', 'vc.task.op.fastImport', false, { stdinFile: true, residual: 'The target repository may already contain some objects; back it up or verify with a temporary repository before importing' }),
  meta('filter-repo', 'vc.task.op.filterRepo', false, { requiresConfirm: true, residual: 'History may be half-rewritten; check with fsck first and restore from backup if needed' }),
  meta('svn-fetch', 'vc.task.op.svnFetch', false, { requiresConfirm: true, residual: 'Some commits may already be written locally; check before retrying' }),
  meta('gc', 'vc.task.op.gc', false, { requiresConfirm: true, residual: 'Cleanup may have been interrupted; the repository remains usable, so run it again' }),
  meta('prune', 'vc.task.op.prune', false, { requiresConfirm: true, residual: 'Object cleanup may have been interrupted; the repository remains usable, but run no other writes before checking' }),
  meta('fsck', 'vc.task.op.fsck', false, { residual: 'The check itself does not modify the repository; retry directly after cancellation' }),
  meta('maintenance-run', 'vc.task.op.maintenanceRun', false, { requiresConfirm: true, residual: 'The maintenance task may have been interrupted; the repository remains usable, so run it again' }),
]

/**
 * 10.4 批量菜单里「逐个抓取」用的完整 argv：固定菜单内部命令，不接受任何输入。
 *
 * 为什么允许它用 foreach：规格第 10.4 条禁止的是「给用户一个 foreach 任意命令入口」，
 * 不是禁止这条固定菜单本身。这里把子命令 git fetch 连同 foreach 一起写成字面量，
 * 参数拼装处直接整串取用，调用方没有任何字段能改命令形状或追加子命令。
 * 改这一行就等于改菜单语义，需要同时改票面、词条与门禁，不要在这里接参数。
 */
export const SUBMODULE_FETCH_ARGV: string[] = ['submodule', 'foreach', '--recursive', 'git fetch']

/** 按动作名取元信息；不在清单里回 null，调用方据此给明确拒绝而不是落到 unknown 分支。 */
export function taskOpMetaOf(id: any): TaskOpMeta | null {
  if (typeof id !== 'string') return null
  for (const item of TASK_OPS) if (item.id === id) return item
  return null
}

/** 这个动作名是否在长任务清单里。宿主注册与界面电话都先过这一道。 */
export function isTaskOp(id: any): boolean {
  return !!taskOpMetaOf(id)
}

export type TaskArgResult =
  | { ok: true; args: string[] }
  | { ok: false; reason: string; message: string; hint: string }

function badArg(reason: any, message: any, hint?: any): TaskArgResult {
  return { ok: false, reason, message, hint: hint || 'Check the arguments and retry; remote addresses, branch names and paths cannot start with a hyphen' }
}

function textArg(value: any): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.indexOf('\u0000') < 0
}

/** 远程地址守卫：拒绝空值、空白、NUL 与短横线开头（后者会被 git 当成选项）。 */
export function taskRemoteProblem(value: any): string | null {
  if (!textArg(value)) return 'remote address must be bounded nonempty text'
  if (/\s/.test(value)) return 'remote address cannot contain whitespace'
  if (value.charAt(0) === '-') return 'remote address cannot start with a hyphen'
  return null
}

/** 分支与 refspec 单侧守卫：短横线、加号开头都拒，冒号与空白也不许出现在单侧里。 */
export function taskRefProblem(value: any): string | null {
  if (!textArg(value)) return 'branch or ref must be bounded nonempty text'
  if (/\s/.test(value)) return 'branch or ref cannot contain whitespace'
  if (/^[-+]/.test(value)) return 'branch or ref cannot start with a hyphen or plus sign'
  if (value.indexOf(':') >= 0) return 'a one-sided branch or ref cannot contain a colon'
  return null
}

/** fetch 的 refspec 守卫：允许 main 这类短名与 refs/heads 长名，拒绝强制前导加号。 */
export function taskRefspecProblem(value: any): string | null {
  if (!textArg(value)) return 'refspec must be bounded nonempty text'
  if (/\s/.test(value)) return 'refspec cannot contain whitespace'
  if (/^[-+]/.test(value)) return 'refspec cannot start with a hyphen or plus sign'
  return null
}

/** 路径守卫：拒绝空值、NUL、以短横线开头与含上跳段，允许相对或绝对路径。 */
export function taskPathProblem(value: any): string | null {
  if (!textArg(value)) return 'path must be bounded nonempty text'
  if (value.indexOf('\u0000') >= 0) return 'path cannot contain NUL characters'
  if (/^[-+]/.test(value)) return 'path cannot start with a hyphen or plus sign'
  const segments = String(value).split(/[\\/]/)
  for (const seg of segments) if (seg === '..') return 'path cannot contain parent segments (..)'
  return null
}

/** 引用与区间守卫：允许 HEAD、HEAD~2..HEAD 这类写法，拒绝以短横线开头的选项注入。 */
export function taskRevProblem(value: any): string | null {
  if (!textArg(value)) return 'ref must be bounded nonempty text'
  if (/\s/.test(value)) return 'ref cannot contain whitespace'
  if (/^[-+]/.test(value)) return 'ref cannot start with a hyphen or plus sign'
  return null
}

/**
 * 把动作与参数拼成 argv 尾段（不含可执行文件名与固定前缀）。
 * 返回的数组每一项都是独立参数，调用方把整段直接交给 spawn，不经过 shell 拼接。
 */
export function taskArgsFor(op: any, args: any): TaskArgResult {
  if (!isTaskOp(op)) return badArg('unknown-op', 'this action is not on the long-task list', 'only the twenty actions named by the ticket are accepted')
  const a = args && typeof args === 'object' ? args : {}
  if (op === 'clone') {
    const urlProblem = taskRemoteProblem(a.url)
    if (urlProblem) return badArg('bad-remote', urlProblem)
    const dirProblem = taskPathProblem(a.dir)
    if (dirProblem) return badArg('bad-path', dirProblem)
    const out = ['clone', '--progress']
    if (a.depth !== undefined) {
      const depth = Number(a.depth)
      if (!Number.isInteger(depth) || depth < 1 || depth > 100000) return badArg('bad-args', 'depth must be a positive integer')
      out.push('--depth', String(depth))
    }
    // #1756 T20 克隆向导：分支、递归子模块、浅克隆子模块三个可选开关，只在不给/给假时完全不出现在 argv 里
    //   （老调用方的 argv 一个字节都不变）。--shallow-submodules 依赖 --depth，缺了 git 会自己报错，
    //   这里提前给人话，免得用户等到任务跑起来才看到一句英文。
    if (a.branch !== undefined && a.branch !== null && String(a.branch).trim() !== '') {
      const branchProblem = taskRefProblem(String(a.branch).trim())
      if (branchProblem) return badArg('bad-branch', branchProblem)
      out.push('--branch', String(a.branch).trim())
    }
    if (a.shallowSubmodules === true) {
      if (a.depth === undefined) return badArg('bad-args', 'shallow submodules require depth too (--shallow-submodules only makes sense with --depth)')
      out.push('--shallow-submodules')
    }
    if (a.recurseSubmodules === true) out.push('--recurse-submodules')
    return { ok: true, args: out.concat([a.url, a.dir]) }
  }
  if (op === 'fetch') {
    const remoteProblem = taskRemoteProblem(a.remote || 'origin')
    if (remoteProblem) return badArg('bad-remote', remoteProblem)
    // #1755 T19：--all / --prune / --tags 是 8.5 票面点名的三种取法；缺省参数下 argv 与既有行为逐字一致。
    const all = a.all === true
    const out = all ? ['fetch', '--progress', '--all'] : ['fetch', '--progress', a.remote || 'origin']
    if (a.prune === true) out.push('--prune')
    if (a.tags === true) out.push('--tags')
    const refspecs = a.refspecs === undefined ? [] : a.refspecs
    if (!Array.isArray(refspecs)) return badArg('bad-args', 'refspecs must be an array')
    if (all && refspecs.length > 0) return badArg('bad-args', '--all and specific refs cannot be used together')
    for (const ref of refspecs) {
      const problem = taskRefspecProblem(ref)
      if (problem) return badArg('bad-refspec', problem)
      out.push(ref)
    }
    return { ok: true, args: out }
  }
  if (op === 'pull') {
    const problem = taskRemoteProblem(a.upstream)
    if (problem) return badArg('bad-upstream', problem)
    const mode = a.mode || 'ff-only'
    const flags = mode === 'merge' ? ['--no-rebase'] : mode === 'rebase' ? ['--rebase'] : ['--ff-only']
    return { ok: true, args: ['pull', '--progress'].concat(flags, [a.upstream]) }
  }
  if (op === 'push') {
    const remoteProblem = taskRemoteProblem(a.remote || 'origin')
    if (remoteProblem) return badArg('bad-remote', remoteProblem)
    // #1755 T19：删除远端引用（8.11）只收完整引用名，避免把名字当选项传进去。
    if (a.deleteRef !== undefined) {
      if (typeof a.deleteRef !== 'string' || !/^refs\/(heads|tags)\/[^\s\u0000]+$/.test(a.deleteRef)) return badArg('bad-ref', 'remote ref to delete must be a full name under refs/heads/ or refs/tags/')
      if (/^[-+]/.test(a.deleteRef) || a.deleteRef.indexOf('..') >= 0) return badArg('bad-ref', 'remote ref to delete cannot contain parent segments or start with a minus sign')
      return { ok: true, args: ['push', '--progress', '--no-follow-tags', '--delete', a.remote || 'origin', a.deleteRef] }
    }
    // 推送标签（8.14）只有两种模式；这两种都不带 --no-follow-tags，否则标签根本不会被推上去。
    if (a.tags !== undefined) {
      const mode = a.tags === 'tags' ? '--tags' : a.tags === 'follow-tags' ? '--follow-tags' : ''
      if (mode === '') return badArg('bad-args', 'tag push mode must be follow-tags or tags')
      return { ok: true, args: ['push', '--progress', mode, a.remote || 'origin'] }
    }
    const localProblem = taskRefProblem(a.localBranch)
    if (localProblem) return badArg('bad-local-branch', localProblem)
    const branchProblem = taskRefProblem(a.branch)
    if (branchProblem) return badArg('bad-branch', branchProblem)
    const out = ['push', '--progress', '--no-follow-tags']
    if (a.setUpstream === true) out.push('--set-upstream')
    // 原子推送（8.13）：所有引用要么全成要么全不成。
    if (a.atomic === true) out.push('--atomic')
    // 强推（8.12）只接受显式租约：租约是「分支:提交号」，没有提交号的强推在这里就被拒绝。
    if (a.forceWithLease !== undefined) {
      const lease = a.forceWithLease
      if (lease === null || typeof lease !== 'object') return badArg('bad-lease', 'force push requires a lease object')
      const leaseBranchProblem = taskRefProblem(lease.branch)
      if (leaseBranchProblem) return badArg('bad-lease', leaseBranchProblem)
      if (typeof lease.oid !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(lease.oid)) return badArg('bad-lease', 'lease baseline must be a full hexadecimal commit id')
      out.push('--force-with-lease=' + lease.branch + ':' + lease.oid)
      if (a.forceIfIncludes === true) out.push('--force-if-includes')
    }
    out.push(a.remote || 'origin', a.localBranch + ':' + a.branch)
    return { ok: true, args: out }
  }
  if (op === 'submodule-init' || op === 'submodule-update' || op === 'submodule-remote-update') {
    // 逐行模式带一个路径（批量菜单不带，走整批）；路径只当 update 的收窄参数，不能变成选项。
    const out = ['submodule', 'update']
    if (op === 'submodule-init') out.push('--init')
    if (op === 'submodule-remote-update') out.push('--remote')
    out.push('--recursive')
    if (a.path !== undefined) {
      const pathProblem = taskPathProblem(a.path)
      if (pathProblem) return badArg('bad-path', pathProblem)
      out.push('--', a.path)
    }
    return { ok: true, args: out }
  }
  if (op === 'submodule-add') {
    // 10.2 新增子模块：地址与路径逐项独立成参数，-- 隔开，任何一项都不许以短横线开头。
    const urlProblem = taskRemoteProblem(a.url)
    if (urlProblem) return badArg('bad-remote', urlProblem)
    const pathProblem = taskPathProblem(a.path)
    if (pathProblem) return badArg('bad-path', pathProblem)
    return { ok: true, args: ['submodule', 'add', '--', a.url, a.path] }
  }
  if (op === 'submodule-fetch') {
    // 10.4 的「逐个抓取」是固定菜单：整串 argv 来自 SUBMODULE_FETCH_ARGV，命令字符串写死成
    // git fetch，调用方连字段都没有地方塞。这里刻意不读调用方给的路径：foreach 不接受路径
    // 收窄参数，读了反而会让人以为路径能改命令形状。slice() 是给调用方一份副本，防止就地改常量。
    return { ok: true, args: SUBMODULE_FETCH_ARGV.slice() }
  }
  if (op === 'archive') {
    const revProblem = taskRevProblem(a.ref)
    if (revProblem) return badArg('bad-ref', revProblem)
    const pathProblem = taskPathProblem(a.outputPath)
    if (pathProblem) return badArg('bad-path', pathProblem)
    return { ok: true, args: ['archive', '--format=tar', '--output=' + a.outputPath, a.ref] }
  }
  if (op === 'bundle') {
    // 离线包三件事（#1759 T23，11.13）：create 产文件、verify 只校验、unbundle 把包里的引用装回当前仓库。
    // mode 缺省是 create，此时 argv 与 T19 之前逐字一致；verify / unbundle 吃的是 filePath（已存在的包），
    // 两者的 argv 形状固定为 bundle <verify|unbundle> <文件>，没有别的选项可传。
    const mode = a.mode === undefined ? 'create' : String(a.mode)
    if (mode !== 'create' && mode !== 'verify' && mode !== 'unbundle') return badArg('bad-mode', 'bundles support only create, verify and unbundle')
    if (mode !== 'create') {
      const inputProblem = taskPathProblem(a.filePath)
      if (inputProblem) return badArg('bad-path', inputProblem)
      return { ok: true, args: ['bundle', mode, a.filePath] }
    }
    const pathProblem = taskPathProblem(a.outputPath)
    if (pathProblem) return badArg('bad-path', pathProblem)
    const out = ['bundle', 'create', a.outputPath]
    if (a.ref !== undefined) {
      const revProblem = taskRevProblem(a.ref)
      if (revProblem) return badArg('bad-ref', revProblem)
      out.push(a.ref)
    } else out.push('--all')
    return { ok: true, args: out }
  }
  if (op === 'format-patch') {
    const revProblem = taskRevProblem(a.range)
    if (revProblem) return badArg('bad-range', revProblem)
    const pathProblem = taskPathProblem(a.dir)
    if (pathProblem) return badArg('bad-path', pathProblem)
    return { ok: true, args: ['format-patch', '--output-directory', a.dir, a.range] }
  }
  if (op === 'fast-export') {
    const out = ['fast-export']
    if (a.outputPath !== undefined) {
      const pathProblem = taskPathProblem(a.outputPath)
      if (pathProblem) return badArg('bad-path', pathProblem)
      out.push('--output=' + a.outputPath)
    }
    out.push('--all')
    return { ok: true, args: out }
  }
  if (op === 'fast-import') return { ok: true, args: ['fast-import', '--quiet'] }
  if (op === 'filter-repo') {
    const out = ['filter-repo', '--force']
    if (a.args !== undefined) {
      const parsed: any = filterRepoArgs(a.args)
      if (parsed.ok !== true) return badArg(parsed.reason, parsed.message, parsed.hint)
      for (const tok of parsed.args) out.push(tok)
    }
    return { ok: true, args: out }
  }
  if (op === 'svn-fetch') {
    const problem = taskRemoteProblem(a.url)
    if (problem) return badArg('bad-remote', problem)
    return { ok: true, args: ['svn', 'fetch', '--quiet', a.url] }
  }
  if (op === 'gc') return { ok: true, args: ['gc', '--quiet'] }
  if (op === 'prune') return { ok: true, args: ['prune', '--progress'] }
  if (op === 'fsck') {
    // 维护页的完整性检查另一档是「找还能捞回来的对象」：追加 --unreachable 只列不可达对象。
    // --lost-found 会往 .git/lost-found 写文件，不在面板里跑；不认识的模式明确拒绝。
    const mode: any = (a.args && a.args.mode !== undefined) ? a.args.mode : a.mode;
    if (mode !== undefined && mode !== null && mode !== 'default' && mode !== 'unreachable') return badArg('bad-mode', 'fsck accepts only default and unreachable modes');
    const args = ['fsck', '--no-progress'];
    if (mode === 'unreachable') args.push('--unreachable');
    return { ok: true, args: args };
  }
  if (op === 'maintenance-run') return { ok: true, args: ['maintenance', 'run'] }
  return badArg('unknown-op', 'this action is not on the long-task list')
}

/** 按 1024 进制把人类可读的字节串转成字节数；读不出来回 null。 */
function sizeToBytes(value: any, unit: any): number | null {
  if (value === undefined) return null
  const n = Number(value)
  if (!isFinite(n) || n < 0) return null
  const u = String(unit || '').toLowerCase()
  const base = u.indexOf('ib') >= 0 ? 1024 : u.indexOf('b') >= 0 ? 1000 : 1024
  const power = u.indexOf('g') === 0 ? 3 : u.indexOf('m') === 0 ? 2 : u.indexOf('k') === 0 ? 1 : 0
  return Math.round(n * Math.pow(base, power))
}

export type TaskProgress = { phase: string | null; percent: number | null; bytes: number | null }

/**
 * 解析一行进度输出。找到形如 Receiving objects:  42% (12/34), 1.2 MiB 的行就给出
 * 阶段名、真实百分比与已传字节；没有百分比的行只给阶段名，percent 保持 null，
 * 让界面显示「进度不确定」而不是编一个数字。
 */
export function parseTaskProgress(line: any): TaskProgress {
  const empty = { phase: null, percent: null, bytes: null }
  if (typeof line !== 'string' || line.length === 0) return empty
  const match = /([A-Za-z][A-Za-z0-9 _-]*?):\s+(\d{1,3})%\s*\((\d+)\/(\d+)\)(?:,\s*([\d.]+)\s*([KMGT]?i?B))?/.exec(line)
  if (match) {
    const percent = Number(match[2])
    return {
      phase: match[1].trim(),
      percent: percent >= 0 && percent <= 100 ? percent : null,
      bytes: sizeToBytes(match[5], match[6]),
    }
  }
  const phaseMatch = /^(?:remote:\s*)?([A-Za-z][A-Za-z0-9 _-]*?):/.exec(line)
  return { phase: phaseMatch ? phaseMatch[1].trim() : null, percent: null, bytes: null }
}

/** 递归按键排序的稳定序列化：同一组参数无论键序如何都得到同一个去重键。 */
export function canonicalArgs(value: any): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {}
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key])
      return out
    }
    return v
  }
  try { return JSON.stringify(walk(value)) } catch { return '' }
}

/** 同一对象同一动作在途去重用的键：动作 + 仓库指纹 + 规范化参数。 */
export function taskDedupeKey(op: any, cwdHash: any, args: any): string {
  return String(op) + '\u0000' + String(cwdHash) + '\u0000' + canonicalArgs(args)
}

/** 输入文件引用的形状校验：路径、非负整数大小、64 位十六进制摘要，三样缺一不可。
 *  这里只管形状；文件是否真是普通文件、大小与摘要是否对得上，由宿主打开文件时核对（那两个事实只有宿主知道）。 */
export function stdinSpecProblem(spec: any): string | null {
  if (!spec || typeof spec !== 'object') return 'input file spec must be an object'
  if (typeof spec.path !== 'string' || spec.path.length === 0) return 'input file is missing a path'
  if (!Number.isInteger(spec.sizeBytes) || spec.sizeBytes < 0) return 'input file size must be a nonnegative integer'
  if (typeof spec.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(spec.sha256)) return 'input file digest must be 64 hex digits'
  return null
}

/** 对外可见的任务摘要：只挑界面需要的字段，参数原文与文件内容不往外传。
 *  放在协议层而不是宿主运行器里：界面读的形状与「任务记录里哪些字段能外传」是协议的一部分，
 *  宿主与界面两侧按同一份口径解释同一个回包。 */
export function summaryOf(record: any): any {
  if (!record || typeof record !== 'object') return null
  const percent: number | null = typeof record.percent === 'number' ? record.percent : null
  const meta: any = taskOpMetaOf(record.op)
  return {
    taskId: record.taskId,
    requestId: record.requestId || null,
    op: record.op,
    // 动作的文案键也随摘要一起给界面：界面不自己拼动作名，避免多一处映射。
    labelKey: meta ? meta.labelKey : null,
    state: record.state || 'running',
    conclusion: record.conclusion || null,
    phase: record.phase || null,
    percent,
    uncertain: record.state === 'running' && percent === null,
    receivedBytes: typeof record.receivedBytes === 'number' ? record.receivedBytes : null,
    elapsedMs: typeof record.elapsedMs === 'number' ? record.elapsedMs : null,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    endedAt: typeof record.endedAt === 'number' ? record.endedAt : null,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
    truncated: record.truncated === true,
    failureKind: record.failureKind || null,
    failureLine: record.failureLine || null,
    residual: record.residual || null,
    cancelRequested: record.cancelRequested === true,
    stdinBytes: typeof record.stdinBytes === 'number' ? record.stdinBytes : null,
    interrupted: record.interrupted === true || record.conclusion === 'interrupted',
  }
}

/** 长任务协议里对外可执行的公开动作名清单，宿主注册与界面电话按这份清单点名。 */
export const TASK_SOURCE = 'task-protocol'