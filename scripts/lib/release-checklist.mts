// scripts/lib/release-checklist.mts —— 版本真机验证清单票的读写小工具，发布前检查与发布后收尾共用。
//
// 为什么单独放一个文件：清单票靠标题前缀识别，而前缀、占位票写法、模板位置这三件事一旦两边各写一份，
// 早晚对不上——一边按「Next」找、一边按「下一版」找，发布检查就会误报缺票。前缀与机器可读格式定义在
// scripts/lib/release-checklist-format.mts，这里只负责「拿它们怎么读票」，并保留 TITLE_PREFIX /
// PLACEHOLDER_WORD 两个名字给调用方（#17 之后值是英文，中文写法作为兼容继续认）。
// 规则正文在 docs/agents/real-machine-verification.md，这里只认标题与 gh 的调用方式。
//
// 本文件负责读：列清单票、读版本号、取正文模板、读一张票的评论；以及拼标题。所有 gh 调用都走子进程，不改任何东西。
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ChecklistCommentInput } from './checklist-consistency.mts'
import {
  CHECKLIST_PLACEHOLDER_WORD,
  CHECKLIST_TITLE_PREFIX,
  LEGACY_PLACEHOLDER_WORD,
  LEGACY_TITLE_PREFIX,
} from './release-checklist-format.mts'

/** 清单票标题前缀（标准写法）。改这里等于改全仓的识别方式，先改规则文档。 */
export const TITLE_PREFIX = CHECKLIST_TITLE_PREFIX
/** 版本号还没定时占位票用的词：标题写成「[Real-machine verification] Next (since v1.9.0)」。 */
export const PLACEHOLDER_WORD = CHECKLIST_PLACEHOLDER_WORD

/**
 * 认标题时接受的前缀与占位词：英文是标准写法，中文是改版前的写法（在途票不改名也能走完发布流程）。
 * 读侧认两种、写侧只写英文，这条界线与理由写在 release-checklist-format.mts 的注释里。
 */
const ACCEPTED_PREFIXES = [CHECKLIST_TITLE_PREFIX, LEGACY_TITLE_PREFIX]
const ACCEPTED_PLACEHOLDER_WORDS = [CHECKLIST_PLACEHOLDER_WORD, LEGACY_PLACEHOLDER_WORD]

/** 拼正则时把前缀里的方括号当字面量，别让「[Real-machine verification]」被当成字符类。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 标题开头那一段：任一被接受的前缀。 */
const TITLE_HEAD = '(?:' + ACCEPTED_PREFIXES.map(escapeRegExp).join('|') + ')'
/** 带版本号的标题：前缀 + 版本号（第一段非空白）。 */
const EXACT_TITLE_PATTERN = new RegExp('^' + TITLE_HEAD + '\\s*(\\S+)')
/** 占位票标题：前缀 + 占位词。 */
const PLACEHOLDER_TITLE_PATTERN = new RegExp(
  '^' + TITLE_HEAD + '\\s*(?:' + ACCEPTED_PLACEHOLDER_WORDS.map(escapeRegExp).join('|') + ')',
)

const ISSUE_LIST_LIMIT = '400'
const TEMPLATE_REL = path.join('docs', 'agents', 'checklist-issue-template.md')
const TEMPLATE_START = '<!-- checklist-template:start -->'
const TEMPLATE_END = '<!-- checklist-template:end -->'

/** 本文件在 <仓根>/scripts/lib 下，往上两级就是仓根。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export type ChecklistIssue = {
  number: number
  title: string
  state: string
  url: string
  body: string
}

/** gh 缺失、未登录、网络失败这类环境问题：调用方按「环境错误」处理（发布路径上应停下并说明原因）。 */
export class ReleaseEnvError extends Error {
  exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.exitCode = exitCode
  }
}

/** 把标题里的连续空白压成一个空格，人工核对与机器比较用同一口径。 */
export function normalizeTitle(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/** 版本号比较时去掉开头的 v：票面写 v1.9.0-beta.31 与 package.json 的 1.9.0-beta.31 是同一版。 */
export function normalizeVersion(version: string): string {
  return String(version || '').trim().replace(/^[vV]/, '')
}

export function isChecklistTitle(title: string): boolean {
  return ACCEPTED_PREFIXES.some((prefix) => normalizeTitle(title).startsWith(prefix))
}

/** 从「[Real-machine verification] 1.9.0-beta.31」里取出 1.9.0-beta.31；不是清单票时返回空串。 */
export function checklistVersionOf(title: string): string {
  const matched = EXACT_TITLE_PATTERN.exec(normalizeTitle(title))
  return matched ? normalizeVersion(matched[1]) : ''
}

export function isExactChecklistTitle(title: string, version: string): boolean {
  return isChecklistTitle(title) && checklistVersionOf(title) === normalizeVersion(version)
}

/** 占位票：「[Real-machine verification] Next (since <上一发布版本>)」，中文写法「[真机验证] 下一版…」同样认。 */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE_PATTERN.test(normalizeTitle(title))
}

/** 跑一次 gh 并回读 stdout；失败时抛 ReleaseEnvError，让调用方用一句话说清是环境问题还是票面问题。 */
export function ghText(args: string[]): string {
  const result = spawnSync('gh', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) {
    throw new ReleaseEnvError('Cannot start the gh command (' + result.error.message + '). The release check needs the GitHub CLI; confirm gh is installed and on PATH.', 2)
  }
  if (result.status !== 0) {
    const tail = String(result.stderr || result.stdout || '').trim()
    throw new ReleaseEnvError('gh ' + args.join(' ') + ' failed (exit ' + result.status + '): ' + tail, 2)
  }
  return String(result.stdout || '')
}

/**
 * 列出仓里所有带清单票标题前缀的票（含已关闭），中英文前缀各查一次再合并。
 *
 * 为什么查两次：gh 的搜索按词匹配，一次给不了「A 或 B」。前缀里带方括号，而 GitHub 的搜索会把方括号
 * 当成分隔符，所以搜索词去掉方括号只留文字，真正的判定仍交给下面的 isChecklistTitle——搜索只负责缩小范围，
 * 决定「这张票算不算清单票」的永远是前缀本身。按票号去重：两次搜索理论上不交叉，但宁可多查一次也不重复。
 */
export function listChecklistIssues(): ChecklistIssue[] {
  const issues: ChecklistIssue[] = []
  const seen = new Set<number>()
  for (const prefix of ACCEPTED_PREFIXES) {
    const raw = ghText([
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      ISSUE_LIST_LIMIT,
      '--search',
      'in:title ' + prefix.replace(/[[\]]/g, ''),
      '--json',
      'number,title,state,url,body',
    ])
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new ReleaseEnvError('The checklist ticket list returned by gh is not valid JSON: ' + String(error), 2)
    }
    if (!Array.isArray(parsed)) {
      throw new ReleaseEnvError('The checklist ticket list returned by gh is not an array, so the checklist ticket state cannot be determined.', 2)
    }
    for (const item of parsed) {
      const row = item as Record<string, unknown>
      const title = String(row.title || '')
      if (!isChecklistTitle(title)) continue
      const number = Number(row.number)
      if (seen.has(number)) continue
      seen.add(number)
      issues.push({
        number,
        title,
        state: String(row.state || ''),
        url: String(row.url || ''),
        body: String(row.body || ''),
      })
    }
  }
  return issues
}

/**
 * 一张票的一条评论：正文 + 创建时间。评论是发布前一致性检查的另一半数据（票面正文是这一半）。
 * 形状直接沿用判据库里的 ChecklistCommentInput，两边不再各写一份，免得其中一个加了字段另一个没跟上。
 */
export type ChecklistComment = ChecklistCommentInput

/**
 * 读一张票的全部评论，按 gh 返回的顺序（REST 默认按创建时间升序）。
 *
 * 为什么不用 gh issue view --json comments：那条路只取前 100 条评论，清单票一版几十条批次记录攒下来很容易超过，
 * 超过之后一致性检查就会把「评论里没提过」误判成「正文多登记了场景」。REST 接口配 --paginate --slurp，
 * 会把每一页拼成一个数组再输出，这里逐页摊平。
 */
export function listIssueComments(issueNumber: number): ChecklistComment[] {
  const raw = ghText([
    'api',
    'repos/{owner}/{repo}/issues/' + String(issueNumber) + '/comments',
    '--paginate',
    '--slurp',
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ReleaseEnvError('The comment list returned by gh is not valid JSON: ' + String(error), 2)
  }
  if (!Array.isArray(parsed)) {
    throw new ReleaseEnvError('The comment list returned by gh is not an array, so the checklist ticket records cannot be checked.', 2)
  }
  // --slurp 的输出是「每一页一个数组」套在外层数组里；只有一页时同样是 [[...]]，逐页摊平即可。
  const items: unknown[] = []
  for (const page of parsed) {
    if (Array.isArray(page)) items.push(...page)
    else items.push(page)
  }
  const comments: ChecklistComment[] = []
  for (const item of items) {
    const row = item as Record<string, unknown>
    // 只走 REST 接口，字段名固定是 created_at（下划线）；没有别的来源，所以不再兼容驼峰写法。
    comments.push({
      body: String(row.body || ''),
      createdAt: String(row.created_at || ''),
    })
  }
  return comments
}

/** 读仓根 package.json 的 version。发布脚本都从这里取本版版本号，不重复传参。 */
export function readPackageVersion(): string {
  const pkgPath = path.join(REPO_ROOT, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new ReleaseEnvError('Cannot find ' + pkgPath + ', so the version of this release cannot be determined.', 2)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    throw new ReleaseEnvError('Cannot parse ' + pkgPath + ': ' + String(error), 2)
  }
  const version = normalizeVersion(String((parsed as Record<string, unknown>).version || ''))
  if (!version) {
    throw new ReleaseEnvError(pkgPath + ' has no version field, so the version of this release cannot be determined.', 2)
  }
  return version
}

/** 取 docs/agents/checklist-issue-template.md 里两枚标记之间的正文模板；标记被删时明确报错，不要静默用空正文。 */
export function extractChecklistTemplateBody(): string {
  const templatePath = path.join(REPO_ROOT, TEMPLATE_REL)
  if (!existsSync(templatePath)) {
    throw new ReleaseEnvError('Cannot find the checklist ticket body template ' + templatePath + '.', 2)
  }
  const text = readFileSync(templatePath, 'utf8')
  const start = text.indexOf(TEMPLATE_START)
  const end = text.indexOf(TEMPLATE_END)
  if (start < 0 || end < 0 || end <= start) {
    throw new ReleaseEnvError('Template ' + templatePath + ' does not contain both markers ' + TEMPLATE_START + ' and ' + TEMPLATE_END + '.', 2)
  }
  return text.slice(start + TEMPLATE_START.length, end).trim()
}

/** 把模板里的尖括号占位换成实际值。只换这三处，别处不动。 */
export function fillChecklistTemplate(body: string, versionLabel: string, previousVersion: string): string {
  return body
    .replaceAll('<版本号>', versionLabel)
    .replaceAll('<上一发布版本>', 'v' + normalizeVersion(previousVersion))
}

/** 本地时间写成带时区的 ISO 8601，票面时间与日志时间都是人读的，不写成 UTC。 */
export function localIso(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    'T' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  )
}
