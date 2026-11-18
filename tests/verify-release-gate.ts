// tests/verify-release-gate.ts —— 发布门禁接线的回归门禁。
//
// 覆盖的是 t16 阶段 2 在插件仓里新接的那条线：
//   scripts/lib/release-preflight-gate.mts  组合根（唯一 import runReleaseGate 的仓内文件）
//   scripts/release-preflight.mts           薄 CLI（只认 --version / --candidate）
//   verify/ticket-face.mts                  gh 适配器（真实发布路径用）
//   scripts/publish-token.ps1 / scripts/wizard-release.sh  两条发布路径的四态接线
//
// 规则本身由 base 的 runReleaseGate 负责，六条检查的用例在 base 仓里；这里证明的是
// 「插件仓把规则接上了、且两条发布路径走的是同一份代码」。所以：
//   - 门禁判定用 base 的库 API + 假票面适配器 + 假 git 命令端口，不读网络、不碰真 gh；
//   - 接线部分读真实源码做静态断言，并把 verify/ticket-face.mts 的真导出交给 base 的
//     validateTicketFaceAdapter 过一遍（它只查形状，不发起任何 IO）；
//   - 不启动实例、不改工作树、不写 D 盘。
//
// 接线检查（K 静态断言、L 子进程）在 tests/lib/release-gate-wiring.ts，由本文件调用并共用同一个断言计数。
// 它读的路径不再出现在本文件里，门禁归属表的自动推导看不到，所以下面显式声明：这扇门禁守着这几份文件，
// 改其中任何一份都应当选中它（自动推导的另一半，组合根与格式声明，仍由本文件的 import 推出来）。
// 门禁归属: scripts/release-preflight.mts
// 门禁归属: scripts/lib/release-preflight-gate.mts
// 门禁归属: scripts/lib/release-checklist-format.mts
// 门禁归属: tests/lib/release-gate-wiring.ts
// 门禁归属: tests/lib/gate-result.ts
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  createNodePorts,
  judgeChecklistConsistency,
  parseCandidateManifest,
  RELEASE_GATE_CHECK_IDS,
} from 'dsh-featherhunter-plugin-base/real-machine-verification'
import { runPreflightGate } from '../scripts/lib/release-preflight-gate.mts'
import { CHECKLIST_FORMAT, CHECKLIST_TITLE_PREFIX } from '../scripts/lib/release-checklist-format.mts'
import ticketFace from '../verify/ticket-face.mts'
import { printGateResult } from './lib/gate-result.ts'
import { runWiringChecks } from './lib/release-gate-wiring.ts'

const GATE = 'verify-release-gate'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const NEWLINE = String.fromCharCode(10)

const CANDIDATE = 'a'.repeat(40)
const RELEASE = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)
const TGZ = 'd'.repeat(64)
const FILE_DIGEST = 'e'.repeat(64)
const MANIFEST_DIGEST = 'f'.repeat(64)
const VERSION = '1.2.3'

let assertions = 0
let failed = 0

function check(ok: boolean, message: string, detail = ''): void {
  assertions++
  if (ok) {
    console.log('PASS ' + message)
    return
  }
  failed++
  console.log('FAIL ' + message + (detail === '' ? '' : '：' + detail))
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---- fixtures：票据记录与候选清单都按 base 的契约构造 ----

function releaseCandidate(
  overrides: { commit?: string; version?: string; validity?: 'release' | 'development' } = {},
): any {
  const parsed = parseCandidateManifest({
    schemaVersion: 2,
    generatedAt: '2026-01-02T03:04:05.000Z',
    tool: 'fake-freeze@0.1.5',
    version: overrides.version ?? VERSION,
    validity: overrides.validity ?? 'release',
    sourceStable: true,
    git: { commit: overrides.commit ?? CANDIDATE, branch: 'main', dirty: false, dirtyFiles: [] },
    package: {
      tgzPath: 'C:/repo/candidates/plugin-1.2.3.tgz',
      tgzBytes: 2048,
      tgzSha256: TGZ,
      filename: 'plugin-1.2.3.tgz',
      files: [{ path: 'package.json', bytes: 120, sha256: FILE_DIGEST }],
      fileCount: 1,
      fileDigest: FILE_DIGEST,
      manifestDigest: MANIFEST_DIGEST,
    },
  })
  if (!parsed.ok) throw new Error('candidate fixture is invalid: ' + parsed.error.message)
  return parsed.value
}

// 夹具按本仓声明的英文清单票格式写（scripts/lib/release-checklist-format.mts）：门禁按这份格式
// 精确匹配标题、总览表与状态词，夹具写中文就只能证明「以前那份能读」，证不了「现在换语言也能读」。
// 身份行、基线行、差异审计行是另一回事：它们的解析器两种语言都认（base 的 bilingual 部分），
// 所以夹具里两种写法都出现，证明换了格式之后旧的记录行仍然读得出来。
function identityLine(batch = 'batch-1', commit = CANDIDATE, sha = TGZ): string {
  return '- Verification identity: batch ' + batch + '; candidate commit ' + commit + '; candidate package sha256 ' + sha
}

function checklistBody(options: { status?: string; audit?: string } = {}): string {
  const lines = [
    '# Real-machine verification checklist ' + VERSION,
    '',
    '## Scenario overview',
    '| Scenario number | Source ticket | One sentence | Status | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| 1600-01 | #16 | release gate | ' + (options.status ?? 'passed') + ' | |',
  ]
  if (options.audit !== undefined) {
    lines.push('', '## Candidate and release difference audit', options.audit)
  }
  return lines.join(NEWLINE)
}

function checklistIssue(overrides: { number?: number; state?: 'OPEN' | 'CLOSED' | 'UNKNOWN'; body?: string } = {}): any {
  return {
    number: overrides.number ?? 12,
    title: CHECKLIST_TITLE_PREFIX + ' ' + VERSION,
    state: overrides.state ?? 'CLOSED',
    body: overrides.body ?? checklistBody(),
  }
}

function batchComment(
  options: { batch?: string; commit?: string; sha?: string; result?: string; identity?: boolean; identityLine?: string } = {},
): any {
  const result = options.result ?? 'passed'
  const passed = result === 'passed' ? 1 : 0
  const failedCount = result === 'failed' ? 1 : 0
  const lines = ['Batch start:']
  if (options.identity !== false) {
    lines.push(options.identityLine ?? identityLine(options.batch ?? 'batch-1', options.commit ?? CANDIDATE, options.sha ?? TGZ))
  }
  lines.push('Scenario 1600-01: ' + result)
  lines.push('[Ready to release] passed ' + String(passed) + ' / failed ' + String(failedCount) + ' / exempt 0')
  return { body: lines.join(NEWLINE) }
}

function fakeTicketFace(
  options: { issues?: any[]; comments?: any[]; releaseCommit?: string; ancestry?: boolean | 'unknown' } = {},
): any {
  return {
    kind: 'fake',
    async listChecklistIssues() {
      return [...(options.issues ?? [])]
    },
    async listComments(_issueNumber: number) {
      return [...(options.comments ?? [])]
    },
    async resolveReleaseCommit() {
      return options.releaseCommit ?? ''
    },
    async isAncestor() {
      return options.ancestry ?? true
    },
  }
}

function happyFace(overrides: Parameters<typeof fakeTicketFace>[0] = {}): any {
  return fakeTicketFace({
    issues: [checklistIssue()],
    comments: [batchComment()],
    releaseCommit: RELEASE,
    ...overrides,
  })
}

function fakeCommand(exitCode: number, stderr = ''): any {
  return {
    requests: [],
    async run(request: any) {
      this.requests.push(request)
      return {
        ok: true,
        value: {
          argv: request.argv,
          cwd: request.cwd ?? '',
          exitCode,
          signal: null,
          stdout: '',
          stderr,
          durationMs: 1,
          timedOut: false,
        },
      }
    },
  }
}

// 门禁只用到 command 端口（git）；适配器是直接传进去的对象，所以 fs 用真的也无妨。
function portsWithCommand(command: any): any {
  return createNodePorts({ overrides: { command } })
}

interface GateRun {
  exitCode: number
  report: any
  lines: Array<{ stream: 'out' | 'err'; text: string }>
  out: string
  err: string
}

async function runGate(overrides: Record<string, unknown> = {}): Promise<GateRun> {
  const outcome = await runPreflightGate({
    version: VERSION,
    releaseCommit: RELEASE,
    candidate: releaseCandidate(),
    ports: portsWithCommand(fakeCommand(0)),
    ticketFace: happyFace(),
    ...overrides,
  })
  const lines = [...outcome.lines]
  const out = lines.filter((line) => line.stream === 'out').map((line) => line.text).join(NEWLINE)
  const err = lines.filter((line) => line.stream === 'err').map((line) => line.text).join(NEWLINE)
  return { exitCode: outcome.exitCode, report: outcome.report, lines, out, err }
}

function statusOf(report: any, id: string): string {
  const found = (report?.checks ?? []).find((item: any) => String(item.id) === id)
  return found === undefined ? 'missing' : String(found.status)
}

function hasFinding(report: any, code: string): boolean {
  return (report?.findings ?? []).some((finding: any) => finding.code === code)
}

async function main(): Promise<void> {
  // ---- A. 主路径：一张完整清单票 + 冻结候选，门禁通过，CLI 标记齐全 ----
  {
    const run = await runGate()
    check(run.exitCode === 0, 'A1 完整清单票 + 合法候选 → 退出码 0', show(run.exitCode))
    check(run.report?.decision === 'pass', 'A2 报告 decision=pass', show(run.report?.decision))
    check(run.lines.every((line) => line.stream === 'out'), 'A3 通过时所有行都走 stdout（stderr 留给失败与阻塞）', show(run.lines.map((line) => line.stream)))
    check(run.out.includes('PREFLIGHT-OK'), 'A4 stdout 有 PREFLIGHT-OK 标记', run.out.split(NEWLINE).slice(-6).join(' / '))
    check(run.out.includes('v' + VERSION + ' at ' + RELEASE), 'A5 PREFLIGHT-OK 带版本与发布提交', '')
    check(run.out.includes('decision: pass (exit 0)'), 'A6 人类可读报告末尾有 decision 行', '')
    check(
      JSON.stringify((run.report?.checks ?? []).map((item: any) => String(item.id))) === JSON.stringify([...RELEASE_GATE_CHECK_IDS]),
      'A7 六项检查按契约顺序出现，一项不少',
      show((run.report?.checks ?? []).map((item: any) => String(item.id))),
    )
    check(statusOf(run.report, 'release-candidate-valid') === 'pass', 'A8 合法候选候选检查 pass', statusOf(run.report, 'release-candidate-valid'))
    check(statusOf(run.report, 'release-batch-identity') === 'pass', 'A9 身份行与候选一致', statusOf(run.report, 'release-batch-identity'))
    check(run.report?.ticket?.number === 12 && run.report?.ticket?.exactCount === 1, 'A10 报告记下唯一清单票 #12', show(run.report?.ticket))
    check(run.err === '', 'A11 通过时 stderr 为空', run.err)
  }

  // ---- B. 批次评论缺身份行 → fail / identity-missing，走 CHECK-FAIL 一路 ----
  {
    const run = await runGate({ ticketFace: happyFace({ comments: [batchComment({ identity: false })] }) })
    check(run.exitCode === 1, 'B1 缺身份行 → 退出码 1', show(run.exitCode))
    check(hasFinding(run.report, 'identity-missing'), 'B2 报告带 identity-missing finding', show(run.report?.findings?.map((f: any) => f.code)))
    check(run.err.includes('PREFLIGHT-FAIL Release gate rejects v' + VERSION), 'B3 stderr 有拒绝汇总行', run.err.split(NEWLINE)[0] ?? '')
    check(run.err.includes('PREFLIGHT-FAIL identity-missing: '), 'B4 每条 finding 都带「改法」行', '')
    check(!run.out.includes('PREFLIGHT-OK'), 'B5 失败时绝不出现 PREFLIGHT-OK', '')
    check(run.out.includes('decision: fail (exit 1)'), 'B6 人类可读报告仍完整打印', '')
  }

  // ---- C. 身份行指向别的提交 → identity-not-in-candidate ----
  {
    const run = await runGate({ ticketFace: happyFace({ comments: [batchComment({ commit: OTHER })] }) })
    check(run.exitCode === 1, 'C1 身份行候选提交与候选包不符 → 退出码 1', show(run.exitCode))
    check(hasFinding(run.report, 'identity-not-in-candidate'), 'C2 报告带 identity-not-in-candidate', show(run.report?.findings?.map((f: any) => f.code)))
    check(run.err.includes('PREFLIGHT-FAIL identity-not-in-candidate: '), 'C3 CLI 点名该 finding code', '')
  }

  // ---- D. 清单票还没关闭 → checklist-not-closed ----
  {
    const run = await runGate({ ticketFace: happyFace({ issues: [checklistIssue({ state: 'OPEN' })] }) })
    check(run.exitCode === 1, 'D1 清单票 OPEN → 退出码 1', show(run.exitCode))
    check(hasFinding(run.report, 'checklist-not-closed'), 'D2 报告带 checklist-not-closed', show(run.report?.findings?.map((f: any) => f.code)))
    check(run.err.includes('PREFLIGHT-FAIL checklist-not-closed: '), 'D3 CLI 点名该 finding code', '')
  }

  // ---- E. 候选不是发布提交的祖先、票面又没有差异审计 → 两条 finding 一起红 ----
  {
    const run = await runGate({ ticketFace: happyFace({ ancestry: false }) })
    check(run.exitCode === 1, 'E1 候选非祖先且无审计 → 退出码 1', show(run.exitCode))
    check(hasFinding(run.report, 'commit-not-ancestor'), 'E2 报告带 commit-not-ancestor', show(run.report?.findings?.map((f: any) => f.code)))
    check(hasFinding(run.report, 'audit-missing'), 'E3 报告带 audit-missing', '')
    check(run.report?.audit?.required === true && run.report?.audit?.covered === false, 'E4 报告记下「需要审计、未覆盖」', show(run.report?.audit))
    check(run.err.includes('PREFLIGHT-FAIL commit-not-ancestor: '), 'E5 CLI 把两条 finding 都打出来', '')
  }

  // ---- F. 票面写了差异审计 → 候选非祖先也能过，并打 PREFLIGHT-CANDIDATE-AUDIT ----
  {
    // 手写英文审计行：base 的 formatAuditLine 只会写中文（写侧还没有语言参数），而这里要证明的是
    // 「英文记录里的差异审计行门禁读得出来」；写侧那条中文行由 base 自己的用例守着。
    const audit =
      '- Candidate commit ' + CANDIDATE + ' → release commit ' + RELEASE + ': release branch merged the candidate after the freeze'
    const run = await runGate({
      ticketFace: happyFace({ ancestry: false, issues: [checklistIssue({ body: checklistBody({ audit }) })] }),
    })
    check(run.exitCode === 0, 'F1 票面覆盖差异审计 → 退出码 0', show(run.exitCode) + ' / ' + run.err.split(NEWLINE)[0])
    check(run.report?.audit?.covered === true, 'F2 报告记下审计已覆盖', show(run.report?.audit))
    check(
      run.out.includes('PREFLIGHT-CANDIDATE-AUDIT commit=' + CANDIDATE),
      'F3 stdout 有候选差异审计标记（发布脚本据此对账字节）',
      run.out.split(NEWLINE).filter((line) => line.startsWith('PREFLIGHT-CANDIDATE')).join(' / '),
    )
    check(run.out.includes('fileDigest=' + FILE_DIGEST), 'F4 审计标记带候选包 sha256', '')
  }

  // ---- G. 没配票面适配器 → blocked（exit 2），给三步注入方法，绝不绿 ----
  {
    const run = await runGate({ ticketFace: false })
    check(run.exitCode === 2, 'G1 无适配器 → 退出码 2（blocked 不是 fail）', show(run.exitCode))
    check(run.report?.decision === 'blocked', 'G2 报告 decision=blocked', show(run.report?.decision))
    check(run.report?.blocked?.[0]?.code === 'adapter-missing', 'G3 阻塞原因 adapter-missing', show(run.report?.blocked?.[0]?.code))
    check(run.err.includes('PREFLIGHT-BLOCKED'), 'G4 stderr 有 PREFLIGHT-BLOCKED 标记', '')
    check(run.err.includes('add to verify/profile.ts'), 'G5 阻塞行带三步注入方法', '')
    check(run.err.includes('(fix: '), 'G6 阻塞行带可执行的「改法」', '')
    check(!run.out.includes('PREFLIGHT-OK') && !run.err.includes('PREFLIGHT-FAIL'), 'G7 阻塞既不算通过也不算失败', '')
  }

  // ---- H. development 候选拒发 → candidate-not-release ----
  {
    const run = await runGate({ candidate: releaseCandidate({ validity: 'development' }) })
    check(run.exitCode === 1, 'H1 development 候选 → 退出码 1', show(run.exitCode))
    check(hasFinding(run.report, 'candidate-not-release'), 'H2 报告带 candidate-not-release', show(run.report?.findings?.map((f: any) => f.code)))
    check(run.err.includes('PREFLIGHT-FAIL candidate-not-release: '), 'H3 CLI 点名该 finding code', '')
  }

  // ---- I. 候选就是发布提交 → PREFLIGHT-CANDIDATE-OK ----
  {
    const run = await runGate({
      candidate: releaseCandidate({ commit: RELEASE }),
      ticketFace: happyFace({ comments: [batchComment({ commit: RELEASE })] }),
    })
    check(run.exitCode === 0, 'I1 候选提交等于发布提交 → 退出码 0', show(run.exitCode))
    check(run.out.includes('PREFLIGHT-CANDIDATE-OK commit=' + RELEASE), 'I2 stdout 有 PREFLIGHT-CANDIDATE-OK', '')
    check(run.out.includes('fileDigest=' + FILE_DIGEST), 'I3 标记带候选包 sha256', '')
    check(run.report?.audit?.required === false, 'I4 无需差异审计（要求是空的，不是没证）', show(run.report?.audit))
  }

  // ---- M. 换格式这件事本身要被钉住：旧的中文总览表不再被读，报错点名缺的是英文那一节 ----
  {
    const chineseBody = [
      '# 真机验证清单 ' + VERSION,
      '',
      '## 场景总览',
      '| 场景编号 | 来源票 | 一句话 | 状态 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      '| 1600-01 | #16 | release gate | 通过 | |',
    ].join(NEWLINE)
    const run = await runGate({ ticketFace: happyFace({ issues: [checklistIssue({ body: chineseBody })] }) })
    check(
      run.exitCode === 1,
      'M1 中文总览表按英文格式读不出来 → 退出码 1（换的是格式，不只是几个常量）',
      show(run.exitCode),
    )
    check(
      run.err.includes('"## Scenario overview"'),
      'M2 报错点名缺的是 "## Scenario overview" 这一节，读票的人知道该按新模板补哪一节',
      run.err.slice(0, 200),
    )
  }

  // ---- N. 换格式不等于让已经写好的记录作废：中文身份行仍然认（base 的解析器两种语言都读） ----
  {
    const legacy = '- 验证身份：批次 batch-1；候选提交 ' + CANDIDATE + '；候选包 sha256 ' + TGZ
    const run = await runGate({ ticketFace: happyFace({ comments: [batchComment({ identityLine: legacy })] }) })
    check(
      run.exitCode === 0,
      'N1 中文身份行放在英文记录里 → 仍然通过',
      show(run.exitCode) + ' / ' + (run.err.split(NEWLINE)[0] ?? ''),
    )
  }

  // ---- P. 结论行里带着完整日历日期时，不能凭空多读出一个场景编号 ----
  // 2026-11-18 收口时踩的就是这个：`- Scenario 41-01: passed —— 2026-11-17 那个失败……` 里，日期尾巴
  // `11-17` 也是「字母数字-两位数字」，被当成第二个编号，同一行的结论于是记到了一个故意 void 的行上，
  // 通过数比实际多一条、收口行对不上，发布被卡住、改了两条评论才回到绿。这里用最小夹具直接问
  // judgeChecklistConsistency：门禁读结论、算通过/失败/豁免的就是这一个函数，不必再搭一份票面。
  {
    const idFlags = CHECKLIST_FORMAT.scenarioIdPattern.flags.replace(/[gy]/gu, '') + 'g'
    const idsOf = (text: string): string[] =>
      [...text.matchAll(new RegExp(CHECKLIST_FORMAT.scenarioIdPattern.source, idFlags))].map((match) => match[0])
    // 这一行是 2026-11-18 那张票上真实写过的形状：编号、结果词、日期写在同一行里。
    const dateInConclusion = '- Scenario 41-01: passed — the detail that failed on 2026-11-17 now draws'
    const dateOnly = 'the checker read 2026-11-18 as a date'
    check(show(idsOf(dateInConclusion)) === show(['41-01']), 'P1 结论行里的 2026-11-17 不是编号，这一行只产出 41-01', show(idsOf(dateInConclusion)))
    check(
      idsOf(dateOnly).length === 0 && show(idsOf('Scenario 11-17: void')) === show(['11-17']),
      'P2 只有日期的句子一个编号都没有，而独立的 11-17 仍然是编号（它本身是真编号，不是日期的一部分）',
      show([idsOf(dateOnly), idsOf('Scenario 11-17: void')]),
    )
    const body = [
      '# Real-machine verification checklist ' + VERSION,
      '',
      '## Scenario overview',
      '| Scenario number | Source ticket | One sentence | Status | Notes |',
      '| --- | --- | --- | --- | --- |',
      '| 41-01 | #41 | release gate wiring | passed | |',
      '| 11-17 | #11 | closing counts | void | |',
    ].join(NEWLINE)
    const claim = '[Ready to release] passed 1 / failed 0 / exempt 0'
    const comment = { body: [identityLine(), dateInConclusion, 'Scenario 11-17: void', dateOnly, claim].join(NEWLINE) }
    const consistency = judgeChecklistConsistency({ body, comments: [comment], format: CHECKLIST_FORMAT })
    check(
      consistency.ok === true && consistency.findings.length === 0,
      'P3 带日期的结论行不产生幻影结论：一致性报告零 finding',
      show(consistency.findings.map((item: any) => item.message)),
    )
    const counts = consistency.publishCounts
    check(counts.passed === 1 && counts.failed === 0 && counts.exempted === 0, 'P4 通过/失败/豁免计数停在真实数字上（幻影结论把通过数抬到 2）', show(counts))
  }

  // ---- J. 环境类输入错误：都归 exit 2，不冒充票面失败 ----
  {
    const gitRun = await runGate({ releaseCommit: undefined, ports: portsWithCommand(fakeCommand(128, 'fatal: not a git repository')) })
    check(gitRun.exitCode === 2, 'J1 git 取不到 HEAD → 退出码 2', show(gitRun.exitCode))
    check(gitRun.err.includes('PREFLIGHT-ENV') && gitRun.err.includes('git rev-parse HEAD failed'), 'J2 stderr 说清是 git 环境问题', gitRun.err.split(NEWLINE)[0] ?? '')

    const versionRun = await runGate({ version: undefined, readVersion: () => '   ' })
    check(versionRun.exitCode === 2, 'J3 版本号为空 → 退出码 2', show(versionRun.exitCode))
    check(versionRun.err.includes('PREFLIGHT-ENV') && versionRun.err.includes('The version number is empty'), 'J4 stderr 说清缺版本号', versionRun.err.split(NEWLINE)[0] ?? '')

    const missingCandidate = await runGate({ candidate: undefined, candidatePath: 'D:/Temp/__no_such_candidate__.json' })
    check(missingCandidate.exitCode === 2, 'J5 候选清单文件不存在 → 退出码 2', show(missingCandidate.exitCode))
    check(missingCandidate.err.includes('PREFLIGHT-ENV') && missingCandidate.err.includes('Candidate manifest file does not exist'), 'J6 stderr 点名缺失的候选清单', missingCandidate.err.split(NEWLINE)[0] ?? '')

    const noDeclaration = await runGate({
      ticketFace: undefined,
      profile: undefined,
      repoRoot: 'D:/Temp/__no_such_release_repo__',
    })
    check(noDeclaration.exitCode === 2, 'J7 找不到 verify/profile.ts 声明 → 退出码 2', show(noDeclaration.exitCode))
    check(noDeclaration.err.includes('PREFLIGHT-BLOCKED'), 'J8 声明缺失归 blocked 且给改法', noDeclaration.err.split(NEWLINE)[0] ?? '')
  }

  // ---- K / L. 接线静态断言与薄 CLI 子进程：搬到 tests/lib/release-gate-wiring.ts（体积上限），断言编号与计数不变 ----
  runWiringChecks({ check, show, root: ROOT, ticketFace })

  const record = printGateResult(GATE, assertions, failed)
  console.log('GATE-SUMMARY ' + JSON.stringify(record))
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  printGateResult(GATE, assertions, failed + 1)
  process.exitCode = 1
})