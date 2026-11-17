#!/usr/bin/env node
/**
 * scripts/verify-last.mts —— 把上一趟门禁的机器读数翻成五行人话（#34）
 *
 * 为什么要有它：`node_modules/.cache/dsh-verify-last.json` 是给机器看的（`red` / `knownRed` /
 * `newRed` / `results[].file` …），而每次想知道「这趟到底有没有新红」都得现猜字段名。猜错的代价是
 * 一轮对话，猜对之后每次还是照样翻 JSON。这个脚本只做一件事：把那份读数翻成一句话，并**在有新红时
 * 非零退出**，于是它既能当报告也能当检查。
 *
 * 它不跑门禁、不写任何文件、不判「能不能合并」—— 合并的判据仍是 `docs/agents/verification.md`：
 * 除登记在案的已知红之外，真正红的门禁为零。这里只是把那条判据读给人看。
 *
 * 用法：npm run verify:last（先跑过 npm run verify:parallel 之类，缓存才有内容）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `fileURLToPath` 而不是 `new URL(...).pathname`：后者在 Windows 上是 `/C:/…`，在带空格的目录里还是
// `%20` 编码的，于是缓存永远找不到、每次都报「还没跑过」（PR #35 review 的 P2）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 缓存位置可被环境变量改写：读法要能被夹具验证，不能只能靠跑一整条链来试。
const CACHE = process.env.DSH_VERIFY_LAST_FILE || path.join(ROOT, 'node_modules', '.cache', 'dsh-verify-last.json')
const REGISTER = path.join(ROOT, 'tests', 'known-reds.json')

interface RunResult { file?: string; code?: number | null; exitCode?: number | null; evidence?: string }
interface LastRun {
  at?: number
  head?: string
  wallMs?: number
  stepsRan?: number
  stepsTotal?: number
  red?: number
  knownRed?: number
  newRed?: number
  flaky?: number
  results?: RunResult[]
  smoke?: { red?: number; stepsRan?: number; stepsTotal?: number }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return null }
}

const last = readJson<LastRun>(CACHE)
if (!last) {
  console.log('no verification run recorded yet: run `npm run verify:parallel` (or any gate) first, then retry')
  process.exit(2)
}

// 登记表只认 file；形状变过（早先是字符串数组，现在是 {file, note}），所以两种都收。
const register = readJson<{ failures?: Array<string | { file?: string }> }>(REGISTER)
const onRegister = new Set<string>()
for (const entry of (register && register.failures) || []) {
  const file = typeof entry === 'string' ? entry : (entry && entry.file) || ''
  if (file) onRegister.add(file)
}

// 红的判据与并行跑者一致：**以 `code` 为准**。`runStepJudged` 在「退出码 0 但完成证据对不上」时
// 专门把 `code` 记成 1、把真实退出码留在 `exitCode` 里 —— 先看 `exitCode` 就会把这种失败读掉
// （PR #35 review 的 P1）。
function judgedRed(row: RunResult): boolean {
  const judged = typeof row.code === 'number' ? row.code : row.exitCode
  return typeof judged === 'number' && judged !== 0
}
const results = Array.isArray(last.results) ? last.results : []
// 冒烟单独记在 `smoke.results` 里；计划本身失败记在 `smoke.problem`。两处都算进判据，
// 否则「主链全绿、冒烟红了」会被读成「没有新红」（PR #35 review 的 P1）。
const smokeRows = last.smoke && Array.isArray(last.smoke.results) ? (last.smoke.results as RunResult[]) : []
const smokeProblem = String((last.smoke && last.smoke.problem) || '')
const failing = results.concat(smokeRows).filter(judgedRed)
const fresh = failing.map((row) => String(row.file || '(unnamed)')).filter((file) => !onRegister.has(file))
if (smokeProblem) fresh.push('smoke plan: ' + smokeProblem.slice(0, 120))
const when = last.at ? new Date(last.at).toISOString().replace('T', ' ').slice(0, 19) : 'unknown time'
const head = String(last.head || '').slice(0, 8) || 'unknown head'
const seconds = typeof last.wallMs === 'number' ? Math.round(last.wallMs / 100) / 10 + 's' : 'unknown'
const smoke = last.smoke || {}

console.log('last run   ' + when + ' · head ' + head + ' · ' + String(last.stepsRan ?? '?') + '/' + String(last.stepsTotal ?? '?') + ' steps · ' + seconds)
console.log('red gates  ' + String(last.red ?? failing.length) + ' · on the register ' + String(last.knownRed ?? '?') + ' · new ' + String(last.newRed ?? fresh.length) + ' · flaky ' + String(last.flaky ?? 0))
console.log('new reds   ' + (fresh.length > 0 ? fresh.join(', ') : 'none'))
console.log('smoke      ' + String(smoke.red ?? smokeRows.filter(judgedRed).length) + ' red of ' + String(smoke.stepsRan ?? 0) + '/' + String(smoke.stepsTotal ?? 0) + (smokeProblem ? ' · plan failed: ' + smokeProblem.slice(0, 80) : ''))

if (fresh.length > 0) {
  console.log('')
  console.log('this run is NOT mergeable: ' + fresh.length + ' gate(s) red that are not on tests/known-reds.json')
  for (const row of failing.concat(smokeProblem ? [{ file: 'smoke plan', evidence: smokeProblem } as RunResult] : [])) {
    const file = String(row.file || '')
    if (file !== 'smoke plan' && onRegister.has(file)) continue
    const why = String(row.evidence || '').slice(0, 200)
    console.log('  - ' + file + (why ? ' — ' + why : ''))
  }
  process.exit(1)
}
console.log('verdict    every red gate is on the register; nothing new')
