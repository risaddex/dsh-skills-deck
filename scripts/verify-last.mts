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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'dsh-verify-last.json')
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

// 红的判据与并行跑者一致：退出码非零；缺退出码时退回 code。
const results = Array.isArray(last.results) ? last.results : []
const failing = results.filter((row) => (typeof row.exitCode === 'number' ? row.exitCode !== 0 : (typeof row.code === 'number' && row.code !== 0)))
const fresh = failing.map((row) => String(row.file || '(unnamed)')).filter((file) => !onRegister.has(file))
const when = last.at ? new Date(last.at).toISOString().replace('T', ' ').slice(0, 19) : 'unknown time'
const head = String(last.head || '').slice(0, 8) || 'unknown head'
const seconds = typeof last.wallMs === 'number' ? Math.round(last.wallMs / 100) / 10 + 's' : 'unknown'
const smoke = last.smoke || {}

console.log('last run   ' + when + ' · head ' + head + ' · ' + String(last.stepsRan ?? '?') + '/' + String(last.stepsTotal ?? '?') + ' steps · ' + seconds)
console.log('red gates  ' + String(last.red ?? failing.length) + ' · on the register ' + String(last.knownRed ?? '?') + ' · new ' + String(last.newRed ?? fresh.length) + ' · flaky ' + String(last.flaky ?? 0))
console.log('new reds   ' + (fresh.length > 0 ? fresh.join(', ') : 'none'))
console.log('smoke      ' + String(smoke.red ?? 0) + ' red of ' + String(smoke.stepsRan ?? 0) + '/' + String(smoke.stepsTotal ?? 0))

if (fresh.length > 0) {
  console.log('')
  console.log('this run is NOT mergeable: ' + fresh.length + ' gate(s) red that are not on tests/known-reds.json')
  for (const row of failing) {
    const file = String(row.file || '')
    if (onRegister.has(file)) continue
    const why = String(row.evidence || '').slice(0, 200)
    console.log('  - ' + file + (why ? ' — ' + why : ''))
  }
  process.exit(1)
}
console.log('verdict    every red gate is on the register; nothing new')
