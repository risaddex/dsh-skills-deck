/**
 * src/host/deckTicket.ts —— 会话 → workspace → 一张票的结构化详情的只读宿主电话（#72）。
 *
 * 一句话说清它做什么：手机上的只读面板点开一张票时，用这条电话按那次对话的 sessionId 把它读成
 * 一份窄而完整的详情 —— 标题、状态、标签、正文、验收标准、进度、阻塞者；不带评论。
 *
 * 为什么复用而不是另起一条读路径（规格 #70）：workspace 由现有 wf.cwd 解析、后端选择与只读权限由
 * 现有 openSession 承担、票本身由 Tracker 契约的 get 读。本文件只做一件事：把契约回来的那张票
 * 投影成面板要的形状，所以 GitHub / GitLab / 本地 Markdown / Linear 四个后端天然走同一条路。
 *
 * 三条不能改的约定：
 * 1. 失败三态分得开：缺票（not-found）、读失败（后端自己的原因）、回包读不成形状（parse）。
 *    面板对缺票与读失败说两种话，混在一起就没法决定「这张票没了」还是「等一下再试」。
 * 2. 评论绝不进回包：规格 #70 明确第一版不读评论，回包连一格评论字段都不留。
 * 3. 不知道与空是两件事：后端整格没给标签 / 阻塞者时省略那一格，明确给空数组就回空数组。
 */

import { parseProgressDetail } from '../tracker/body-parse.js'
import { ERROR_KIND } from '../tracker/contract/vocabulary.js'
import {
  blockersOf,
  failureOf,
  errorTextOf,
  numberOrNull,
  resolveDeckReadSession,
  stateOf,
  stringOf,
  type DeckReadBlocker,
  type DeckReadDeps,
} from './deckReadScope.js'

/** 本电话的依赖：与树读完全同一份（会话解析 + 只读会话）。 */
type Deps = DeckReadDeps

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
  state: string
  url: string
  labels?: DetailLabel[]
  body: string
  acceptanceCriteria: AcceptanceItem[]
  progress: Progress
  blockedBy?: DeckReadBlocker[]
}

/**
 * 验收标准的标题写法：新建的票写英文（本仓英文优先），老票写中文。
 * 为什么按整句比而不是按子串：按子串会让「Acceptance criteria (draft)」这类自造标题也算命中，
 * 而它下面通常没有勾选项，读出来就是一张「没有验收标准」的假结论。
 */
const ACCEPTANCE_TITLES: readonly string[] = ['acceptance criteria', 'acceptance', '验收标准', '验收条件']

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
 * 只认二级「## 验收标准」区里第一层勾选项；围栏里的示例不算。找不到那个区、或区里没有勾选项时
 * 回空数组 —— 「这张票没写验收标准」是这次读得出的结论，不是不知道，所以不省略这一格。
 */
export function parseAcceptanceCriteria(body: unknown): AcceptanceItem[] {
  const text = body == null ? '' : String(body)
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const out: AcceptanceItem[] = []
  let inside = false
  let fence = ''
  for (const line of lines) {
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

/** 把契约回来的一张票投影成面板要的详情（纯函数：同样的票永远得到同样的详情）。 */
function detailOf(issue: any, requestedKey: string): TicketDetail {
  const key = stringOf(issue && issue.key).trim() || requestedKey
  const body = typeof (issue && issue.body) === 'string' ? issue.body : ''
  const detail: TicketDetail = {
    key,
    number: numberOrNull(issue && issue.number, key),
    title: stringOf(issue && issue.title),
    state: stateOf(issue && issue.state),
    url: stringOf(issue && issue.url),
    body,
    // 进度与验收标准都从正文读，与桌面面板同一份解析（parseProgressDetail 是共享叶子）。
    acceptanceCriteria: parseAcceptanceCriteria(body),
    progress: parseProgressDetail(body),
  }
  const labels = labelsOf(issue)
  if (labels !== undefined) detail.labels = labels
  const blockedBy = blockersOf(issue)
  if (blockedBy !== undefined) detail.blockedBy = blockedBy
  return detail
}

/**
 * 组装电话。依赖显式传入：会话解析、只读会话与后端选择各只有一条来源。
 */
export function createDeckTicketRead(deps: Deps): { handleTicket: (args?: any) => Promise<any> } {
  const scope: Deps = Object.assign({ readLabel: 'The deck ticket could not be read' }, deps)

  async function handleTicket(args?: any): Promise<any> {
    const resolved = await resolveDeckReadSession(scope, args && args.sessionId)
    if (!resolved.ok) return resolved

    // 票号收成非空字符串：客户端可能送数字，也可能送字符串；空白一律当没给。
    const rawKey = args && args.key
    const key = (typeof rawKey === 'number' && Number.isFinite(rawKey)) ? String(rawKey) : stringOf(rawKey).trim()
    if (!key) return { ok: false, error: { kind: 'no-key', message: 'Missing the ticket key to read' } }

    let got: any
    try {
      // 只要那张票本身：评论按规格不读，反向阻塞边也不读（详情显示的是「谁挡着我」）。
      got = await resolved.call((session: any, ctx: any) => session.get(resolved.repoRef, key, {}, ctx))
    } catch (e) {
      return { ok: false, error: { kind: 'fetch-failed', message: errorTextOf(e, 'The deck ticket could not be read') } }
    }
    if (!got || got.ok !== true) {
      const failed = failureOf(got, 'fetch-failed', 'The deck ticket could not be read')
      // 缺票单独说话：契约用 not-found 表示「这个票号不存在」（GitHub 404）。面板据此说「这张票没了」，
      // 而不是「读失败、等一下再试」——后者会让人一直等一张不存在的票。
      if (failed.error.kind === ERROR_KIND.NOTFOUND) return { ok: false, error: { kind: ERROR_KIND.NOTFOUND, message: failed.error.message } }
      return failed
    }
    const issue = got.data
    if (!issue || typeof issue !== 'object') {
      return { ok: false, error: { kind: 'parse', message: 'The tracker read returned no ticket row' } }
    }

    return {
      ok: true,
      sessionId: resolved.sessionId,
      workspaceRoot: resolved.workspaceRoot,
      backendId: resolved.backendId,
      ticket: detailOf(issue, key),
    }
  }

  return { handleTicket }
}

export default { createDeckTicketRead }
