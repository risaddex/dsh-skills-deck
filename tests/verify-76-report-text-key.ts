/**
 * verify-76-report-text-key.ts —— deck_issue_report 的票号归一必须认文本票号（#76）
 *
 * 症状（真机，2026-11-23，Linear 工作区 OMB）：deck_issue_report 一次也报不上账。normKey 只认 1 到 10
 * 位数字，`OMB-923` 被归一成空串，工具在打开房间之前就以 BAD_ARGS 拒掉；而裸数字 `923` 过了归一、
 * 到 Linear 房间又变成「Entity not found」，因为房间按 identifier 或 UUID 解析，不认队内序号。
 *
 * 本门禁只钉归一这一段，不碰房间解析：数字票号照旧，`TEAM-123` 原样放行（与 deck_issue_patch /
 * deck_issue_get 同口径），其余形状仍然拒掉。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-76-report-text-key.ts
 */
import { normKey } from '../src/deck/tools/issue-report.ts'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-76-report-text-key'

let assertions = 0
let failed = 0

function check(ok: boolean, message: string): void {
  assertions += 1
  if (ok) {
    console.log('  PASS ' + message)
    return
  }
  failed += 1
  console.log('  FAIL ' + message)
}

/** [输入, 期望, 说明] —— 前四行是 #76 的正例，其余是必须保持原样或必须继续被拒的形状。 */
const CASES: Array<[unknown, string, string]> = [
  ['OMB-923', 'OMB-923', 'Linear 的文本票号原样放行（#76 正例）'],
  ['ENG-1', 'ENG-1', '短的队名也放行'],
  ['#OMB-923', 'OMB-923', '文本票号前面的 # 照旧去掉'],
  ['  OMB-923  ', 'OMB-923', '两侧空白去掉'],
  ['42', '42', '数字票号照旧'],
  ['#42', '42', '数字票号去 #'],
  ['0042', '42', '数字票号去前导零'],
  ['', '', '空串仍当空'],
  [undefined, '', '没给仍当空'],
  [null, '', 'null 仍当空'],
  ['abc', '', '不是票号形状的仍拒'],
  ['OMB-', '', '队名后缺数字仍拒'],
  ['OMB-923-x', '', '尾部多出来的仍拒'],
  ['-923', '', '缺队名仍拒'],
  ['1234567890123', '', '超过 10 位的纯数字仍拒'],
  ['OMB 923', '', '空格分隔不是票号形状'],
]

for (const [input, expected, note] of CASES) {
  const got = normKey(input)
  check(got === expected, note + '：' + JSON.stringify(input === undefined ? 'undefined' : input) + ' → ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(expected) + '）')
}

console.log('\n' + assertions + ' 条断言，' + (failed ? '失败' : '通过'))
printGateResult(GATE, assertions, failed)
process.exit(failed ? 1 : 0)
