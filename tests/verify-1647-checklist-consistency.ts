// tests/verify-1647-checklist-consistency.ts —— #1647 清单票预检一致性判据门禁。
//
// 为什么要有这一条：预检脚本从「恰好一张且已关闭」扩到「记录内部一致」以后，判据本身
// 也是代码，也会看错行、数错数。这里用离线夹具把两条红线钉住：自洽的记录必须判绿
// （含「收口评论只写模板要求的一行计数」这种最简写法）；正文缺行、正文计数不一致、
// 编号集合不同、正文有行但评论里没有场景块这几种真出现过的问题必须逐条判红，
// 并说清是哪一处、两边分别是什么。
//
// 夹具是 JSON：{ name, body, comments: [{ body, createdAt }], expect }。不读网络、不跑 gh。
// 夹具按目录里实际存在的 *.json 跑；下面 REQUIRED_FIXTURES 只钉住「至少要有哪几份」，
// 以后新增夹具不用改名单，删掉必备夹具会在这里红。
// 门禁归属: scripts/lib/checklist-consistency.mts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkChecklistConsistency,
  formatConsistencyFindings,
} from '../scripts/lib/checklist-consistency.mts'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/1647/', import.meta.url))
// 夹具按目录里实际存在的 *.json 跑：以后多放一份夹具不用再改这份名单，避免「加了夹具却没被跑」。
const FIXTURE_NAMES = fs
  .readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()
// 必备夹具：票面要求的三条红路径、全绿路径，以及 #1647 实现里补的三份（模板收口写法、缺场景块、作废行）。
const REQUIRED_FIXTURES = [
  'green',
  'green-template-closing',
  'green-with-void',
  'red-body-missing-row',
  'red-count-mismatch',
  'red-id-set-diff',
  'red-missing-block',
]
for (const required of REQUIRED_FIXTURES) {
  if (!FIXTURE_NAMES.includes(required)) throw new Error('缺少必备夹具：' + required + '.json（目录：' + FIXTURE_DIR + '）')
}

type FixtureExpect = {
  ok: boolean
  codes?: string[]
  messageIncludes?: string[]
}
type Fixture = {
  name: string
  body: string
  comments: { body: string; createdAt: string }[]
  expect: FixtureExpect
}

let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => {
  total += 1
  if (!ok) failed = true
  console.log((ok ? '  PASS ' : '  FAIL ') + msg)
}

console.log('清单票预检一致性判据门禁（#1647）')

for (const fixtureName of FIXTURE_NAMES) {
  const filePath = path.join(FIXTURE_DIR, fixtureName + '.json')
  const fixture = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Fixture
  const report = checkChecklistConsistency({ body: fixture.body, comments: fixture.comments })
  const where = fixture.name || fixtureName

  check(report.ok === fixture.expect.ok, where + '：整体判据结果与夹具期望一致（期望 ' + (fixture.expect.ok ? '绿' : '红') + '，实际 ' + (report.ok ? '绿' : '红') + '）')

  const actualCodes = report.findings.map((finding) => finding.code)
  for (const code of fixture.expect.codes || []) {
    check(actualCodes.includes(code), where + '：报出了「' + code + '」（实际：' + (actualCodes.join('、') || '无') + '）')
  }

  if (fixture.expect.messageIncludes) {
    const hit = (fixture.expect.messageIncludes || []).every((piece) =>
      report.findings.some((finding) => finding.message.includes(piece)),
    )
    check(hit, where + '：说明里写出了两边的事实（' + fixture.expect.messageIncludes.join(' 与 ') + '）')
  }

  const lines = formatConsistencyFindings(report)
  check(lines.length === report.findings.length, where + '：每条判据都有一行给人读的说明（' + lines.length + ' 行 / ' + report.findings.length + ' 条）')
  check(
    lines.every((line) => line.includes(' Fix: ')),
    where + '：每条说明都带「Fix:」，读票的人知道下一步改哪里',
  )
}

// 票的「做完」还要求：正文缺总览表、评论缺场景块时给出明确修复指引，而不是泛泛报错。
// 这两种情况没有单独的夹具文件（就是一份空记录），在门禁里直接构造最小输入。
const noOverview = checkChecklistConsistency({ body: '## 规则', comments: [] })
check(
  noOverview.findings.some((finding) => finding.code === 'missing-overview' && finding.fix.includes('场景总览')),
  '正文缺「## 场景总览」时，说明里指出按模板补回哪一节（missing-overview）',
)
const miniBody = [
  '## 场景总览',
  '',
  '| 场景编号 | 来源票 | 一句话 | 状态 | 备注 |',
  '| --- | --- | --- | --- | --- |',
  '| 2101-01 | #2101 | 打开面板 | 通过 |  |',
].join('\n')
const noBlock = checkChecklistConsistency({ body: miniBody, comments: [] })
check(
  noBlock.findings.some((finding) => finding.code === 'missing-scenario-block' && finding.fix.includes('场景块')),
  '评论里没有场景块时，说明里指出要按「## 场景块」写（missing-scenario-block）',
)

// #17：发布计数写成英文时，写错的数字也必须被拦下，强度与中文一样。
// 起因：读斜杠计数时曾把状态词原样（英文 passed）交给「按内部状态取期望值」的那一步，
// 两边永远对不上，英文写错的计数被当成「没有可比的总数」放过，而同样的错误写成中文会被拦下。
// 这一组用同一份记录，只换计数行的语言与对错：对的两种语言都绿，错的两种语言（含句首大写）都红。
{
  const englishBlocks = [{ body: '## Scenario block: 2201 s\n\nScenario 2201-02: passed', createdAt: '2026-01-01T00:00:01Z' }]
  const englishBody = (reconcile: string): string =>
    [
      '## Scenario overview',
      '',
      '| Scenario number | Source ticket | One sentence | Status | Notes |',
      '| --- | --- | --- | --- | --- |',
      '| 2201-02 | #2201 | b | passed | batch 1 |',
      '',
      '## Pre-release reconciliation',
      '',
      reconcile,
    ].join('\n')
  const codesFor = (reconcile: string): string[] =>
    checkChecklistConsistency({ body: englishBody(reconcile), comments: englishBlocks }).findings.map((finding) => finding.code)
  check(!codesFor('- passed 1 / failed 0 / exempt 0').includes('release-count-mismatch'), '英文发布计数写对：不报 release-count-mismatch')
  check(codesFor('- passed 9 / failed 0 / exempt 0').includes('release-count-mismatch'), '英文发布计数写错：报 release-count-mismatch')
  check(codesFor('- Passed 9 / Failed 0 / Exempt 0').includes('release-count-mismatch'), '英文发布计数句首大写写错：同样报 release-count-mismatch')
  check(codesFor('- 通过 9 / 失败 0 / 豁免 0').includes('release-count-mismatch'), '中文发布计数写错：仍然报 release-count-mismatch（语言换了，强度不变）')
  const wrongWord = checkChecklistConsistency({ body: englishBody('- passed 9 / failed 0 / exempt 0'), comments: englishBlocks }).findings
  check(
    wrongWord.some((finding) => finding.message.includes('"passed 9"')),
    '报错里引用的是作者实际写的词（passed 9），不是内部的中文状态值',
  )
}

// #97（2026-11-24）：两位票号的场景编号必须认得出来。
// 起因：格式原先卡 3~5 位，而本仓票号还在一百上下，模板要求写成「<来源票号>-01」，
// 于是 `97-01` 这种写法在总览表里被判「读不懂」、在场景块标题里被判「没登记」，
// 这些票永远过不了预检 —— 2.1.2 的清单票（#96）里 94-01、81-01 就是这么被判红的。
// 这条断言同时钉住两边：编号本身要认得出，`## Scenario block: 97 …` 里的票号也要登记得上。
{
  const twoDigitBody = [
    '## Scenario overview',
    '',
    '1 scenario, 1 source ticket, 1 passed.',
    '',
    '| Scenario number | Source ticket | One sentence | Status | Notes |',
    '| --- | --- | --- | --- | --- |',
    '| 97-01 | #97 | The suggestion card draws as one card | passed | |',
    '',
    '## Pre-release reconciliation',
    '',
    '- passed 1 / failed 0 / exempt 1',
  ].join('\n')
  const twoDigitBlocks = [{ body: '## Scenario block: 97 The suggestion card draws as one card\n\nScenario 97-01: passed', createdAt: '2026-11-24T23:00:00Z' }]
  const twoDigitCodes = checkChecklistConsistency({ body: twoDigitBody, comments: twoDigitBlocks }).findings.map((finding) => finding.code)
  check(!twoDigitCodes.includes('malformed-row'), '两位票号的场景编号（97-01）在总览表里读得出来，不报 malformed-row')
  check(!twoDigitCodes.includes('missing-scenario-block'), '场景块标题里写两位票号（## Scenario block: 97 …）也算登记，不报 missing-scenario-block')
  check(!twoDigitCodes.includes('orphan-row'), '总览表里的一行与场景块对得上，不报 orphan-row（这条记录自洽）')
  // 下界仍是 1 位：0 开头的票号不存在，不能被当成合法来源票号放过。
  const zeroBody = twoDigitBody.replace('| 97-01 |', '| 0-01 |').replace('passed 1 / failed 0 / exempt 1', 'passed 1 / failed 0 / exempt 1')
  const zeroCodes = checkChecklistConsistency({ body: zeroBody, comments: twoDigitBlocks }).findings.map((finding) => finding.code)
  check(zeroCodes.includes('malformed-row'), '0 开头的票号不是合法场景编号，仍报 malformed-row')
}

if (failed) {
  console.log('\n存在失败（共 ' + total + ' 项）')
  process.exit(1)
}
console.log('\n全部通过 · 清单票预检一致性判据门禁（#1647，共 ' + total + ' 项）')
