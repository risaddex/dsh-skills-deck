// The issue key rule must be the same wherever the panel and the host apply it (#45).
//
// Why this gate exists: Linear's keys are text (ENG-12), not numbers, so the panel carries the key as the backend gave it.
// The rule that turns "whatever a caller passed" into a key is written in several places that cannot import each other:
// the host handlers (comment-thread-fetch.ts), the client fetches and the comment submit (api-io.ts, four inline copies,
// because that file is at its line ceiling) and the navigation stack (store-prefs.ts). Nothing else forces them to agree, and one of them already
// drifted once (String(n).trim() in the cache clear gave "[object Object]" for an object).
//
// The reference below is the rule as the maintainer decided it. Each copy is read from the real source file at run time,
// compiled on its own and run on the same inputs, so a change to any copy that moves its answer turns this gate red.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { printGateResult } from './lib/gate-result.ts'

// 门禁归属: src/client/kernel/store-prefs.ts
// 门禁归属: src/client/kernel/api-io.ts
// 门禁归属: src/refresh/rooms/host/comment-thread-fetch.ts

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string, detail?: string): void => {
  assertions += 1
  if (!ok) failed += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (!ok && detail ? '\n       ' + detail : ''))
}

// A key is a finite number written as text, or non-empty trimmed text. Everything else is not a key and gives ''.
const reference = (n: unknown): string => (typeof n === 'number' ? (Number.isFinite(n) ? String(n) : '') : typeof n === 'string' ? n.trim() : '')

const INPUTS: unknown[] = [0, 7, 42, '7', '07', '01', ' 7 ', '00', -1, '-1', NaN, null, undefined, '', '  ', 'ENG-12', 'abc', Infinity, {}, [], true, false, 1.5, '1.5', 'ENG-12 ', ' ENG-12', [5], { toString: () => '9' }, Symbol.iterator]
const show = (v: unknown): string => { try { return typeof v === 'symbol' ? String(v) : typeof v === 'string' ? JSON.stringify(v) : Object.is(v, NaN) ? 'NaN' : Object.is(v, undefined) ? 'undefined' : v === Infinity ? 'Infinity' : typeof v === 'function' ? 'fn' : JSON.stringify(v) } catch { return String(v) } }

// Run one extracted expression with n bound, in a fresh context. A thrown error is reported as a result, not hidden.
function runCopy(label: string, expr: string, n: unknown): string {
  try { return String(vm.runInNewContext('(function (n) { return (' + expr + ') })', {})(n)) } catch (e) { return 'THROWS ' + (e instanceof Error ? e.message : String(e)) }
}

// 1) the navigation stack: `navKeyOf` is a function expression in store-prefs.ts
function navKeyExpr(): string {
  const src = read('src/client/kernel/store-prefs.ts')
  const start = src.indexOf('export const navKeyOf = function')
  if (start < 0) return ''
  const end = src.indexOf('\n}', start)
  if (end < 0) return ''
  // the text from `function (n: any): string {` to the closing brace, with the two type annotations removed
  return src.slice(start + 'export const navKeyOf = '.length, end + 2).replace('(n: any): string', '(n)')
}

// 2) the host: `textKeyOf` is a function declaration in comment-thread-fetch.ts
function hostKeyExpr(): string {
  const src = read('src/refresh/rooms/host/comment-thread-fetch.ts')
  const m = /function textKeyOf\(n: any\): string \{[\s\S]*?\n\}/.exec(src)
  if (!m) return ''
  return '(' + m[0].replace(/\(n: any\): string/, '(n)') + ')(n)'
}

// 3) the client fetches: the rule is written inline as `const keyText = <expression>, num: any = ...`; take the expression
function clientKeyExprs(): { where: string, expr: string }[] {
  const src = read('src/client/kernel/api-io.ts')
  const out: { where: string, expr: string }[] = []
  const re = /const keyText = ([^\n]*?), num: any = /g
  let m: RegExpExecArray | null
  const fnAt = (idx: number): string => { const before = src.slice(0, idx); const f = /export const (\w+) = function/g; let last = ''; let x: RegExpExecArray | null; while ((x = f.exec(before))) last = x[1]; return last }
  while ((m = re.exec(src))) out.push({ where: fnAt(m.index), expr: m[1] })
  return out
}

const nav = navKeyExpr()
const host = hostKeyExpr()
const client = clientKeyExprs()

check(nav !== '', 'store-prefs: navKeyOf was found in the source')
check(host !== '', 'comment-thread-fetch: textKeyOf was found in the source')
check(client.length === 4, 'api-io: the rule is written inline exactly four times (detail, cache clear, comments, comment submit)', 'found ' + client.length + ': ' + client.map((c) => c.where).join(', '))

for (const n of INPUTS) {
  const want = reference(n)
  const tag = show(n)
  if (nav) { const got = runCopy('nav', '(' + nav + ')(n)', n); check(got === want, 'navKeyOf agrees with the reference for ' + tag, 'reference ' + JSON.stringify(want) + ', copy ' + JSON.stringify(got)) }
  if (host) { const got = runCopy('host', host, n); check(got === want, 'textKeyOf agrees with the reference for ' + tag, 'reference ' + JSON.stringify(want) + ', copy ' + JSON.stringify(got)) }
  for (const c of client) {
    // the cache clear is only reached for a non-null n, so null and undefined have no key to compare there
    if (c.where === 'clearIssueDetailCache' && (n === null || n === undefined)) continue
    const got = runCopy(c.where, c.expr, n)
    check(got === want, 'api-io ' + c.where + ' agrees with the reference for ' + tag, 'reference ' + JSON.stringify(want) + ', copy ' + JSON.stringify(got))
  }
}

printGateResult('verify-45-text-key-rule', assertions, failed)
console.log(failed === 0 ? '\n全部通过 / all passed' : '\n存在失败 / failures: ' + failed)
process.exitCode = failed === 0 ? 0 : 1
