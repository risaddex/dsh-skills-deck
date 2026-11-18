// tests/verify-release-dist-gate.ts —— 发布脚本自己的「发布前检查」接线门禁。
//
// 守的是这条线：scripts/release-dist.mts 在建引用、打标签、发 dispatch 之前必须过发布前检查，
// 而「门禁的结论怎么影响这次发布」被放在 scripts/lib/release-dist-safety.mts 的 requireReleaseGate 里，
// 是一个不跑构建、不碰网络的纯判定，所以四态可以在门禁里一条条钉住，不必真跑一次发布。
//
// 为什么非钉不可：2026-11-18 的 dist/v2.0.0 是在清单票 #41 还开着的时候推出去的，这条路当时一次都
// 没调用发布前检查（runbook 写着「两条发布路径都会自动跑」，可这条分支自己不走）。文档上写「必须收口」
// 拦不住任何一次推送，只有把「退出码 0 才允许往下走」写成代码并守住它才行。
//
// 断言分两层：
//   纯判定层——0/1/2/未知码在推送与演练两种模式下的结论各验一遍，并确认门禁自己的 finding 行（含「改法」）
//   被原样转发，而不是被改写成一句摘要；组合根的真实结论也交给判定一次，证明两边的形状接得上。
//   接线层——读真实源码，证明脚本确实调用了门禁与这个判定，且调用点在构建与改引用之前，
//   --notify-only 补发路径与 --candidate 参数都没被挤掉。
//
// 门禁归属: scripts/release-dist.mts
// 门禁归属: scripts/lib/release-dist-safety.mts
import fs from 'node:fs'
import { requireReleaseGate, ReleaseGateRefusedError } from '../scripts/lib/release-dist-safety.mts'
import { runPreflightGate } from '../scripts/lib/release-preflight-gate.mts'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-release-dist-gate'

/** 门禁组合根给出的一行输出；判定只负责把它转发给人。 */
type Line = { readonly stream: 'out' | 'err'; readonly text: string }

const OK_LINE: Line = {
  stream: 'out',
  text: 'PREFLIGHT-OK Release gate passed: v2.0.0 at ' + 'a'.repeat(40) + '; checklist ticket #41; 6/6 checks passed.',
}
const FAIL_LINE: Line = {
  stream: 'err',
  text: 'PREFLIGHT-FAIL checklist-not-closed: checklist ticket #41 is still open (fix: close the checklist ticket after the real-machine verification passes).',
}
const BLOCKED_LINE: Line = {
  stream: 'err',
  text: 'PREFLIGHT-BLOCKED no ticket-face adapter is declared in verify/profile.ts (fix: declare the gh adapter there).',
}

let assertions = 0
let failed = 0

function check(ok: boolean, message: string, detail = ''): void {
  assertions += 1
  if (ok) {
    console.log('PASS ' + message)
    return
  }
  failed += 1
  console.log('FAIL ' + message + (detail === '' ? '' : '；' + detail))
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 跑一次判定，把「返回了什么」与「抛了什么」都收下来；断言里不必各写一遍 try/catch。 */
function attempt(exitCode: number, lines: Line[], push: boolean): { decision: string | null; error: unknown; seen: Line[] } {
  const seen: Line[] = []
  try {
    const decision = requireReleaseGate({ exitCode, lines }, { push, emit: (line: Line) => seen.push(line) })
    return { decision, error: null, seen }
  } catch (error) {
    return { decision: null, error, seen }
  }
}

/** 把抛出来的东西收成拒绝错误；不是我们的错误就回 null —— 真 bug 不该被当成「门禁拒绝」蒙混过去。 */
function asRefusal(error: unknown): ReleaseGateRefusedError | null {
  return error instanceof ReleaseGateRefusedError ? error : null
}

/** 锚点缺失时给一句「找不到哪些」：顺序断言因此判红，而不是拿着 -1 悄悄放过。 */
function lineOrderIssue(source: string, anchors: string[]): string {
  const missing = anchors.filter((anchor) => source.indexOf(anchor) < 0)
  return missing.length === 0 ? '' : '源码里找不到这些锚点：' + show(missing)
}

async function main(): Promise<void> {
  // ---- A. 门禁通过 → 推送继续，并且结论行照打（日志里才有这一版的门禁结论） ----
  {
    const run = attempt(0, [OK_LINE], true)
    check(run.error === null && run.decision === 'pass', 'A1 门禁 exit 0 → 推送继续（判定返回 pass）', show(run.decision) + ' / ' + show(run.error))
    check(run.seen.some((line) => line.text === OK_LINE.text), 'A2 通过时门禁的 PREFLIGHT-OK 行原样打出来', show(run.seen))
  }

  // ---- B. 门禁 exit 1（票面或候选要人改）→ 推送停手，并且点名这是票面问题 ----
  {
    const run = attempt(1, [FAIL_LINE], true)
    const refused = asRefusal(run.error)
    check(refused !== null, 'B1 门禁 exit 1 → 推送中止并抛 ReleaseGateRefusedError', String(run.error))
    check(refused?.kind === 'ticket-face', 'B2 中止原因归到票面（ticket-face）', show(refused?.kind))
    check(refused?.exitCode === 1, 'B3 错误保留门禁的退出码 1', show(refused?.exitCode))
    check(/checklist ticket|candidate manifest/.test(refused?.message ?? ''), 'B4 中止消息点名要改的是清单票或候选清单', refused?.message ?? '')
    check(
      /not an environment problem/.test(refused?.message ?? '') && !/undecidable/.test(refused?.message ?? ''),
      'B5 消息明说这不是环境问题，也不冒充「无法判定」',
      refused?.message ?? '',
    )
    check(run.seen.some((line) => line.text === FAIL_LINE.text), 'B6 那条带「改法」的 finding 行被原样转发给人', show(run.seen))
  }

  // ---- C. 门禁 exit 2（环境或适配器缺失）→ 推送停手，并且点名这是无法判定 ----
  {
    const run = attempt(2, [BLOCKED_LINE], true)
    const refused = asRefusal(run.error)
    check(refused !== null, 'C1 门禁 exit 2 → 推送中止并抛 ReleaseGateRefusedError', String(run.error))
    check(refused?.kind === 'undecidable', 'C2 中止原因归到无法判定（undecidable）', show(refused?.kind))
    check(refused?.exitCode === 2, 'C3 错误保留门禁的退出码 2', show(refused?.exitCode))
    check(/undecidable/.test(refused?.message ?? ''), 'C4 中止消息明说无法判定', refused?.message ?? '')
    check(run.seen.some((line) => line.text === BLOCKED_LINE.text), 'C5 那条带「改法」的阻塞行被原样转发给人', show(run.seen))
  }

  // ---- D. 演练：两种失败都只警告，发布路径继续（与 -DryRun / --dry-run 的既有口径一致） ----
  {
    const one = attempt(1, [FAIL_LINE], false)
    check(one.error === null && one.decision === 'warn', 'D1 演练时 exit 1 只警告（判定返回 warn，不抛）', show(one.decision) + ' / ' + show(one.error))
    const oneSoft = one.seen.filter((line) => line.text.startsWith('RELEASE-GATE-SOFT'))
    check(oneSoft.length === 1 && oneSoft[0].text.includes('exit 1'), 'D2 警告行带上门禁的退出码 1', show(oneSoft))
    const two = attempt(2, [BLOCKED_LINE], false)
    check(two.error === null && two.decision === 'warn', 'D3 演练时 exit 2 也只警告', show(two.decision) + ' / ' + show(two.error))
    const twoSoft = two.seen.filter((line) => line.text.startsWith('RELEASE-GATE-SOFT'))
    check(twoSoft.length === 1 && twoSoft[0].text.includes('exit 2'), 'D4 警告行带上门禁的退出码 2', show(twoSoft))
  }

  // ---- E. 未知退出码：runbook 把它算作环境失败，所以按「无法判定」停手，但码要原样留下 ----
  {
    const run = attempt(7, [BLOCKED_LINE], true)
    const refused = asRefusal(run.error)
    check(refused !== null, 'E1 未知退出码 7 → 推送中止', String(run.error))
    check(refused?.kind === 'undecidable', 'E2 未知退出码归到无法判定（不冒充票面问题）', show(refused?.kind))
    check(refused?.exitCode === 7, 'E3 未知退出码原样保留，外层仍看得出它不是约定的码', show(refused?.exitCode))
    check(
      /environment failure/.test(refused?.message ?? ''),
      'E4 消息说清未知退出码按环境失败处理',
      refused?.message ?? '',
    )
    const dry = attempt(7, [], false)
    check(dry.error === null && dry.decision === 'warn', 'E5 演练时未知退出码同样只警告', show(dry.decision))
  }

  // ---- F. 组合根的真实结论要能直接交给这个判定（两边的形状不许各自跑偏） ----
  {
    // 版本给了、发布提交故意写坏：组合根在取票面之前就以 PREFLIGHT-ENV 退出 2，不读网络、不跑 git、不碰 gh。
    const real = await runPreflightGate({ version: '2.0.0', releaseCommit: 'not-a-commit' })
    check(real.exitCode === 2, 'F1 组合根遇到不合法的环境输入给退出码 2', show(real.exitCode))
    const run = attempt(real.exitCode, [...real.lines], true)
    const refused = asRefusal(run.error)
    check(
      refused?.kind === 'undecidable' && refused?.exitCode === 2,
      'F2 组合根的真实结论交给判定后按「无法判定」停手',
      show(refused?.kind) + ' / ' + show(refused?.exitCode),
    )
    check(
      real.lines.some((line) => line.text.startsWith('PREFLIGHT-ENV')),
      'F3 真实结论里带 PREFLIGHT-ENV 行（判定把组合根的话原样转发）',
      show(real.lines.map((line) => line.text.slice(0, 40))),
    )
  }

  // ---- G. 接线：源码必须真的这么写，纯判定的行为才轮得到在发布时生效 ----
  {
    const script = fs.readFileSync('scripts/release-dist.mts', 'utf8')
    const safety = fs.readFileSync('scripts/lib/release-dist-safety.mts', 'utf8')
    const anchors = [
      'runPreflightGate(',
      'requireReleaseGate(gate, { push })',
      "['scripts/build.mts', '--force']",
      "'update-ref'",
      'pushAndNotify(run, tag)',
      "args[0] === '--notify-only'",
      "'--candidate'",
      "'--dry-run'",
    ]
    const missing = lineOrderIssue(script, anchors)
    check(missing === '', 'G1 发布脚本里门禁、判定、构建、改引用、推送、补发与两个参数都在', missing)
    check(
      script.includes('candidatePath: options.candidatePath'),
      'G2 --candidate 原样交给门禁（候选清单路径不在这里另存一份）',
      '',
    )
    const gateAt = script.indexOf('requireReleaseGate(gate, { push })')
    check(gateAt >= 0 && gateAt < script.indexOf("['scripts/build.mts', '--force']"), 'G3 判定在构建之前（票面没关时不必先花一分钟构建）', show(gateAt))
    check(gateAt >= 0 && gateAt < script.indexOf("'update-ref'"), 'G4 判定在建引用之前（跑不通就不建 refs 分支）', show(gateAt))
    check(gateAt >= 0 && gateAt < script.indexOf('pushAndNotify(run, tag)'), 'G5 判定在推送与 dispatch 之前', show(gateAt))
    const notifyAt = script.indexOf("args[0] === '--notify-only'")
    check(
      notifyAt >= 0 && gateAt >= 0 && notifyAt < gateAt,
      'G6 --notify-only 补发路径在门禁之前就结束（它不改引用，只重发 dispatch）',
      show(notifyAt) + ' / ' + show(gateAt),
    )
    check(
      !/release-checklist-unique|release-checklist-closed|release-checklist-consistency|release-batch-identity|release-ancestor-audit|release-candidate-valid/.test(script + safety),
      'G7 脚本与安全库都不复制门禁的六条规则（规则只在 runPreflightGate 里，改规则只改一处）',
      '',
    )
  }
}

main()
  .then(() => {
    console.log('共有 ' + assertions + ' 条断言，' + (failed === 0 ? '全部通过' : '存在 ' + failed + ' 条失败'))
    printGateResult(GATE, assertions, failed)
    if (failed !== 0) process.exit(1)
  })
  .catch((error: unknown) => {
    console.error('门禁运行出错：' + ((error as { stack?: string }).stack ?? String(error)))
    printGateResult(GATE, assertions, failed + 1)
    process.exit(1)
  })
