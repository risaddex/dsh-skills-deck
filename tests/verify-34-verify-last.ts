// tests/verify-34-verify-last.ts —— `npm run verify:last` 这套读法的门禁（#34 新增，PR #35 review 后补）
//
// 门禁归属: scripts/verify-last.mts
//
// 为什么有这扇门禁：
//   scripts/verify-last.mts 是「把上一趟门禁的机器读数翻成人话」的小工具，它本身不是门禁，但它决定
//   人会不会因为一句错话去合并或去修不存在的东西。PR #35 的评审在两轮里指出四处读法错误，全部是
//   「读法比跑者的判定宽或窄」：
//     · 先看 exitCode 而不是 code —— 完成证据对不上的步会被读掉（跑者特意记 code:1 留真实 exitCode）；
//     · 只看 results 不看 smoke.results / smoke.problem —— 冒烟红了却打印「没有新红」；
//     · 不排除 optional —— 可选的预构建失败会让结论与跑者的 red 0 相反；
//     · new URL(...).pathname 拼路径 —— Windows 与带空格路径下根本找不到缓存，永远报「还没跑过」。
//   这些都不是靠再读一遍代码能守住的，只能靠夹具把四种形状各钉一次：所以这里用 DSH_VERIFY_LAST_FILE
//   指向造出来的缓存，跑真的脚本、看它真的退出码与真的输出行。
//
// 这扇门禁能红也能绿：把 verify-last.mts 里的 code 改回 exitCode、或把 optional 的排除去掉、或把 smoke
// 两条来源删掉，下面必有一条红。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const READER = path.join(ROOT, 'scripts', 'verify-last.mts')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-last-'))

let checks = 0
const failures: string[] = []
function check(ok: boolean, label: string, detail?: string): void {
  checks++
  if (ok) { console.log('  ✓ ' + label); return }
  failures.push(label + (detail ? ' —— ' + detail : ''))
  console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''))
}

// 验证「在案的红不算新红」用的是本门禁自带的一份样例登记表（经 DSH_KNOWN_REDS_FILE 交给读法），不读真登记表：
// 真登记表的目标就是空（#42 已清空），空了这扇门也不能假红或假绿。
const registered = 'tests/verify-sample-registered.ts'

interface Fixture { name: string; cache: unknown | null; expectExit: number; expectLines: string[]; forbidLines?: string[] }

function row(file: string, code: number, exitCode: number, optional = false) {
  return { file, code, ms: 10, at: Date.now(), exitCode, optional, evidence: '' }
}

function base(extra: Record<string, unknown>) {
  return { at: Date.now(), head: 'd'.repeat(40), node: 'v24.15.0', pid: 1, wallMs: 1234, jobs: 8, tier: 'chain', stepsRan: 1, stepsTotal: 1, red: 0, chainRed: 0, knownRed: 0, newRed: 0, flaky: 0, results: [], smoke: { ran: true, red: 0, stepsRan: 1, stepsTotal: 1, results: [] }, ...extra }
}

const fixtures: Fixture[] = [
  {
    name: '一趟全绿：二十四红全在登记表上，结论是「没有新红」并且退出码为 0'
    ,
    cache: base({ red: 0, results: [row('tests/verify-x.ts', 0, 0)] }),
    expectExit: 0,
    expectLines: ['new reds   none', 'verdict    every red gate is on the register'],
  },
  {
    name: '退出码 0 但完成证据对不上（code 记 1）：必须算新红，退出码 1'
    ,
    cache: base({ red: 1, newRed: 1, results: [row('tests/verify-fake-completion.ts', 1, 0)] }),
    expectExit: 1,
    expectLines: ['tests/verify-fake-completion.ts', 'NOT mergeable'],
  },
  {
    name: '主链全绿、冒烟红：也要算新红，并把冒烟那条点名'
    ,
    cache: base({ red: 1, newRed: 1, results: [row('tests/verify-x.ts', 0, 0)], smoke: { ran: true, red: 1, stepsRan: 1, stepsTotal: 8, results: [row('tests/smoke-fake.test.ts', 1, 1)] } }),
    expectExit: 1,
    expectLines: ['tests/smoke-fake.test.ts', 'NOT mergeable'],
  },
  {
    name: '冒烟计划本身失败（smoke.problem）：算新红，并说明计划失败'
    ,
    cache: base({ red: 1, newRed: 1, results: [row('tests/verify-x.ts', 0, 0)], smoke: { ran: false, red: 0, stepsRan: 0, stepsTotal: 0, problem: 'scripts.smoke missing', results: [] } }),
    expectExit: 1,
    expectLines: ['plan failed', 'smoke plan'],
  },
  {
    name: '可选的预构建红、其余全过：与跑者的 red 0 一致，退出码 0 并说明被排除'
    ,
    cache: base({ red: 0, results: [row('scripts/build.mts', 1, 1, true), row('tests/verify-x.ts', 0, 0)] }),
    expectExit: 0,
    expectLines: ['optional   scripts/build.mts (excluded'],
    forbidLines: ['NOT mergeable'],
  },
];

for (const [i, fx] of fixtures.entries()) {
  console.log('')
  console.log('[' + (i + 1) + '] ' + fx.name)
  const file = path.join(TMP, 'cache-' + i + '.json')
  if (fx.cache === null) fs.writeFileSync(file, '{ this is not json')
  else fs.writeFileSync(file, JSON.stringify(fx.cache, null, 2))
  const run = spawnSync(process.execPath, [READER], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_VERIFY_LAST_FILE: file } })
  const stdout = String(run.stdout || '') + String(run.stderr || '')
  check(run.status === fx.expectExit, '退出码是 ' + fx.expectExit, '实际 ' + String(run.status) + '：' + stdout.replace(/\n/g, ' | ').slice(0, 200))
  for (const want of fx.expectLines) {
    check(stdout.includes(want), '输出里有「' + want + '」', stdout.replace(/\n/g, ' | ').slice(0, 200))
  }
  for (const never of fx.forbidLines || []) {
    check(!stdout.includes(never), '输出里没有「' + never + '」', stdout.replace(/\n/g, ' | ').slice(0, 200))
  }
}

console.log('')
console.log('[6] 登记表里的已知红不算新红；缓存不存在时退 2 并说清要先跑门禁')
const knownFile = path.join(TMP, 'cache-known.json')
fs.writeFileSync(knownFile, JSON.stringify(base({ red: 1, knownRed: 1, results: [row(registered, 1, 1)] }), null, 2))
const sampleRegister = path.join(TMP, 'sample-known-reds.json')
fs.writeFileSync(sampleRegister, JSON.stringify({ failures: [{ file: registered, note: 'fixture entry for the reader gate' }] }, null, 2))
const knownRun = spawnSync(process.execPath, [READER], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_VERIFY_LAST_FILE: knownFile, DSH_KNOWN_REDS_FILE: sampleRegister } })
check(knownRun.status === 0, '在案的红不判成新红，退出码 0', String(knownRun.stdout || '').replace(/\n/g, ' | ').slice(0, 200))
const missing = spawnSync(process.execPath, [READER], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_VERIFY_LAST_FILE: path.join(TMP, 'absent.json') } })
check(missing.status === 2, '没有缓存时退出码 2', String(missing.status))
check(String(missing.stdout || '').includes('no verification run recorded yet'), '没有缓存时说清先跑一次门禁', String(missing.stdout || '').slice(0, 160))

fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
if (failures.length > 0) {
  console.log('✗ verify:last 读法门禁失败：' + failures.length + ' 项（共 ' + checks + ' 项检查）')
  process.exitCode = 1
} else {
  console.log('✓ verify:last 读法门禁通过：' + checks + ' 项检查')
}
