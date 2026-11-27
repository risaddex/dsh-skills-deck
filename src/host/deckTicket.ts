/**
 * src/host/deckTicket.ts —— 会话 → workspace → 一张票的结构化详情的只读宿主电话（#72）。
 *
 * 一句话说清它做什么：手机上的只读面板点开一张票时，用这条电话按那次对话的 sessionId 把它读成
 * 一份窄而完整的详情 —— 标题、状态、标签、正文、验收标准、进度、阻塞者；不带评论。
 *
 * 为什么复用而不是另起一条读路径（规格 #70）：workspace 由现有 wf.cwd 解析、后端选择与只读权限由
 * 现有 openSession 承担、票本身由 Tracker 契约的 get 读。本文件只做一件事：把契约回来的那张票
 * 投影成面板要的形状，所以四个后端天然走同一条路。
 *
 * 四条不能改的约定：
 * 1. 失败分得开：缺票（契约说的 not-found）、读失败（后端自己的原因）、回包读不成形状（parse）。
 *    面板靠这个差别决定说「这张票没了」还是「等一下再试」；把三者混成一个 ok=false 就没法决定。
 * 2. 评论不进回包：规格 #70 第一版不显示评论，所以回包里连一格评论字段都没有，读票时也不向契约要
 *    评论正文（见下面 get 的 opts）。
 * 3. 不知道与空是两件事：后端整格没给标签 / 阻塞者 / 状态时省略那一格，明确给空数组就回空数组。
 * 4. 一份详情不整份过手机那条通道：整份投影过大时回 oversized 失败，绝不交半份正文 —— 半份正文会被
 *    面板当成完整正文读，比失败更糟。上限与量法都在共用开头（deckReadSession 的 oversizedFailureOf），
 *    数字住在契约层的 DECK_READ_LIMITS，树读用的是同一道护栏。
 */

import { parseProgressDetail } from '../tracker/body-parse.js'
import { isSpecHeaderMarked } from '../shared/issue-file/src/marker.js'
import { PROMPT_FRAGMENT_DATA, PROMPT_TEMPLATE_DATA, type PromptTemplateId } from '../client/kernel/prompt-data.js'
import { LOCALE_COPY } from '../client/kernel/locale-data.js'
import { containerKindOf, containerStateOf, containerTriState } from '../client/kernel/container-view.js'
import { checkPromptOverrideText } from '../client/kernel/settings-prompt-overrides.js'
import { rowActionKind } from '../client/kernel/row-actions.js'
import { DECK_READ_LIMITS, type DeckTicketAction } from '../tracker/contract/deck-read.js'
import { resolveDeckReadSession, errorTextOf, failureOf, oversizedFailureOf, type DeckReadDeps } from './deckReadSession.js'
import { blockersOf, numberOrNull, stateOf, stringOf, type DeckReadBlocker } from './deckReadRow.js'

/** 标签片：名字必给；后端不给颜色时是空串（契约里的 Label 就是这个口径，这里不另造一种）。 */
type DetailLabel = { name: string; color: string }

/** 验收标准的一条：原文与是否已勾选。 */
type AcceptanceItem = { text: string; done: boolean }

/** 进度区里的一条记录（与共享的 parseProgressDetail 同一个形状）。 */
type ProgressEntryRow = { percent: number; note: string; updatedAt: string | null }

/** 结构化进度：没写进度时 percent 是 null（不是 0），entries 为空。 */
type Progress = { percent: number | null; note: string; updatedAt: string | null; entries: ProgressEntryRow[] }

/** 一张票的详情：规格 #70 点名的那七样，加上把回包与树里那一行对上的身份。 */
type TicketDetail = {
  key: string
  number: number | null
  title: string
  /** 生命周期两态（OPEN / CLOSED），与树里那一行同口径。 */
  state: string
  /**
   * triage 状态（只有本地 Markdown 后端会给，例如 needs-triage、ready-for-agent）。
   * 为什么两态不够：一张票可以「还开着」但已经不是「可接」的状态，面板要能看出这件事；
   * 后端不报这一格时整格省略 —— 缺席不等于「没有状态」。
   */
  status?: string
  url: string
  actions?: DeckTicketAction[]
  labels?: DetailLabel[]
  body: string
  acceptanceCriteria: AcceptanceItem[]
  progress: Progress
  blockedBy?: DeckReadBlocker[]
}

/**
 * 验收标准的标题写法：新建的票写英文（本仓英文优先），老票写中文「验收标准」。
 *
 * 为什么按整句比而不是按子串：按子串会让「Acceptance criteria (draft)」这类自造标题也算命中，
 * 而它下面通常没有勾选项，读出来就是一张「没有验收标准」的假结论。
 *
 * 与写侧的关系：本地 Markdown 房建票时（src/tracker/rooms/markdown/create-render.ts 的
 * ACCEPTANCE_LINE_RE）把这种复选框行写进模板的验收项位置；这里按区读回它写下的同一批行。
 * 两处认的行形状一致（`- [ ]` / `- [x]`），区别只在读的是二级区、写的是模板位置，不是两条数据路径。
 */
const ACCEPTANCE_TITLES: readonly string[] = ['acceptance criteria', '验收标准', '验收条件']

/** 勾选项：`- [ ]`、`* [x]`、`+ [X]` 都认；方括号里只认空格与 x/X。 */
const CHECKBOX_RE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/
/** 标题行：`## 什么东西`（一到六级；只以二级切区，但任何级别的标题都结束当前区）。 */
const HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*$/
/** 代码围栏起止：围栏里的示例不该被当成真勾选项。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/** 标题归一：去强调符号与首尾空白，压成小写，弯引号按直引号比。 */
function normalizeTitle(raw: string): string {
  return String(raw || '')
    .replace(/[*_`]/g, '')
    .replace(/\u2019/g, "'")
    .trim()
    .toLowerCase()
}

/**
 * 从正文里读验收标准。
 *
 * 只认二级「## 验收标准」区里第一层的勾选项；围栏里的示例不算。找不到那个区、或区里没有勾选项时
 * 回空数组 —— 「这张票没写验收标准」是这次读得出的结论，不是不知道，所以不省略这一格。
 */
function parseAcceptanceCriteria(body: unknown): AcceptanceItem[] {
  const text = body == null ? '' : String(body)
  if (!text) return []
  const out: AcceptanceItem[] = []
  let inside = false
  let fence = ''
  for (const line of text.split(/\r?\n/)) {
    const fenced = FENCE_RE.exec(line)
    if (fenced) {
      const mark = fenced[1].charAt(0)
      if (!fence) fence = mark
      else if (fence === mark) fence = ''
      continue
    }
    if (fence) continue
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      if (inside && level <= 2) break
      if (level === 2) inside = ACCEPTANCE_TITLES.indexOf(normalizeTitle(heading[2])) >= 0
      continue
    }
    if (!inside) continue
    const item = CHECKBOX_RE.exec(line)
    if (!item) continue
    const itemText = item[2].trim()
    if (!itemText) continue
    out.push({ text: itemText, done: item[1] !== ' ' })
  }
  return out
}

/** 标签片：名字从字符串或 {name} 里取，颜色有才带；没有名字的条目丢掉（不显示 [object Object]）。 */
function labelsOf(issue: any): DetailLabel[] | undefined {
  if (!Array.isArray(issue && issue.labels)) return undefined
  const out: DetailLabel[] = []
  for (const raw of issue.labels) {
    if (typeof raw === 'string') {
      const name = raw.trim()
      if (name) out.push({ name, color: '' })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const name = stringOf((raw as any).name).trim()
    if (!name) continue
    out.push({ name, color: stringOf((raw as any).color).trim() })
  }
  return out
}

/** 只把可安全打开的跟踪器链接送到手机；本地票仍可用票号预填提示词。 */
function trackerUrlOf(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return ''
  try {
    const url = new URL(value)
    return url.hostname && !url.username && !url.password ? value : ''
  } catch { return '' }
}

type ContainerStats = { total: number; closed: number }

/** 优先用契约的权威计数；没有计数才读同一只读会话下的一份完整子票。 */
async function readContainerStats(issue: any, resolved: ResolvedDeckRead, key: string): Promise<ContainerStats | undefined> {
  const counts = issue.fieldStates?.subIssues
  if (counts?.known === true) {
    const { total, completed } = counts.value || {}
    if (Number.isSafeInteger(total) && Number.isSafeInteger(completed) && completed >= 0 && total >= completed) {
      return { total, closed: completed }
    }
  }
  try {
    const result = await resolved.call((session: any, ctx: any) => session.listSubIssues(resolved.repoRef, key, {}, ctx))
    const data = result?.data
    if (!result?.ok || result.truncated || !Array.isArray(data?.items) || data.capped !== false || data.missing !== 0
      || data.dropped !== 0 || data.fetched !== data.total || data.total !== data.items.length) return undefined
    const states = data.items.map((row: any) => String(row?.state ?? '').toUpperCase())
    if (!states.every((state: string) => state === 'OPEN' || state === 'CLOSED')) return undefined
    return { total: states.length, closed: states.filter((state: string) => state === 'CLOSED').length }
  } catch { return undefined }
}

type ResolvedDeckRead = Extract<Awaited<ReturnType<typeof resolveDeckReadSession>>, { ok: true }>

type ActionSettings = { promptOverrides?: Record<string, unknown>; templates?: Record<string, unknown> }

/** 只生成输入框文案，不执行提示词；只取当前动作设置，不外送其它设置。 */
async function actionsOf(issue: any, detail: TicketDetail, resolved: ResolvedDeckRead, readSettings?: () => Promise<ActionSettings | undefined>): Promise<DeckTicketAction[] | undefined> {
  if (detail.state === 'CLOSED' || issue.mergedAt || !detail.blockedBy || detail.blockedBy.some((r) => r.state !== 'CLOSED')) return []
  const kind = containerKindOf(isSpecHeaderMarked(detail.body) ? { type: 'spec' } : issue)
  const url = detail.url || (/^[A-Za-z0-9-]+$/.test(detail.key) ? '#' + detail.key : '')
  if (!url) return undefined
  let id: string
  let templateId: PromptTemplateId
  let labelKey: string
  let stats: ContainerStats | undefined
  if (kind) {
    stats = await readContainerStats(issue, resolved, detail.key)
    if (!stats) return undefined
    const state = containerStateOf({ stats })
    templateId = kind === 'spec' ? (state === 'empty' ? 'specSplit' : state === 'done' ? 'specComplete' : 'specExecute')
      : (state === 'empty' ? 'mapInspect' : state === 'done' ? 'complete' : 'mapExecute')
    id = templateId
    labelKey = containerTriState(kind, state).labelKey
  } else {
    if (detail.labels === undefined) return undefined
    const action = rowActionKind({ labels: detail.labels })
    id = action
    templateId = `tpl.${action}`
    labelKey = `act.${action}`
  }
  const copy = LOCALE_COPY.en as Readonly<Record<string, string>>
  const label = copy[labelKey]
  const entry = PROMPT_TEMPLATE_DATA[templateId]
  let settings: ActionSettings | undefined
  try { settings = await readSettings?.() } catch { /* 没读到改写时照常用默认模板。 */ }
  const edited = settings?.promptOverrides?.[templateId]
  const legacy = !kind && id !== 'implement' ? settings?.templates?.[id] : undefined
  const override = typeof edited === 'string' && checkPromptOverrideText(entry, entry.en, edited).ok && edited.trim() ? edited : ''
  const oldTemplate = typeof legacy === 'string' && legacy.trim() && checkPromptOverrideText(entry, entry.en, legacy).ok ? legacy : ''
  const params: Record<string, string> = { url, n: detail.key, title: '', subIssue: PROMPT_FRAGMENT_DATA.newWayfinderWiring.en || '',
    total: String(stats?.total ?? 0), closed: String(stats?.closed ?? 0),
    cli: PROMPT_FRAGMENT_DATA.vocabularyDefaults.cli?.en || '', cliBrand: PROMPT_FRAGMENT_DATA.vocabularyDefaults.cliBrand?.en || '' }
  let prompt = (override || oldTemplate || entry.en).replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match)
  if (templateId === 'mapInspect' || templateId === 'mapExecute') prompt = '/wayfinder ' + url + '\n\n' + prompt
  if (id === 'execute' && !/^\/wayfinder\b/.test(prompt.trim())) prompt = '/wayfinder\n' + prompt
  return label && id.length <= DECK_READ_LIMITS.maxActionIdChars && label.length <= DECK_READ_LIMITS.maxActionLabelChars
    && new TextEncoder().encode(prompt).length <= DECK_READ_LIMITS.maxActionPromptBytes ? [{ id, label, prompt }] : undefined
}

/** 把契约回来的一张票投影成面板要的详情（纯函数：同样的票永远得到同样的详情）。 */
function detailOf(issue: any, requestedKey: string): TicketDetail {
  const key = stringOf(issue && issue.key).trim() || requestedKey
  const body = typeof (issue && issue.body) === 'string' ? issue.body : ''
  const detail: TicketDetail = {
    key,
    number: numberOrNull(issue && issue.number, key),
    title: stringOf(issue && issue.title),
    state: stateOf(issue && issue.state),
    url: trackerUrlOf(issue && issue.url),
    body,
    // 进度与验收标准都从正文读，与桌面面板同一份进度解析（parseProgressDetail 是共享叶子）。
    acceptanceCriteria: parseAcceptanceCriteria(body),
    progress: parseProgressDetail(body),
  }
  const status = stringOf(issue && issue.status).trim()
  if (status) detail.status = status
  const labels = labelsOf(issue)
  if (labels !== undefined) detail.labels = labels
  const blockedBy = blockersOf(issue)
  if (blockedBy !== undefined) detail.blockedBy = blockedBy
  return detail
}

/**
 * 组装电话。依赖显式传入：会话解析、只读会话与后端选择各只有一条来源。
 */
export function createDeckTicketRead(deps: DeckReadDeps & { readActionSettings?: () => Promise<ActionSettings | undefined> }): { handleTicket: (args?: any) => Promise<any> } {
  const notRead = 'The deck ticket could not be read'

  async function handleTicket(args?: any): Promise<any> {
    const resolved = await resolveDeckReadSession(deps, args && args.sessionId, notRead)
    if (!resolved.ok) return resolved

    // 票号收成非空字符串：客户端可能送数字，也可能送字符串；空白一律当没给。
    const rawKey = args && args.key
    const key = (typeof rawKey === 'number' && Number.isFinite(rawKey)) ? String(rawKey) : stringOf(rawKey).trim()
    if (!key) return { ok: false, error: { kind: 'no-key', message: 'Missing the ticket key to read' } }

    let got: any
    try {
      // 只要那张票本身：面板不显示评论，所以只要 0 条正文（契约把 comments.first=0 读成「不要正文」，
      // 后端仍可能取一条只为报总数 —— 这是契约自己的最小取法，不是这条电话要的）。
      // 反向阻塞边也不读：详情显示的是「谁挡着我」，那一格本来就在票上（Issue.blockedBy）。
      got = await resolved.call((session: any, ctx: any) => session.get(resolved.repoRef, key, { comments: { first: 0 } }, ctx))
    } catch (e) {
      return { ok: false, error: { kind: 'fetch-failed', message: errorTextOf(e, notRead) } }
    }
    if (!got || got.ok !== true) {
      // 缺票不另立结论：契约自己就用 not-found 说「这个票号不存在」（对应 GitHub 404），
      // 这里原样上送。面板按 error.kind 分辨「这张票没了」与「读失败、等一下再试」。
      return failureOf(got, 'fetch-failed', notRead)
    }
    const issue = got.data
    if (!issue || typeof issue !== 'object') {
      return { ok: false, error: { kind: 'parse', message: 'The tracker read returned no ticket row' } }
    }
    // 读成了却是一张没有任何身份的空行（键与标题都空）：这不是一张票，不能拿请求的票号把它装成一张。
    // 契约里 key 与 title 都是核心字段（永远存在），两者都空只可能是回包形状不对。
    if (!stringOf(issue.key).trim() && !stringOf(issue.title).trim()) {
      return { ok: false, error: { kind: 'parse', message: 'The tracker read returned a row without a ticket identity' } }
    }

    const detail = detailOf(issue, key)
    // Markdown 旧读遇到跨工作单元同号时可能返回第一张。这个窄口没有工作单元参数，
    // 在同一个已绑定的仓库里先证实匹配唯一；宁可拒绝详情，也不让手机在另一张票上预填动作。
    if (resolved.backendId === 'markdown') {
      let candidates: any
      try {
        candidates = await resolved.call((session: any, ctx: any) => session.list(resolved.repoRef, { keys: [detail.key] }, ctx))
      } catch { /* 无法确认身份时不提供回退结果。 */ }
      if (!candidates?.ok || candidates.truncated || !Array.isArray(candidates.data)) {
        return { ok: false, error: { kind: 'identity-unconfirmed', message: 'The local ticket identity could not be confirmed' } }
      }
      const sameKey = candidates.data.filter((row: any) => row?.key === detail.key)
      if (sameKey.length !== 1 || sameKey[0].effortId !== issue.effortId || sameKey[0].url !== issue.url) {
        return { ok: false, error: { kind: 'conflict', message: 'The local ticket key did not identify a unique ticket' } }
      }
    }
    const actions = await actionsOf(issue, detail, resolved, deps.readActionSettings)
    if (actions !== undefined) detail.actions = actions
    // 详情整份投影过一次字节护栏（树读用的是同一道，数字与量法都在 deckReadSession 那一处）：
    // 正文特别大的票不整份过通道，也不截半份交给面板 —— 半份正文被当成完整正文读，比失败更糟。
    const oversized = oversizedFailureOf(detail, 'deck ticket')
    if (oversized) return oversized

    return {
      ok: true,
      sessionId: resolved.sessionId,
      workspaceRoot: resolved.workspaceRoot,
      backendId: resolved.backendId,
      ticket: detail,
    }
  }

  return { handleTicket }
}

export default { createDeckTicketRead }
