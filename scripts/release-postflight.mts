// scripts/release-postflight.mts —— 发布之后的收尾：给本版真机验证清单票补一条发布记录，并建下一版的占位清单票。
//
// 为什么要在发布之后自动做：清单票的下一版不能凭空冒出来。发布成功就是「这一版结束了、下一版开始了」这个
// 必然事件；在这里建占位票，下一版的场景从第一天就有地方登记，不会等到快发布时才发现没建票。
// 规则正文见 docs/agents/real-machine-verification.md 第 5 节。
//
// 本脚本由 scripts/publish-token.ps1 在发布成功之后调用（wizard-release.sh 的发布路径在 Stage 4 之后由人
// 按 Runbook 走，本脚本也可以在发布后手动补跑一次）。它失败不影响发布结果：调用方只记录一行 POST-FAIL，
// 下一次发布前检查发现缺票照样会拦住。
//
// 用法：node scripts/release-postflight.mts [--version <版本号>] [--evidence <发布证据文件>]
//   --version   刚发布的版本号，可带 v。缺省读仓根 package.json 的 version。
//   --evidence  发布脚本产出的发布证据 JSON（#1648）：每个实际发布包的逐文件清单统计（文件数、字节数、
//               清单指纹）与最终 dist-tag 指向。给了就把它们写进发布记录评论；不给时保留旧行为并打一行
//               POSTFLIGHT-INFO（五仓同步的 token 协议别处没有发布自证脚本，不能因此报错）。
//               证据文件的形状：
//                 { "version": "1.2.3", "packages": [{ "name": "...", "version": "...", "fileCount": 539,
//                   "totalBytes": 5481828, "digest": "64 位 sha256" }], "tags": { "latest": "...", "beta": "..." } }
// 退出码：0=收尾完成（或没有可补的票，只提示）；1=有一步失败（调用方记录，不改发布结论）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReleaseEnvError,
  extractChecklistTemplateBody,
  fillChecklistTemplate,
  ghText,
  isExactChecklistTitle,
  isPlaceholderTitle,
  listChecklistIssues,
  localIso,
  normalizeTitle,
  PLACEHOLDER_WORD,
  readPackageVersion,
  TITLE_PREFIX,
} from './lib/release-checklist.mts'

type Issue = {
  number: number
  title: string
  state: string
  url: string
}

type Options = {
  version: string
  evidencePath: string
}

/** 一个实际发布包的清单统计：与 scripts/release-integrity.mts 写出的清单文件同名同义。 */
export type PublishEvidencePackage = {
  name: string
  version: string
  fileCount: number
  totalBytes: number
  digest: string
}

/** 发布脚本交给本脚本的发布证据：发出去的是什么字节、最终 tag 指向哪里。 */
export type PublishEvidence = {
  version: string
  packages: PublishEvidencePackage[]
  tags: { latest?: string; beta?: string }
}

export type PublishRecordInput = {
  version: string
  nextIssueNumber: number | null
  evidence: PublishEvidence | null
  now: Date
}

function parseArgs(argv: string[]): Options | null {
  const options: Options = { version: '', evidencePath: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version' || arg === '--evidence') {
      const value = argv[index + 1]
      if (!value) throw new Error(arg + ' is missing its value.')
      if (arg === '--version') options.version = value
      else options.evidencePath = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      // 用法请求不是错误，但也不能当成正常参数继续跑：用 null 把它与「参数写错」分开，
      // 免得靠一个只有本文件知道的异常字符串当控制流。
      return null
    } else {
      throw new Error('Unknown argument: ' + arg)
    }
  }
  return options
}

/**
 * 拼「## 发布记录」这条评论的正文。
 *
 * 抽成纯函数是为了能被门禁直接调用验内容（tests/verify-1648-release-integrity.ts）：评论发出去之后
 * 就改不动了，格式与字段在这之前就该被断言过，而不是等发布完再靠人看。
 *
 * 证据缺省时保留旧版本那六行并写明「这次没有机器对账证据」。不假装有：没证据就写没有，
 * 比印一行看不懂的占位强。
 */
export function buildPublishRecordLines(input: PublishRecordInput): string[] {
  const version = String(input.version).trim().replace(/^[vV]/, '')
  const lines: string[] = [
    '## 发布记录',
    '',
    '- Released version: v' + version,
    '- Release time: ' + localIso(input.now),
    '- Release notes: see the "v' + version + '" section of CHANGELOG.md',
  ]
  const evidence = input.evidence
  if (evidence && evidence.packages.length > 0) {
    for (const pkg of evidence.packages) {
      lines.push(
        // 指纹写全：发布记录是「发出去的字节」的凭据，截断之后就没法拿它去和发布日志里那一行比对。
        '- 发布包逐文件清单：' + pkg.name + '@' + pkg.version + '，' + String(pkg.fileCount) + ' 个文件，' +
          String(pkg.totalBytes) + ' 字节，清单指纹 sha256:' + String(pkg.digest),
      )
    }
    const tags = evidence.tags || {}
    lines.push('- dist-tag 最终指向：latest → ' + (tags.latest || '（不存在）') + '，beta → ' + (tags.beta || '（不存在）'))
  } else {
    lines.push('- 发布包逐文件清单：（这次没有机器对账证据：发布脚本未产出，或没有走完「发布→拉回→比对」的包）')
  }
  lines.push('- 下一版清单票：' + (input.nextIssueNumber ? '#' + input.nextIssueNumber : '（这次没建出来，发布前检查会拦下一版）'))
  lines.push('', 'This version is published. Installing is done on the user side: marketplace upgrade, in-app upgrade, or running the install command yourself.', 'This ticket stays closed; register real-machine verification scenarios for the next version on the next version checklist ticket.')
  return lines
}

/**
 * 读并校验发布脚本交来的证据文件。
 *
 * 校验得松一点没有好处：证据文件坏掉时最坏的结果是发布记录里少一行关键信息，而那一行正是
 * #1648 要让发布记录「自己说得清」的东西。字段不全就直接失败，让人看到 POSTFLIGHT-FAIL。
 */
function readEvidenceFile(filePath: string): PublishEvidence {
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error('Cannot read the file pointed to by --evidence ("' + filePath + '"): ' + String(error))
  }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('The --evidence file ("' + filePath + '") is not valid JSON: ' + String(error))
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The --evidence file ("' + filePath + '") is not an object.')
  if (typeof parsed.version !== 'string' || parsed.version === '') throw new Error('The --evidence file is missing the version field.')
  if (!Array.isArray(parsed.packages)) throw new Error('The --evidence file is missing the packages array.')
  const packages: PublishEvidencePackage[] = []
  for (const raw of parsed.packages) {
    if (!raw || typeof raw.name !== 'string' || typeof raw.version !== 'string') {
      throw new Error('A package in the --evidence file is missing name/version.')
    }
    packages.push({
      name: raw.name,
      version: raw.version,
      fileCount: Number(raw.fileCount) || 0,
      totalBytes: Number(raw.totalBytes) || 0,
      digest: typeof raw.digest === 'string' ? raw.digest : '',
    })
  }
  const tagsRaw = parsed.tags && typeof parsed.tags === 'object' ? parsed.tags : {}
  return {
    version: parsed.version,
    packages,
    tags: {
      latest: typeof tagsRaw.latest === 'string' && tagsRaw.latest !== '' ? tagsRaw.latest : undefined,
      beta: typeof tagsRaw.beta === 'string' && tagsRaw.beta !== '' ? tagsRaw.beta : undefined,
    },
  }
}

let failed = false

function fail(message: string): void {
  failed = true
  console.error('POSTFLIGHT-FAIL ' + message)
}

function ok(message: string): void {
  console.log('POSTFLIGHT-OK ' + message)
}

function info(message: string): void {
  console.log('POSTFLIGHT-INFO ' + message)
}

/** 从 gh issue create 的输出里取票号：成功时它只打印一行票面网址。 */
function issueNumberFromUrl(text: string): number {
  const matched = /\/issues\/(\d+)/.exec(String(text || ''))
  return matched ? Number(matched[1]) : 0
}

function createIssue(title: string, body: string): Issue | null {
  let output = ''
  try {
    output = ghText(['issue', 'create', '--title', title, '--body', body])
  } catch (error) {
    fail('Failed to create the next version placeholder checklist ticket: ' + (error instanceof ReleaseEnvError ? error.message : String(error)))
    return null
  }
  const number = issueNumberFromUrl(output)
  const url = String(output || '').trim().split(/\s+/).pop() || ''
  if (!number) {
    fail('The issue create command returned output that could not be parsed; the ticket may already exist, please confirm manually: ' + String(output || '').trim())
    return null
  }
  ok('Created the next version placeholder checklist ticket #' + number + ' "' + title + '"' + (url ? ' ' + url : ''))
  return { number, title, state: 'OPEN', url }
}

function main(): void {
  let options: Options
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed === null) {
      console.log('Usage: node scripts/release-postflight.mts [--version <version>] [--evidence <release evidence file>]')
      process.exit(0)
    }
    options = parsed
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  let version = ''
  try {
    version = options.version ? options.version : readPackageVersion()
  } catch (error) {
    fail(error instanceof ReleaseEnvError ? error.message : String(error))
    process.exit(1)
  }
  const versionNumber = String(version).trim().replace(/^[vV]/, '')
  if (!versionNumber) {
    fail('The version is empty: pass --version, or confirm package.json has a version.')
    process.exit(1)
  }
  info('Version just published: ' + versionNumber)

  let evidence: PublishEvidence | null = null
  if (options.evidencePath) {
    try {
      evidence = readEvidenceFile(options.evidencePath)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
    if (evidence.version.trim().replace(/^[vV]/, '') !== versionNumber) {
      fail('The version in --evidence is ' + evidence.version + ', which does not match the version being published (' + versionNumber + ').')
      process.exit(1)
    }
    info(
      'Release evidence: ' + evidence.packages.length + ' packages, dist-tag latest=' + (evidence.tags.latest || '(missing)') +
        ', beta=' + (evidence.tags.beta || '(missing)'),
    )
  } else {
    info('No --evidence given: the release record will not include the per-file manifest or dist-tag targets (legacy behavior of the five-repo sync).')
  }

  let issues: Issue[] = []
  try {
    issues = listChecklistIssues()
  } catch (error) {
    fail(error instanceof ReleaseEnvError ? error.message : String(error))
    process.exit(1)
  }

  const exact = issues.filter((issue) => isExactChecklistTitle(issue.title, versionNumber))
  const placeholders = issues.filter((issue) => isPlaceholderTitle(issue.title))

  let nextIssue: Issue | null = placeholders.length > 0 ? placeholders[0] : null
  if (nextIssue) {
    info('The next version placeholder checklist ticket already exists: #' + nextIssue.number + ' "' + normalizeTitle(nextIssue.title) + '"')
  } else {
    const placeholderTitle = TITLE_PREFIX + ' ' + PLACEHOLDER_WORD + '（自 v' + versionNumber + ' 之后）'
    let body = ''
    try {
      body = fillChecklistTemplate(extractChecklistTemplateBody(), '待定（发布准备时确定并改标题）', versionNumber)
    } catch (error) {
      fail('Failed to read the checklist ticket body template: ' + (error instanceof ReleaseEnvError ? error.message : String(error)))
    }
    if (body) {
      nextIssue = createIssue(placeholderTitle, body)
    }
  }

  if (exact.length === 0) {
    fail('No checklist ticket titled "' + TITLE_PREFIX + ' ' + versionNumber + '" was found, so there is no checklist ticket to add the release record to. The next version placeholder ticket is already handled.')
    process.exit(failed ? 1 : 0)
  }
  if (exact.length > 1) {
    fail(
      'There are ' + exact.length + ' checklist tickets titled "' + TITLE_PREFIX + ' ' + versionNumber + '", so it is unclear which one to update: ' +
        exact.map((issue) => '#' + issue.number).join(', ') + '.',
    )
    process.exit(1)
  }

  const issue = exact[0]
  const lines = buildPublishRecordLines({
    version: versionNumber,
    nextIssueNumber: nextIssue ? nextIssue.number : null,
    evidence,
    now: new Date(),
  })
  try {
    ghText(['issue', 'comment', String(issue.number), '--body', lines.join('\n')])
  } catch (error) {
    fail('Failed to add the release record to checklist ticket #' + issue.number + ': ' + (error instanceof ReleaseEnvError ? error.message : String(error)))
    process.exit(1)
  }
  ok('Added the release record to checklist ticket #' + issue.number + ' "' + normalizeTitle(issue.title) + '"')
  process.exit(failed ? 1 : 0)
}

// 只有被直接执行时才跑 main()：tests/verify-1648-release-integrity.ts 会 import 这个文件里的
// buildPublishRecordLines() 验发布记录正文，import 不能顺手去调 gh。
const invokedDirectly = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false
if (invokedDirectly) main()
