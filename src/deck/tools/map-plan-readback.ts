// src/deck/tools/map-plan-readback.ts —— 地图骨架建完之后的读回核对（#1413；从 map-plan-create.ts 拆出）
//
// 为什么单独拆：这段核对（地图五节齐不齐、有没有 ## Progress、子票的必备标签与类型标签对不对、父票指向谁、
// ## Progress 在不在、Type 行写对没有）有六十多行，留在 map-plan-create.ts 里会把那份文件顶过
// tests/verify-file-granularity.ts 的 350 行有效行上限。拆出来一行行为都没动：发后端的次数、
// notes 与 items 的文案和先后顺序，与拆出来之前逐字一致。
//
// 不能改的约定（改任何一条，回执就不诚实了）：
//   1. 读不回来只说「这次没核对」，不判失败 —— 读不回来的原因可能是额度不够、网络不好或后端自己出错；
//      把「没读到」说成「没写好」，会让一次本来建成功的地图被报成 partial。
//   2. Type 行只在「读回来的正文像整份文件」时才核，判据是正文里有没有文件头注释（parentKey / created 那一行）。
//      为什么不按后端身份分支：工具层不许拿后端 id 做判断（tests/verify-deck-tools.ts 的静态扫描就查这个）；
//      而远端后端不把文件头注释落进正文，正文里本来就没有 Type 行可核，按形状判正好各走各的。
//   3. 这里只往外返回 notes 与 items 两摞文字，自己不发写请求、不写游标、不碰预算账本。
import { MAP_BLOCK_TITLES } from '../shell/minimal-spec.js'
import { ensureLabels } from '../rules/minimal-spec.js'
import { isTypeLabel } from '../rules/object-kind.js'
import type { CreateKindResolution } from '../rules/object-kind.js'
import { stripProgressSections } from '../../shared/issue-file/src/progress.js'
import { failureFields } from '../shell/edge-landing.js'
import type { DeckTrackerLike } from '../../refresh/rooms/host/tool-call-budget-enforcement.js'

/** 建后读回核对的入参：全是调用方手上已经有的东西，这里不再取一次会话、不再选一次后端。 */
export interface MapPlanReadbackArgs {
  /** 后端门面（已过预算与钳制）；这里只用它的读票。 */
  tracker: DeckTrackerLike
  /** 仓库身份。 */
  repo: unknown
  /** 这次调用的后端上下文。 */
  opCtx: unknown
  /** 地图票号；空串表示地图票还没建成，这一步不做。 */
  mapKey: string
  /** 剩余额度是不是已经不够：不够就只记一句「这次没核对」。 */
  outOfBudget: boolean
  /** 上面按父票列出来的那一批子票；null 表示没列出来（拿不到）。 */
  liveRows: unknown[] | null
  /** 按父票列示时那句说明（子票没列出来时原样写进 notes）。 */
  pickedNote: unknown
  /** AI 传来的原始子票清单：只看 key，顺序决定核对顺序。 */
  children: Array<Record<string, unknown>>
  /** 入口处收口过的位置与标签答案，按计划内短标识索引。 */
  childKinds: Map<string, CreateKindResolution>
  /** 游标里「计划内短标识 → 真票号」的那张表。 */
  keys: Record<string, string>
}

/** 这一趟要追加到回执里的两部分：notes 是给人看的话，items 是逐项结果。 */
export interface MapPlanReadbackResult {
  notes: string[]
  items: Array<Record<string, unknown>>
}

/**
 * 建后读回核对：读一次地图票、再用按父票列出来的那一批逐张核子票，把没对上的地方逐条写出来。
 * 返回的两摞文字由调用方按顺序追加到回执的 notes / items 后面（这里不直接改回执，便于单独测试）。
 */
export async function readbackMapPlan(args: MapPlanReadbackArgs): Promise<MapPlanReadbackResult> {
  const notes: string[] = []
  const items: Array<Record<string, unknown>> = []
  // 地图票还没有票号（没建成），或者额度已经不够：只记那句「没核对」，与拆出来之前的两支逐字相同。
  if (!args.mapKey || args.outOfBudget) {
    if (args.outOfBudget) notes.push('Read-back check after building: not enough quota left, so this time no check was made.')
    return { notes: notes, items: items }
  }
  const tracker = args.tracker
  const repo = args.repo
  const opCtx = args.opCtx
  const mapKey = args.mapKey
  const children = args.children
  const childKinds = args.childKinds
  const keys = args.keys
  const liveRows = args.liveRows
  const problems: string[] = []
  let mapRow: Record<string, unknown> | null = null
  try {
    const gotMap = await tracker.get(repo, mapKey, {}, opCtx)
    mapRow = (gotMap && (gotMap as { ok?: unknown }).ok === true) ? (((gotMap as { data?: unknown }).data as Record<string, unknown> | null) || null) : null
  } catch (eGetMap) { mapRow = null }
  const mapBody = mapRow ? String(mapRow.body || '') : ''
  if (!mapRow) {
    notes.push('Read-back check after building: map ticket ' + mapKey + ' did not come back, so this time no check was made (not judged a failure).')
  } else {
    const heads = MAP_BLOCK_TITLES.map((h) => mapBody.indexOf('## ' + h))
    const missingHeads = MAP_BLOCK_TITLES.filter((h, i) => heads[i] < 0)
    if (missingHeads.length) problems.push('The map is missing these of the five sections: ' + missingHeads.join(', '))
    if (stripProgressSections(mapBody) === mapBody) problems.push('the map has no ## Progress section')
    const at = mapBody.search(/^##\s*(?:进度|Progress)\s*$/im)
    const knownHeads = heads.filter((i) => i >= 0)
    if (at >= 0 && knownHeads.length && at < Math.max.apply(null, knownHeads)) problems.push('the ## Progress of the map is not placed after the five sections')
  }
  const rows = Array.isArray(liveRows) ? (liveRows as Record<string, unknown>[]) : []
  const rowByKey = new Map<string, Record<string, unknown>>()
  for (const row of rows) if (row && row.key !== undefined && row.key !== null) rowByKey.set(String(row.key), row)
  // 只有读回来的正文是「整份文件」时才核 Type 行：本地 Markdown 房把整个文件当正文回，文件头除了
  // 幂等锚还会多出 parentKey 与 created 两行注释、正文里有 Status/Labels/Type 字段行；远端房这两行
  // 文件头注释不会落进正文（父边走原生边），正文也就没有 Type 行可核。这里按读回数据的形状判断，
  // 不按后端身份分支 —— 工具层不许拿后端 id 做判断（verify-deck-tools 的静态扫描就查这个）。
  // #1487 起本地后端写的是随包原文布局，文件头注释换成 DSH-FORMAT / DSH-PARENT / DSH-CREATED
  // 三条隐藏注释；只认老写法（parentKey / created 裸名字）会让原文布局的子票永远跳过 Type 行核对，
  // 回执里那句「核对通过」就成了没核过的假话。老写法保留：旧布局的票仍要能读回核对。
  // 注意不能把 DSH-IDEMPOTENCY-KEY 算进判据：远端后端也把这个幂等锚注释写进正文，算进来会把远端票
  // 误判成「整份原文文件」，去核它根本没有的 Type 行，回执就变成误报失败（#1487 提交时踩过这一脚）。
  const looksLikeWholeFile = (text: string): boolean => /^\s*<!--\s*(?:parentKey|created|DSH-FORMAT|DSH-PARENT|DSH-CREATED)\s*:/m.test(text)
  let checkedTypeLine = false
  for (const ch of children) {
    const planKey = String(ch.key)
    const ticketKey = String(keys[planKey] || '')
    const resolved = childKinds.get(planKey)
    if (!ticketKey || !resolved || !resolved.ok) continue
    const row = rowByKey.get(ticketKey)
    if (!row) { problems.push('sub-issue "' + planKey + '" (ticket ' + ticketKey + ') was not listed under the parent'); continue }
    const childBody = String(row.body || '')
    const names = (Array.isArray(row.labels) ? row.labels : []).map((x) => {
      return (typeof x === 'string') ? x : String((x && (x as { name?: unknown }).name) || '')
    }).filter(Boolean)
    const lower = names.map((n) => String(n).toLowerCase())
    // #1832：显式给过 triage 状态的子票，读回时不该再期待位置默认的那一枚；用与建票同一个函数算期望。
    const expected = ensureLabels(resolved.labels, resolved.kind || '', resolved.label).labels
    const missingLabels = expected.filter((n) => lower.indexOf(String(n).toLowerCase()) < 0)
    if (missingLabels.length) problems.push('sub-issue "' + planKey + '" is missing labels: ' + missingLabels.join(', '))
    // issue 兜底不推导类型标签、labels 原样传递（#1403）：它带 wayfinder:* 是调用方给的原样，不按「应为 0 枚」判错。
    // 其他位置值的类型标签由工具补，读回来枚数必须与应补的一致。
    if (resolved.kind !== 'issue') {
      const wantType = expected.filter((n) => isTypeLabel(n)).length
      const gotType = names.filter((n) => isTypeLabel(n)).length
      if (gotType !== wantType) problems.push('sub-issue "' + planKey + '" has ' + gotType + ' type labels (expected ' + wantType + ')')
    }
    if (String(row.parentKey || '') !== String(mapKey)) problems.push('sub-issue "' + planKey + '" is "' + String(row.parentKey || '') + '" (expected the map ' + mapKey + ')')
    if (stripProgressSections(childBody) === childBody) problems.push('sub-issue "' + planKey + '" has no ## Progress section')
    if (looksLikeWholeFile(childBody)) {
      checkedTypeLine = true
      const typeRows = childBody.match(/^\s*Type\s*[：:].*$/gm) || []
      if (resolved.kind === 'map-ticket') {
        const bare = String(resolved.label || '').replace(/^wayfinder:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const want = new RegExp('^\\s*Type\\s*[：:]\\s*' + bare + '\\s*$', 'im')
        if (!want.test(childBody)) problems.push('sub-issue "' + planKey + '" has a Type line that is not ' + bare + ' (got ' + typeRows.join(' / ').slice(0, 60) + ')')
      } else if (typeRows.length) {
        problems.push('sub-issue "' + planKey + '" should not have a Type line (got ' + typeRows.join(' / ').slice(0, 60) + ')')
      }
    }
  }
  if (problems.length) {
    notes.push('The read-back check after building found ' + problems.length + ' mismatches: ' + problems.slice(0, 4).join('; ') + (problems.length > 4 ? '; ...' : '') + '. Trust what is on disk, not the plan numbers.')
    // #1799：读回核对没对上也是失败项，要带映射码（本地来源 verify → 这条路走不通，以盘上为准），
    // 否则顶层 reason 只能瞎猜一个默认值。
    const ev = failureFields(null, 'write', 'verify')
    for (const one of problems.slice(0, 8)) items.push(Object.assign({ key: '', role: 'verify', status: 'failed', reason: one }, ev))
  } else if (mapRow && liveRows) {
    notes.push('The read-back check after building passed: the five map sections and ## Progress are all present; ' + Object.keys(keys).length + ' sub-issues: the parent, the type labels and ## Progress' + (checkedTypeLine ? ' and the Type line' : '') + ' all match.')
  } else {
    notes.push('Read-back check after building: the map came back, but the sub-issues were not listed under the parent (' + String(args.pickedNote || 'the backend did not give a reason') + '), so this time the sub-issues were not checked.')
  }
  return { notes: notes, items: items }
}

/**
 * 从失败项里挑一条最该先说的（与顶层 reason 同码的那条），返回拼在回执 text 后面的那句。
 * 多失败时 reason 按「安全优先」选，这里保证 text 说同一处，不让人看到两个不同的下一步；
 * 没有失败项、或 reason 是空串（只是没做完的 partial）时回空串。
 */
export function leadFailureText(items: ArrayLike<Record<string, unknown>>, reason: string): string {
  const failed: Array<Record<string, unknown>> = []
  for (let i = 0; i < items.length; i += 1) {
    const one = items[i]
    if (one && one.status !== 'ok') failed.push(one)
  }
  if (!failed.length || !reason) return ''
  const lead = failed.find((one) => one.code === reason) || failed[0]
  return ' The most important thing to say first is "' + String(lead.step || lead.role || '') + '": ' + String(lead.reason || 'the backend did not give a reason').slice(0, 160)
}
