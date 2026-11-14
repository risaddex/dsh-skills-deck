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
const SCOPES: string[] = ['src/refresh', 'src/shared']
const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/

type Allow = { file: string; literal: string; reason: string }
/** 豁免表：只收契约性的中文字面量，文案一律翻译。 */
const ALLOW: Allow[] = [
  {
    "file": "src/shared/version-control/src/migrate-actions.ts",
    "literal": "'写'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/migrate-actions.ts",
    "literal": "'毁'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/migrate-actions.ts",
    "literal": "'读'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/sync-actions.ts",
    "literal": "'写'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/sync-actions.ts",
    "literal": "'改写'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/sync-actions.ts",
    "literal": "'毁'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/stash-rules.ts",
    "literal": "'读'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/stash-rules.ts",
    "literal": "'写'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/stash-rules.ts",
    "literal": "'毁'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/worktree-ops.ts",
    "literal": "'读'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/worktree-ops.ts",
    "literal": "'写'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/worktree-ops.ts",
    "literal": "'毁'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/undo-ops.ts",
    "literal": "'直'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/version-control/src/undo-ops.ts",
    "literal": "'折'",
    "reason": "Stable capability enum shared with host and client; the client translates its display (#9)."
  },
  {
    "file": "src/shared/naming-attribution.ts",
    "literal": "/^[^:：]{1,12}[:：]\\s*/",
    "reason": "Recognizes punctuation in existing Chinese session titles; reading remains bilingual."
  },
  {
    "file": "src/shared/naming-attribution.ts",
    "literal": "/^[\\s:：,，。.]+$/",
    "reason": "Recognizes punctuation in existing Chinese session titles; reading remains bilingual."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'交接'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'实施地图'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "/^\\[(草稿|Draft)\\](?: .+)?$/",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "/实施地图|Impl map/i",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'新建需求'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'新增需求'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'新建bug'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'新增bug'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'诊断'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'修复'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'讨论'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'研究'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'原型'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'接手'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'补充'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  },
  {
    "file": "src/shared/naming-titles.ts",
    "literal": "'体检'",
    "reason": "Recognizes legacy Chinese placeholder and draft titles; new titles use the selected language with English fallback."
  }
]

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
    // issue-file 的正文格式由 #10 负责；派生 ledger 在下方按字段验证，避免把契约枚举误判成文案。
    if (rel.startsWith('src/shared/issue-file/') || rel === 'src/shared/version-control/src/capability-ledger.ts') continue
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
    if (ts.isConditionalExpression(p) && p.whenTrue === child && /^(?:zh|\(?lang\s*===\s*'zh'\)?)$/i.test(p.condition.getText().trim())) return true
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'zh') return true
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


// 生成账本的自由文案必须英文，内部枚举保留原值以免跨目录破坏契约（#9 在展示边界翻译）。
const ledger: any = await import('../src/shared/version-control/src/capability-ledger.ts')
const caps: any[] = ledger.CAPABILITIES
check(Array.isArray(caps) && caps.length === 162, '账本仍有全部 162 条能力')
const fields = ['name', 'domainName', 'command', 'panelPath', 'versionAlternative', 'researchBasis']
check(caps.every((c) => fields.every((k) => c[k] == null || !CJK.test(String(c[k])))), '账本自由文案全英文（不把 enum 当文案改掉）')
check(ledger.PAGE_SURFACES.every((p: any) => !CJK.test(p.name)), '账本页面名称全英文')
check(caps.every((c) => ['读', '写', '毁', '改写', '非 git'].includes(c.level) && ['直', '折', '诊', '外'].includes(c.placement) && ['操作', '只读', '说明'].includes(c.finalForm)), '账本 level/placement/finalForm 契约值保持不变')
const naming: any = await import('../src/shared/naming-titles.ts')
check(naming.newSessionTitleNew('bug') === '[New] New Bug' && naming.draftWordFor(undefined) === 'Draft', '无语言信息时会话标题用英文')
check(naming.newSessionTitleNew('bug', 'zh') === '[New] 新建 Bug' && naming.draftWordFor('zh') === '草稿', '明确选择 zh 时会话标题仍可用中文')
check(naming.isPlaceholderTitle('[New] 新建 Bug') && naming.isPlaceholderTitle('[New] New Bug'), '旧中文与英文占位都继续识别')
const probeChannels: any = await import('../src/shared/skill-probe-channels.ts')
const sample = [{ channel: 'fs', root: 'user', result: 'valid' }, { channel: 'registry', root: 'user', result: 'missing' }]
check(!CJK.test(probeChannels.evidenceSummary(sample, undefined)) && !CJK.test(probeChannels.evidenceSummary(sample, 'en')), '技能探测的默认与英文证据没有混进中文状态词')
check(CJK.test(probeChannels.evidenceSummary(sample, 'zh')), '技能探测的明确 zh 证据仍保留中文')

// 不交 GATE-RESULT 完成记录：那需要在 scripts/gate-map.mts 的期望表登记断言数，并行翻译期间那张表是多人共改的热点；
// 执行器对没登记的门禁只看退出码，判据同样有效。
console.log('断言 ' + (pass + fail) + ' 条，失败 ' + fail + ' 条')
if (fail > 0) { console.log('存在失败：' + failures.length + ' 条'); process.exitCode = 1 } else { console.log('全部通过') }
