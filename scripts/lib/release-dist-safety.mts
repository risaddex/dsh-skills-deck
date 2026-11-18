import fs from 'node:fs'

export type GitRunner = (command: string, args: string[]) => string

/** 只把干净检出的固定提交作为来源；构建期间切换 HEAD 或改写已跟踪文件都必须停止。 */
export function requireCleanSource(run: GitRunner, expected?: string): string {
  const head = run('git', ['rev-parse', 'HEAD'])
  if (expected && head !== expected) throw new Error('Source HEAD changed during release preparation')
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Tracked source tree must be clean before and after building')
  return head
}

/** 已接受失败的登记仅供说明，不能替下一次发布授权；推送只接受该来源提交的完整全绿报告。 */
export function requireVerifiedSource(file: string, source: string): void {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (report.head !== source || report.tier !== 'full' || report.stepsRan !== report.stepsTotal || !(report.stepsTotal > 0)
    || report.red !== 0 || report.smoke?.ran !== true || report.smoke.red !== 0
    || !(report.smoke.stepsTotal > 0) || report.smoke.stepsRan !== report.smoke.stepsTotal) {
    throw new Error('Push requires a complete green verify:parallel report for the exact source HEAD; known reds are not future release approval')
  }
}

/** 重试通知前同时比较远端标签对象和解引用提交，拒绝轻量标签或被移走的标签。 */
export function notifyPublishedTag(run: GitRunner, tag: string): void {
  if (!/^dist\/v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Expected dist/v<version> tag')
  const ref = 'refs/tags/' + tag
  if (run('git', ['cat-file', '-t', ref]) !== 'tag') throw new Error('Release tag must be annotated')
  const object = run('git', ['rev-parse', ref])
  const commit = run('git', ['rev-parse', ref + '^{}'])
  const remote = new Map(run('git', ['ls-remote', 'origin', ref, ref + '^{}']).split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, name] = line.split(/\s+/)
    return [name, sha]
  }))
  if (remote.get(ref) !== object || remote.get(ref + '^{}') !== commit) throw new Error('Remote release tag SHA does not match the local annotated tag and commit; notification refused')
  run('gh', ['api', 'repos/risaddex/dsh-plugins/dispatches', '-f', 'event_type=skills-deck-dist-tag', '-f', 'client_payload[tag]=' + tag])
}

/** 分支和标签必须一起成功；原子推送失败时绝不能发送成功通知。 */
export function pushAndNotify(run: GitRunner, tag: string): void {
  run('git', ['push', '--atomic', 'origin', 'refs/heads/dist:refs/heads/dist', 'refs/tags/' + tag + ':refs/tags/' + tag])
  notifyPublishedTag(run, tag)
}

/** 发布前检查交给发布脚本的那一部分结论：退出码与要打印的行。只取这两样，安全库因此不必 import 门禁组合根。 */
export interface ReleaseGateOutcome {
  readonly exitCode: number
  readonly lines: readonly ReleaseGateLine[]
}

/** 门禁的一行输出属于哪个流；发布前检查已经按这个字段分好，这里只照原样转发。 */
export interface ReleaseGateLine {
  readonly stream: 'out' | 'err'
  readonly text: string
}

/**
 * 门禁没放行时抛出的错误。
 *
 * 为什么带上 kind 与 exitCode：另外两条发布路径（publish-token.ps1 与 wizard-release.sh）都按退出码
 * 四态分流（1=票面或候选要人改，2=环境或适配器缺失、无法判定，未知码按环境失败），发布脚本要能照原码
 * 结束、也要让人一眼看出该去改票还是该去修 gh 登录。把两者压成一个「失败」会让「gh 没登录」冒充
 * 「清单票没关闭」。
 */
export class ReleaseGateRefusedError extends Error {
  /** ticket-face＝票面或候选要人改（门禁 exit 1）；undecidable＝环境或适配器缺失、无法判定（exit 2 及未知码）。 */
  readonly kind: 'ticket-face' | 'undecidable'
  /** 门禁自己的退出码，原样保留下来给外层脚本分流。 */
  readonly exitCode: number

  constructor(kind: 'ticket-face' | 'undecidable', exitCode: number, message: string) {
    super(message)
    this.name = 'ReleaseGateRefusedError'
    this.kind = kind
    this.exitCode = exitCode
  }
}

/** 判定所需的两个输入，没有第三个：这次是不是真要推送，以及把门禁的话往哪里写。 */
export interface ReleaseGateOptions {
  /** true 表示这次要建引用、打标签、发 dispatch；false 表示演练，门禁的结论只提示。 */
  readonly push: boolean
  /** 输出接缝：缺省按 stream 分到 stdout/stderr；测试传入收集器，于是不必读控制台。 */
  readonly emit?: (line: ReleaseGateLine) => void
}

/**
 * 按发布前检查的结论决定这次发布往下走、只提示，还是停手。
 *
 * 判定只有一条规则，四个状态各自落在哪里是有讲究的：
 *   - 退出码 0（通过）：继续。门禁的 OK / 候选标记行照打，日志里才有「这一版的门禁结论是什么」。
 *   - 退出码 1（票面或候选要人改）：推送中止，抛 ticket-face 错误。
 *   - 退出码 2（环境或适配器缺失，无法判定）：推送中止，抛 undecidable 错误。
 *   - 其它退出码：按环境失败处理（与 RELEASE-RUNBOOK 的四态分支同口径），同样中止。
 *   演练（push=false）时非 0 一律只警告：演练的价值是把结论摆出来，不是替人拍板；这与
 *   publish-token.ps1 -DryRun、wizard-release.sh --dry-run 的既有口径一致。
 *
 * 为什么不在这里重写规则、也不另外打一份摘要：门禁自己的每条 finding 都带 code、message 与「改法」，
 * 复制一份摘要只会在两处说法不一致时让人猜哪一份是真的；这里只做「转发 + 判定」。
 */
export function requireReleaseGate(outcome: ReleaseGateOutcome, options: ReleaseGateOptions): 'pass' | 'warn' {
  const emit = options.emit ?? ((line: ReleaseGateLine): void => {
    if (line.stream === 'err') console.error(line.text)
    else console.log(line.text)
  })
  for (const line of outcome.lines) emit(line)

  const code = outcome.exitCode
  if (code === 0) return 'pass'

  const kind = code === 1 ? 'ticket-face' : 'undecidable'
  // 0/1/2 之外是「谁也没约定的码」：runbook 把它算作环境失败，所以归 undecidable，但消息要说清它不是 2。
  const unknown = code !== 1 && code !== 2

  if (!options.push) {
    emit({
      stream: 'err',
      text:
        'RELEASE-GATE-SOFT dry-run: the release gate did not pass (exit ' + String(code) + ')' +
        (unknown ? ', which is not one of the 0/1/2 exit codes and therefore counts as an environment failure' : '') +
        '. A --push would be refused here; this dry run only warns.',
    })
    return 'warn'
  }

  const detail = kind === 'ticket-face'
    ? 'the checklist ticket or the candidate manifest has to change; this is a ticket-face finding, not an environment problem'
    : 'the environment or the ticket-face adapter is missing, so the verdict is undecidable' +
      (unknown ? ' (exit ' + String(code) + ' is not one of 0/1/2, which counts as an environment failure)' : '')
  throw new ReleaseGateRefusedError(
    kind,
    code,
    'Release gate did not pass (exit ' + String(code) + '): ' + detail +
      '. No ref, tag, push or dispatch was created; change what the findings above ask for and run --dry-run again.',
  )
}

/** 发布字节与候选清单对账的结论：规则在 lib/release-candidate-audit.mts 的 judgeReleaseBytes 里，这里只接结论。 */
export interface CandidateBytesVerdict {
  /** same＝字节就是候选那份；diff-audited＝不同但清单票写了差异审计；diff＝不同且没有审计。 */
  readonly verdict: 'same' | 'diff-audited' | 'diff'
  /** 给人看的一句话，由 judgeReleaseBytes 生成，这里不改写。 */
  readonly message: string
}

/**
 * 字节与候选对不上、清单票又没有差异审计时抛出的错误。
 *
 * 为什么不复用 ReleaseGateRefusedError：那一个说的是「门禁没放行（票面或环境）」，这一句说的是
 * 「要发的字节不是验过的那份」，两者要改的东西不同（那里改票，这里重建候选或改审计）。退出码都按
 * 发布脚本的约定回 1：这是要人动手改，不是环境缺失。
 */
export class ReleaseBytesRefusedError extends Error {
  /** 固定 1：与 publish-token.ps1 的 CANDIDATE-DIFF 分支同一档。 */
  readonly exitCode = 1

  constructor(message: string) {
    super(message)
    this.name = 'ReleaseBytesRefusedError'
  }
}

/**
 * 按「发布字节 vs 候选包」的结论决定往下走还是停手。
 *
 * 三个状态各自落在哪里（与 publish-token.ps1 的 CANDIDATE-* 分支同口径）：
 *   - 没给候选清单（verdict 为 null）：打 CANDIDATE-SKIP 继续。规则明说这是「跳过」不是「通过」，
 *     log 里要留下这句话，否则事后没人分得清「对过账」和「没对」。
 *   - same / diff-audited：打对应结论行继续；差异审计只在清单票正文里写了才走到 diff-audited。
 *   - diff：推送中止。演练只提示——演练的用处是把结论摆出来，不是替人拍板。
 *
 * 为什么这条对账必须在建引用之前跑：dist 标签是单向的，一次推出去的字节没法撤回；对账放在
 * update-ref 之后等于事后才发现发错了。
 */
export function requireCandidateBytes(
  verdict: CandidateBytesVerdict | null,
  options: ReleaseGateOptions,
): 'skip' | 'pass' | 'warn' {
  const emit = options.emit ?? ((line: ReleaseGateLine): void => {
    if (line.stream === 'err') console.error(line.text)
    else console.log(line.text)
  })
  if (verdict === null) {
    emit({ stream: 'out', text: 'CANDIDATE-SKIP no candidate manifest was given, so the bytes to publish were not compared with a candidate package' })
    return 'skip'
  }
  if (verdict.verdict === 'diff') {
    if (!options.push) {
      emit({ stream: 'err', text: 'CANDIDATE-DIFF-SOFT dry-run: ' + verdict.message + '. A --push would be refused here; this dry run only warns.' })
      return 'warn'
    }
    emit({ stream: 'err', text: 'CANDIDATE-DIFF ' + verdict.message })
    throw new ReleaseBytesRefusedError(
      verdict.message + '. No ref, tag, push or dispatch was created; rebuild the candidate from this commit, or write the diff audit in the checklist ticket and run --dry-run again.',
    )
  }
  emit({ stream: 'out', text: (verdict.verdict === 'same' ? 'CANDIDATE-SAME ' : 'CANDIDATE-DIFF-AUDITED ') + verdict.message })
  return 'pass'
}
