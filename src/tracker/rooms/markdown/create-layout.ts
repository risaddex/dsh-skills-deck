// create-layout.ts —— Markdown 后端「按原文形状落盘」的目录选择与写盘（#1486，父票 #1480）。
//
// 建什么形状的正文由 create-render.ts 负责；本文件只负责：
//   1. 选中目录：给了 feature/effort 就用它；没给就按标题生成目录名，占用时追加 -2、-3 后缀。
//      地图落 .scratch/<effort>/map.md（容器，编号 00）；地图子票落同一目录 issues/ 下的编号文件。
//   2. 在同一把工作区写锁里回查幂等键、重新列目录取号、写文件，保证并发不丢号不重号。
//   3. 返回最终路径、编号与目录名，让人话回执说清落在哪里。
import { parseMd, slugify } from './parse.js'
import { markerKindInHeader } from '../../../shared/issue-file/src/marker.js'
import { listDir, readTextFile } from './read.js'
import { publishTextFile } from './write.js'
import { getPlat, getScratchRoot, listEfforts, resolveMapFile } from './issues-locate.js'
import { failAs } from './error-fail.js'
import { withWorkspaceWriter } from './write-queue.js'
import { idempotencyKeyOf } from '../../../refresh/contract/idempotency-keys.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { TRACKER_ERROR_STAGE } from '../../contract/results.js'
import type { OpContext } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { CreateInput } from '../../contract/inputs.js'
import { nowIso, viewOf, labelsOf, assigneesOf, renderSpec, renderTicket } from './create-render.js'
import { renderMap, renderWayfinderChild } from './map-render.js'
import type { CreateView, OriginalKind, LayoutFailure } from './create-render.js'

/** 本地仓库引用：path 是本地后端的自有约定；mdScene 记调用方用的是 feature 还是 effort。 */
type RepoWithPath = RepositoryRef & { path?: string; mdScene?: string }

/** 落盘结果：路径、编号与目录名。回包由调用方按盘上内容再解析一次。 */
export interface LayoutPlacement {
  ok: true
  path: string
  key: string
  effortId: string
  reused: boolean
  kind: OriginalKind
  createdAt: string
}

/** 对方容器的文件名（一个功能一个目录的判据，建两处与初始化一处共用这一份）。
 *
 *  为什么一个目录只许一种容器：原文 issue-tracker-local.md 只给了两种目录形状——
 *  规格住 `.scratch/<feature-slug>/spec.md`（一个特性一个目录），探索地图住
 *  `.scratch/<effort>/map.md`；物理上是同一层，没有“规格和地图住同一目录”这种形状。
 *  同一个目录同时放 spec.md 和 map.md，后面读票、按编号取号、关票收口都会分不清这次说的
 *  00 号是哪一个容器，所以写入端直接拦住，不留这种目录。
 *
 *  建规格时对方是 map.md，建地图时对方是 spec.md；票（实施票、地图子票、普通票）本来就可以
 *  和容器住同一个目录，没有对方容器，返回空。 */
function counterpartFile(kind: OriginalKind): string | null {
  if (kind === 'spec') return 'map.md'
  if (kind === 'map') return 'spec.md'
  return null
}

async function dirOccupied(ctx: OpContext, dir: string): Promise<{ ok: true; occupied: boolean; names: string[] } | LayoutFailure> {
  const plat = getPlat(ctx)
  const listed = await listDir(ctx, dir)
  if (!listed.ok) {
    // 目录不存在就是空的（全新工作区），不是故障。
    if (listed.missing) return { ok: true, occupied: false, names: [] }
    return failAs(ERROR_KIND.ENV, 'Creating the ticket needs to list a directory, but the directory cannot be read: ' + dir + ' (' + String((listed.error as Error)?.message || listed.error) + ')', String((listed.error as Error)?.message || listed.error))
  }
  const names = listed.names
  if (names.length === 0) return { ok: true, occupied: false, names: [] }
  // 只看目录里有没有规格/地图/票目录这三样；别的零散文件不挡建票。
  const hasSpec = names.indexOf('spec.md') >= 0
  const hasMap = names.indexOf('map.md') >= 0
  const hasIssues = names.indexOf('issues') >= 0
  return { ok: true, occupied: hasSpec || hasMap || hasIssues, names: names }
}

/** 按标题生成目录名：先试不带后缀的，被占用就依次试 -2、-3。最多试 50 次，之后如实失败。 */
async function generatedFeatureDir(ctx: OpContext, title: string, idempotencyKey: string, kind: OriginalKind): Promise<{ ok: true; root: string; dirName: string } | LayoutFailure> {
  const plat = getPlat(ctx)
  const scratch = await getScratchRoot(ctx)
  const base = slugify(title)
  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? base : base + '-' + n
    const dir = plat.join(scratch, name)
    const state = await dirOccupied(ctx, dir)
    if (!state.ok) return state
    if (!state.occupied) return { ok: true, root: dir, dirName: name }
    // 初始化一处的拦点（与建规格、建地图两处共用 counterpartFile 判据）：初始化新目录时，
    // 对方容器所在的目录不能复用，直接试下一个 -2/-3（这就是“指到新目录”）。
    // 票不受这一条限制：票本来就可以和容器住在同一个目录里，counterpartFile 只对两种容器返回文件名。
    const other = counterpartFile(kind)
    if (other && state.names.indexOf(other) >= 0) continue
    // 已占用：如果里面已经有同一个幂等键的票，就复用这个目录（重复创建不能因撞名又多一份）。
    const specPath = plat.join(dir, 'spec.md')
    if (state.names.indexOf('spec.md') >= 0) {
      const text = await readTextFile(ctx, specPath)
      if (idempotencyKey && idempotencyKeyOf(text) === idempotencyKey && kind === 'spec') {
        return { ok: true, root: dir, dirName: name }
      }
    }
    // 地图是 effort 目录的顶层容器（map.md，编号 00），与规格同款：
    // 同一幂等键重复建同一张地图时要复用这个目录，不能因为 map.md 已存在就换 -2 目录。
    const mapPath = plat.join(dir, 'map.md')
    if (state.names.indexOf('map.md') >= 0) {
      const text = await readTextFile(ctx, mapPath)
      if (idempotencyKey && idempotencyKeyOf(text) === idempotencyKey && kind === 'map') {
        return { ok: true, root: dir, dirName: name }
      }
    }
    const issues = plat.join(dir, 'issues')
    if (idempotencyKey && state.names.indexOf('issues') >= 0) {
      const listed = await listDir(ctx, issues)
      if (listed.ok) {
        for (const f of listed.names) {
          if (!f.endsWith('.md')) continue
          const text = await readTextFile(ctx, plat.join(issues, f))
          if (idempotencyKeyOf(text) === idempotencyKey) return { ok: true, root: dir, dirName: name }
        }
      }
    }
  }
  return failAs(ERROR_KIND.CONFLICT, 'The first 50 directory names generated from the title "' + title + '" are all taken by other tickets, so nothing was created: give feature a directory name.', title)
}

/** 扫描 `.scratch` 下所有含 spec.md 的目录（没有 feature 时，实施票要先找到唯一的规格）。 */
async function specDirs(ctx: OpContext): Promise<{ ok: true; dirs: Array<{ root: string; dirName: string }> } | LayoutFailure> {
  const plat = getPlat(ctx)
  const scratch = await getScratchRoot(ctx)
  const listed = await listDir(ctx, scratch)
  if (!listed.ok) {
    if (listed.missing) return { ok: true, dirs: [] }
    return failAs(ERROR_KIND.ENV, 'Listing .scratch to find the spec directory failed (' + String((listed.error as Error)?.message || listed.error) + ')', String((listed.error as Error)?.message || listed.error))
  }
  const dirs: Array<{ root: string; dirName: string }> = []
  for (const name of listed.names) {
    if (!name || name.startsWith('.')) continue
    const dir = plat.join(scratch, name)
    const specPath = plat.join(dir, 'spec.md')
    try {
      const text = await readTextFile(ctx, specPath)
      if (text !== '') dirs.push({ root: dir, dirName: name })
    } catch { /* 没有 spec.md 的目录就是地图/旧布局，不在这里报错 */ }
  }
  return { ok: true, dirs: dirs }
}

/** 解析这次落哪个 feature 目录；实施票没给 feature 时必须恰好能找到一个规格目录。 */
async function resolveTarget(ctx: OpContext, repo: RepoWithPath, kind: OriginalKind, title: string, idempotencyKey: string, parentKey = ''): Promise<{ ok: true; root: string; dirName: string; explicit: boolean } | LayoutFailure> {
  const plat = getPlat(ctx)
  const cwd = ctx && typeof ctx.cwd === 'string' ? ctx.cwd : '.'
  const scratch = await getScratchRoot(ctx)
  const effort = repo && repo.effortId !== undefined && repo.effortId !== null ? String(repo.effortId).trim() : ''
  if (effort) return { ok: true, root: plat.join(scratch, effort), dirName: effort, explicit: true }

  // 调用方明确用 feature 参数给了目录（mdScene='feature'）时，上面那条已经接住；
  // 没有 feature 但仓库引用本身指着一个具体目录（测试夹具与旧调用常见）时，就落那一个目录。
  const direct = repo && repo.path ? String(repo.path) : (repo && repo.refId ? String(repo.refId) : '')
  if (direct) {
    // Windows 盘符路径在 path.posix 眼里不是绝对路径（`D:/...` 不以 `/` 开头），不单独认一下，
    // 会把它当相对路径再拼一次 cwd，得到 `D:/ws/D:/ws` 这种坏路径。
    const winAbs = /^[A-Za-z]:[\\/]/.test(direct)
    const abs = plat.isAbsolute(direct) || winAbs ? direct : plat.join(cwd, direct)
    const base = abs.split(/[\\/]/).filter(Boolean).pop() || ''
    const normalized = abs.replace(/[\\/]+$/, '')
    const cwdNormalized = String(cwd).replace(/[\\/]+$/, '')
    const scratchNormalized = String(scratch).replace(/[\\/]+$/, '')
    if (base && base !== '.scratch' && normalized !== cwdNormalized && normalized !== scratchNormalized) {
      return { ok: true, root: abs, dirName: base, explicit: true }
    }
  }

  // 规格没给 feature：一律按标题建自己的目录，不自动落进「唯一那个已有容器」。
  // 规格是 feature 的顶层容器，一个目录只能有一张 spec.md；沿用已有容器会撞上那里的规格，
  // 而多张规格共用一个目录本来就不合法。旧行为「单 effort 仓库无感」只适用于票，不适用于规格。
  if (kind === 'spec') {
    const generated = await generatedFeatureDir(ctx, title, idempotencyKey, kind)
    if (!generated.ok) return generated
    return { ok: true, root: generated.root, dirName: generated.dirName, explicit: false }
  }

  // 地图没给 effort：同样按标题建自己的目录（成为 .scratch/<slug>/map.md），不沿用唯一那个已有容器。
  // 一个 effort 目录只能有一张 map.md，沿用已有目录会撞上那里的地图；「单容器自动回落」只适用于票。
  if (kind === 'map') {
    const generated = await generatedFeatureDir(ctx, title, idempotencyKey, kind)
    if (!generated.ok) return generated
    return { ok: true, root: generated.root, dirName: generated.dirName, explicit: false }
  }

  // 实施票没给 feature：规格目录必须唯一，猜错会把票挂到别人的规格下。
  // 要在「单容器自动回落」之前判断：地图目录不是规格目录，拿地图目录去建实施票会找不到父规格。
  if (kind === 'spec-ticket') {
    const found = await specDirs(ctx)
    if (!found.ok) return found
    if (found.dirs.length === 1) return { ok: true, root: found.dirs[0].root, dirName: found.dirs[0].dirName, explicit: true }
    if (found.dirs.length === 0) {
      return failAs(ERROR_KIND.NOTFOUND, 'An implementation ticket must sit under a spec: this workspace has no spec.md yet. Create the spec first, or use feature to name the directory the spec is in.', '')
    }
    // 缺的是调用方该给的 feature（目录选择参数），不是后端故障：标成输入被拒，下一步才是补上这个参数。
    return failAs(ERROR_KIND.CONFLICT, 'This workspace has ' + found.dirs.length + ' spec directories (' + found.dirs.map((d) => d.dirName).join(', ') + '), so it cannot tell which one the implementation ticket belongs in: name the directory with feature.', JSON.stringify(found.dirs.map((d) => d.dirName)), TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  // 地图子票没给 effort：必须挂在某张地图下，就落在那张 map.md 所在的目录（与普通票挂地图同一口径）。
  // 要在「单容器自动回落」之前判断：回落拿到的可能是规格目录，那里没有 map.md。
  if (kind === 'map-ticket') {
    const map = await resolveMapFile(ctx, repo, { mode: 'read' })
    if (!map.ok) {
      if (map.error.kind === ERROR_KIND.NOTFOUND) {
        return failAs(ERROR_KIND.NOTFOUND, 'A map ticket must sit under an exploration map: this workspace has no map.md yet. Create the map first, or use effort to name the directory the map is in.', '')
      }
      return { ok: false, error: map.error }
    }
    const parts = map.path.split(/[\\/]/).filter(Boolean)
    const parentDir = parts.length >= 2 ? parts[parts.length - 2] : ''
    return { ok: true, root: map.path.replace(/[\\/][^\\/]+$/, ''), dirName: parentDir, explicit: true }
  }

  // 没有点名目录、但工作区里只有一个已有容器时，沿用旧口径自动落那一个目录：
  // 这是 #1486 之前「单 effort 仓库用起来无感」的行为，改布局不该把它弄丢；
  // 一个都没有（新工作区）才按标题生成新目录，多义的留给下面各类对象自己判断。
  const efforts = await listEfforts(ctx)
  if (efforts.length === 1) return { ok: true, root: efforts[0].dir, dirName: efforts[0].effortId, explicit: true }

  // 普通票/缺陷票明确挂在某张地图下（parentKey）时，落在那张地图的目录里，和旧口径一致：
  // 父子关系只在同一个 effort 内成立，按标题另起一个目录会让父票指向一张不在同一目录的票。
  if ((kind === 'issue' || kind === 'bug') && parentKey) {
    const map = await resolveMapFile(ctx, repo, { mode: 'read' })
    if (!map.ok) return failAs(ERROR_KIND.NOTFOUND, 'Parent #' + parentKey + ' has no matching map file: a plain ticket or bug ticket placed under a map needs that map to exist first.', '')
    const parts = map.path.split(/[\\/]/).filter(Boolean)
    const parentDir = parts.length >= 2 ? parts[parts.length - 2] : ''
    return { ok: true, root: map.path.replace(/[\\/][^\\/]+$/, ''), dirName: parentDir, explicit: true }
  }

  // 普通票/缺陷票没给 feature：按标题建自己的目录（原文的 plain-issue 也住在 feature 目录里）。
  const generated = await generatedFeatureDir(ctx, title, idempotencyKey, kind)
  if (!generated.ok) return generated
  return { ok: true, root: generated.root, dirName: generated.dirName, explicit: false }
}

/** 在票目录里按幂等键回查；命中返回盘上那一份，读不出来就如实失败。 */
async function findAnchor(ctx: OpContext, issuesDir: string, key: string): Promise<{ ok: true; hit: { path: string; name: string } | null } | LayoutFailure> {
  if (!key) return { ok: true, hit: null }
  const plat = getPlat(ctx)
  const listed = await listDir(ctx, issuesDir)
  if (!listed.ok) {
    if (listed.missing) return { ok: true, hit: null }
    return failAs(ERROR_KIND.ENV, 'Looking up the idempotency key needs to list the ticket directory, but it cannot be read: ' + issuesDir + ' (' + String((listed.error as Error)?.message || listed.error) + ')', String((listed.error as Error)?.message || listed.error))
  }
  for (const name of listed.names) {
    if (!name || !name.endsWith('.md')) continue
    const full = plat.join(issuesDir, name)
    let text = ''
    try { text = await readTextFile(ctx, full) } catch (e) {
      return failAs(ERROR_KIND.UNSUPPORTED, 'Looking up the idempotency key needs to read a ticket file, but it cannot be read: ' + full + ' (' + String((e as Error)?.message || e) + '). No new ticket was created, to avoid a duplicate.', '')
    }
    if (idempotencyKeyOf(text) === key) return { ok: true, hit: { path: full, name: name } }
  }
  return { ok: true, hit: null }
}

/** 在目标目录里取下一个编号：锁内重新列目录，跳过盘上已经占用的号。 */
async function nextNumber(ctx: OpContext, issuesDir: string): Promise<{ ok: true; number: string; max: number } | LayoutFailure> {
  const listed = await listDir(ctx, issuesDir)
  if (!listed.ok) {
    if (listed.missing) return { ok: true, number: '01', max: 0 }
    return failAs(ERROR_KIND.ENV, 'Assigning a number needs to list the ticket directory, but it cannot be read: ' + issuesDir + ' (' + String((listed.error as Error)?.message || listed.error) + ')', String((listed.error as Error)?.message || listed.error))
  }
  let max = 0
  for (const name of listed.names) {
    const m = /^(\d+)-/.exec(name)
    if (!m) continue
    const n = parseInt(m[1], 10)
    if (!isNaN(n) && n > max) max = n
  }
  return { ok: true, number: String(max + 1).padStart(2, '0'), max: max }
}

/** 找目标目录里的 spec.md，并核对它确实是规格（新文件没有旧标记，靠文件名与位置判断）。 */
async function requireSpec(ctx: OpContext, root: string): Promise<{ ok: true; path: string; text: string } | LayoutFailure> {
  const plat = getPlat(ctx)
  const specPath = plat.join(root, 'spec.md')
  let text = ''
  try { text = await readTextFile(ctx, specPath) } catch {
    return failAs(ERROR_KIND.NOTFOUND, 'An implementation ticket must sit under a spec: the directory "' + root + '" has no spec.md. Create the spec in that directory first, or use feature to name the directory the spec is in.', specPath)
  }
  // 下面两处是本地容器文件形状不对（空文件、类型标记写错）：调用方要换目录或先修文件，属于输入被拒。
  if (!text.trim()) return failAs(ERROR_KIND.PARSE, 'The spec.md in the directory "' + root + '" is empty, so it cannot be confirmed to be a spec: no implementation ticket was created.', specPath, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  // 老文件可能还带 DSH-ISSUE-KIND；写着别的类型就拒绝，避免把实施票挂到地图或普通票下面。
  const marked = markerKindInHeader(text)
  if (marked && marked !== 'spec') {
    return failAs(ERROR_KIND.PARSE, 'The spec.md in the directory "' + root + '" carries the "' + marked + '" marker, so it is not a spec container: no implementation ticket was created.', specPath, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  return { ok: true, path: specPath, text: text }
}

/** 找目标目录里的 map.md，并核对它确实是地图容器（新文件没有旧标记，靠文件名与位置判断）。 */
async function requireMap(ctx: OpContext, root: string): Promise<{ ok: true; path: string; text: string } | LayoutFailure> {
  const plat = getPlat(ctx)
  const mapPath = plat.join(root, 'map.md')
  let text = ''
  try { text = await readTextFile(ctx, mapPath) } catch {
    return failAs(ERROR_KIND.NOTFOUND, 'A map ticket must sit under an exploration map: the directory "' + root + '" has no map.md. Create the map in that directory first, or use effort to name the directory the map is in.', mapPath)
  }
  // 与上面 spec.md 同理：容器文件形状不对，改输入（换目录或先修文件）才能继续。
  if (!text.trim()) return failAs(ERROR_KIND.PARSE, 'The map.md in the directory "' + root + '" is empty, so it cannot be confirmed to be a map: no map ticket was created.', mapPath, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  // 老文件可能还带 DSH-ISSUE-KIND；写着别的类型就拒绝，避免把子票挂到规格或普通票下面。
  const marked = markerKindInHeader(text)
  if (marked && marked !== 'map') {
    return failAs(ERROR_KIND.PARSE, 'The map.md in the directory "' + root + '" carries the "' + marked + '" marker, so it is not a map container: no map ticket was created.', mapPath, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  return { ok: true, path: mapPath, text: text }
}

/** 一次建票的完整落盘：锁内选目录、回查幂等键、取号、写文件。 */
export async function createInOriginalLayout(ctx: OpContext, repo: RepoWithPath | null, input: CreateInput, kind: OriginalKind, idempotencyKey: string): Promise<LayoutPlacement | LayoutFailure> {
  const plat = getPlat(ctx)
  const view = viewOf(input)
  const title = String(input.title || '').trim()
  const createdAt = nowIso()
  const labels = labelsOf(view)
  const assignees = assigneesOf(view)
  const parentRaw = input.parentKey === undefined || input.parentKey === null ? '' : String(input.parentKey).trim()
  const parentKey = parentRaw && /^\d+$/.test(parentRaw) ? parentRaw.padStart(2, '0') : parentRaw

  return await withWorkspaceWriter(ctx, repo, async (): Promise<LayoutPlacement | LayoutFailure> => {
    const target = await resolveTarget(ctx, repo || {} as RepoWithPath, kind, title, idempotencyKey, parentKey)
    if (!target.ok) return target
    const root = target.root
    const dirName = target.dirName

    if (kind === 'spec') {
      const specPath = plat.join(root, 'spec.md')
      const anchor = await findAnchor(ctx, root, idempotencyKey)
      // 规格目录里只有 spec.md 一个候选；findAnchor 扫整个目录会把 issues/ 也读进来，
      // 所以这里单独按 spec.md 判断（上面扫到的是别的票的键，不能拿来复用规格）。
      if (anchor.ok && anchor.hit && anchor.hit.name === 'spec.md') {
        const text = await readTextFile(ctx, anchor.hit.path)
        return { ok: true, path: anchor.hit.path, key: '00', effortId: dirName, reused: true, kind: kind, createdAt: createdOf(text, createdAt) }
      }
      // 目标目录已经有 spec.md 但键不同 → 不能再写一份，必须换一个目录或如实失败。
      const occupied = await dirOccupied(ctx, root)
      if (!occupied.ok) return occupied
      if (occupied.names.indexOf('spec.md') >= 0) {
        // 给了 feature 时不允许改名：这是调用方指定的目录，覆盖别人的规格比失败更贵。
        if (target.explicit && String(repo && repo.effortId || '').trim()) {
          return failAs(ERROR_KIND.CONFLICT, 'The directory "' + dirName + '" already has a spec.md (not created with this idempotency key): nothing was created, to avoid overwriting it. Use another feature, or a new directory.', specPath)
        }
        // 按标题生成的目录在占用时已经换成 -2/-3 了；走到这里说明是显式目录，同上拒绝。
        return failAs(ERROR_KIND.CONFLICT, 'The directory "' + dirName + '" already has a spec.md (not created with this idempotency key): nothing was created, to avoid overwriting it.', specPath)
      }
      // 建规格处的拦点（与建地图、初始化共用 counterpartFile 判据）：点名的目录里已经有探索地图，
      // 再把规格写进去会造出双容器目录。调用方点名的是这个目录，不擅自换地方，直接拒绝并指到新目录。
      if (occupied.names.indexOf('map.md') >= 0) {
        return failAs(ERROR_KIND.CONFLICT, 'The directory "' + dirName + '" already has an exploration map (map.md): a directory holds only one kind of container, so no spec was created next to the map. Use another feature (for example "' + dirName + '-2"), or a new directory.', specPath)
      }
      const text = renderSpec(view, { createdAt: createdAt, idempotencyKey: idempotencyKey, labels: labels, assignees: assignees })
      await publishTextFile(ctx, specPath, text, ctx && (ctx as { sandboxPolicy?: unknown }).sandboxPolicy)
      return { ok: true, path: specPath, key: '00', effortId: dirName, reused: false, kind: kind, createdAt: createdAt }
    }

    // 探索地图：一个目录一份 map.md，编号 00。状态只进隐藏注释，正文是原文的五段。
    // 与规格同一套复用/防覆盖规则：同幂等键复用盘上那份，键不同就拒绝覆盖。
    if (kind === 'map') {
      const mapPath = plat.join(root, 'map.md')
      const anchor = await findAnchor(ctx, root, idempotencyKey)
      if (anchor.ok && anchor.hit && anchor.hit.name === 'map.md') {
        const text = await readTextFile(ctx, anchor.hit.path)
        return { ok: true, path: anchor.hit.path, key: '00', effortId: dirName, reused: true, kind: kind, createdAt: createdOf(text, createdAt) }
      }
      if (!anchor.ok) return anchor
      const occupied = await dirOccupied(ctx, root)
      if (!occupied.ok) return occupied
      if (occupied.names.indexOf('map.md') >= 0) {
        return failAs(ERROR_KIND.CONFLICT, 'The directory "' + dirName + '" already has a map.md (not created with this idempotency key): nothing was created, to avoid overwriting it. Use another effort, or a new directory.', mapPath)
      }
      // 建地图处的拦点（与建规格、初始化共用 counterpartFile 判据）：点名的目录里已经有规格，
      // 再把地图写进去会造出双容器目录。调用方点名的是这个目录，不擅自换地方，直接拒绝并指到新目录。
      if (occupied.names.indexOf('spec.md') >= 0) {
        return failAs(ERROR_KIND.CONFLICT, 'The directory "' + dirName + '" already has a spec (spec.md): a directory holds only one kind of container, so no map was created next to the spec. Use another effort (for example "' + dirName + '-2"), or a new directory.', mapPath)
      }
      const text = renderMap(view, { createdAt: createdAt, idempotencyKey: idempotencyKey, labels: labels, assignees: assignees })
      await publishTextFile(ctx, mapPath, text, ctx && (ctx as { sandboxPolicy?: unknown }).sandboxPolicy)
      return { ok: true, path: mapPath, key: '00', effortId: dirName, reused: false, kind: kind, createdAt: createdAt }
    }

    // 实施票：父票只能是本次目录里的规格（00）。没给父票也按 00 处理，原文靠目录表达父子。
    if (kind === 'spec-ticket') {
      if (parentKey && parentKey !== '00') {
        // 父票编号形状不合规（只能填 00）：改入参才能继续，标成输入被拒。
        return failAs(ERROR_KIND.PARSE, 'The parent of an implementation ticket must be 00 (a directory holds only one spec container), but got "' + parentKey + '": nothing was created.', parentKey, TRACKER_ERROR_STAGE.INPUT_REFUSED)
      }
      const spec = await requireSpec(ctx, root)
      if (!spec.ok) return spec
    }

    // 地图子票：父票只能是同一目录的地图（00）；目录里必须有 map.md，否则不知道挂哪张地图。
    if (kind === 'map-ticket') {
      if (parentKey && parentKey !== '00') {
        return failAs(ERROR_KIND.PARSE, 'The parent of a map ticket must be 00 (a directory holds only one map container), but got "' + parentKey + '": nothing was created.', parentKey, TRACKER_ERROR_STAGE.INPUT_REFUSED)
      }
      const map = await requireMap(ctx, root)
      if (!map.ok) return map
    }

    const issuesDir = plat.join(root, 'issues')
    const anchor = await findAnchor(ctx, issuesDir, idempotencyKey)
    if (!anchor.ok) return anchor
    if (anchor.hit) {
      const m = /^(\d+)-/.exec(anchor.hit.name)
      const key = m ? m[1].padStart(2, '0') : '01'
      const text = await readTextFile(ctx, anchor.hit.path)
      return { ok: true, path: anchor.hit.path, key: key, effortId: dirName, reused: true, kind: kind, createdAt: createdOf(text, createdAt) }
    }

    const numbered = await nextNumber(ctx, issuesDir)
    if (!numbered.ok) return numbered
    const key = numbered.number
    const fileName = key + '-' + slugify(title) + '.md'
    const finalPath = plat.join(issuesDir, fileName)
    const text = kind === 'map-ticket'
      ? renderWayfinderChild(view, {
          number: key,
          createdAt: createdAt,
          idempotencyKey: idempotencyKey,
          labels: labels,
          assignees: assignees,
          parentKey: '00',
        })
      : renderTicket(kind, view, {
          number: key,
          createdAt: createdAt,
          idempotencyKey: idempotencyKey,
          labels: labels,
          assignees: assignees,
          parentKey: kind === 'spec-ticket' ? '00' : parentKey,
        })
    await publishTextFile(ctx, finalPath, text, ctx && (ctx as { sandboxPolicy?: unknown }).sandboxPolicy)
    return { ok: true, path: finalPath, key: key, effortId: dirName, reused: false, kind: kind, createdAt: createdAt }
  })
}

/** 复用旧票时，创建时间沿用盘上那一行（没有就回退到本次时钟）。 */
function createdOf(text: string, fallback: string): string {
  const parsed = parseMd(text, { key: '00', parentKey: null, isMap: false })
  return parsed.createdAt || fallback
}
