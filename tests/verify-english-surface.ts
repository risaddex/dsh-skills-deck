// tests/verify-english-surface.ts —— 英文优先的界面与回执文字门禁（#8）
// 门禁归属: src/refresh/
// 门禁归属: src/shared/
//
// 为什么要有它：英文优先（docs/adr/20261113-english-first.md）要求用户与 AI 看得到的文字都写英文，
// 中文只留在两处：代码注释，以及明确按语言分支写出的 zh 文案（例如 `zh ? '中文' : 'English'`）。
// 翻译是按目录分票做的，没有这扇门，下一次有人往 src/refresh 或 src/shared 里加一句中文字面量，
// 链上一条红都不会有。这里逐个扫字符串字面量与模板片段（注释不扫），出现中日韩字符就判红，
// 除非它落在下面三种情形之一：
//   ① 在 zh 语言分支里：条件是 zh 标识符（三元的真分支、if (zh) 的 then 块），或赋给名字以 Zh/ZH 结尾的变量；
//   ② 在豁免表 ALLOW 里点名（文件 + 字面量原文 + 理由），每条都是契约而不是文案；
//   ③ 文件不在本门禁的范围里（SCOPES 之外）。
// 另外钉住一条：promptLang 不可用时的兜底语言必须是 en，不能再写 'zh'（ADR 第 2 条：缺省落到英文）。
//
// 反例：把整份文件塞进豁免表来求绿 —— 豁免表只收单个字面量，且必须写理由；
// 一条豁免在源码里已经找不到时同样判红，免得豁免表越积越长、谁也不知道哪条还有用。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-english-surface.ts
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts: any = require('typescript-ast')

const ROOT: string = path.resolve(import.meta.dirname, '..')
/** 本门禁负责的目录：#8 翻完的目录才进来，别的目录由各自的翻译票加进来。 */
const SCOPES: string[] = ['src/refresh']
const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/

type Allow = { file: string; literal: string; reason: string }
/** 豁免表：只收契约性的中文字面量，文案一律翻译。 */
const ALLOW: Allow[] = []

let pass = 0
let fail = 0
const failures: string[] = []
function check(ok: boolean, label: string): void {
  if (ok) { pass++; console.log('  PASS ' + label) } else { fail++; failures.push(label); console.log('  FAIL ' + label) }
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'generated') walk(rel, out); continue }
    if (/\.(ts|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
}

function isLiteral(n: any): boolean {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)
}

/** 情形①：这个字面量是不是写在 zh 语言分支里。 */
function inZhBranch(node: any): boolean {
  let child = node
  let p = node.parent
  while (p) {
    if (ts.isConditionalExpression(p) && p.whenTrue === child && /^zh$/i.test(p.condition.getText().trim())) return true
    if (ts.isIfStatement(p) && p.thenStatement === child && /^zh$/i.test(p.expression.getText().trim())) return true
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && /(Zh|ZH)$/.test(p.name.text)) return true
    if (ts.isFunctionLike(p)) return false
    child = p
    p = p.parent
  }
  return false
}

const files: string[] = []
for (const s of SCOPES) walk(s, files)
const usedAllow = new Set<number>()
const offenders: string[] = []
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  if (/promptLang\(\)\s*:\s*'zh'/.test(text)) offenders.push(rel + ': promptLang fallback still names zh')
  if (!CJK.test(text)) continue
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  const visit = (n: any): void => {
    if (isLiteral(n)) {
      const lit = n.getText(sf)
      if (CJK.test(lit) && !inZhBranch(n)) {
        const idx = ALLOW.findIndex((a) => a.file === rel && a.literal === lit)
        if (idx >= 0) usedAllow.add(idx)
        else offenders.push(rel + ':' + (sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1) + ' ' + lit.slice(0, 80))
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

console.log('英文优先文字门禁（#8）：扫 ' + files.length + ' 个文件，范围 ' + SCOPES.join(', '))
check(files.length > 0, '范围内找得到源码文件（实得 ' + files.length + ' 个）')
check(offenders.length === 0, '范围内没有落在 zh 分支与豁免表之外的中文字面量' + (offenders.length ? '：\n    ' + offenders.slice(0, 40).join('\n    ') : ''))
const stale = ALLOW.filter((_, i) => !usedAllow.has(i))
check(stale.length === 0, '豁免表每一条都还用得上' + (stale.length ? '：' + stale.map((a) => a.file + ' ' + a.literal).join('；') : ''))
check(ALLOW.every((a) => a.reason.length >= 20), '豁免表每一条都写了理由')

// 自检：判据要有牙齿 —— 一句裸中文必须被认出，zh 分支里的同一句必须放过。
const probe = ts.createSourceFile('probe.ts', "const a = '中文'\nconst b = zh ? '中文' : 'English'\n", ts.ScriptTarget.Latest, true)
const probeHits: boolean[] = []
const pv = (n: any): void => { if (isLiteral(n) && CJK.test(n.getText(probe))) probeHits.push(inZhBranch(n)); ts.forEachChild(n, pv) }
pv(probe)
check(probeHits.length === 2 && probeHits[0] === false && probeHits[1] === true, '自检：裸中文判红、zh 分支放过（实得 ' + JSON.stringify(probeHits) + '）')

// 不交 GATE-RESULT 完成记录：那需要在 scripts/gate-map.mts 的期望表登记断言数，并行翻译期间那张表是多人共改的热点；
// 执行器对没登记的门禁只看退出码，判据同样有效。
console.log('断言 ' + (pass + fail) + ' 条，失败 ' + fail + ' 条')
if (fail > 0) { console.log('存在失败：' + failures.length + ' 条'); process.exitCode = 1 } else { console.log('全部通过') }
