// #9: the English-first client must keep destructive confirmation exact, while ledger codes stay
// unchanged behind translated display text. Run with scripts/ts-hook.mts; no network or live profile.
// 门禁归属: src/client/kernel/store-switch.ts
// 门禁归属: src/client/views/shared/SwitchConfirmModal.ts
// 门禁归属: src/client/kernel/slotRenderer-queue.ts
// 门禁归属: src/client/kernel/api-new-session.ts
// 门禁归属: src/client/views/versionControl/vcPageHead.ts
// 门禁归属: src/client/views/versionControl/vcPalette.ts
// 门禁归属: src/client/views/versionControl/vcShellPrimitives.ts
// 门禁归属: config/copy/word.yaml
// 门禁归属: config/copy/vcshell.yaml
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileFn } from './lib/eval-probe.ts'
import { spliceableJs } from './lib/source-text.ts'
import { ensureLocaleData } from './lib/locale-data.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const locale: any = await import(pathToFileURL(path.join(ROOT, ensureLocaleData(ROOT))).href)
const trOf = (lang: string) => (key: string, params?: any): string => {
  let out = String(locale.LOCALE_COPY[lang][key] ?? key)
  for (const [name, value] of Object.entries(params || {})) out = out.split('{' + name + '}').join(String(value))
  return out
}
const source = (f: string): string => spliceableJs(f).replace(/^[ 	]*export[ 	]+/gm, '').replace(/^import .*$/gm, '')
const load = (files: string[], names: string[], deps: Record<string, any>): any =>
  compileFn(Object.keys(deps), files.map(source).join('\n') + '\nreturn {' + names.join(',') + '};')(...Object.values(deps))
const h = (type: any, props: any, ...kids: any[]): any => ({ type, props: props || {}, children: kids.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(nodes)]
const text = (node: any): string => node === null || node === undefined ? '' : typeof node !== 'object' ? String(node) : (node.children || []).map(text).join('')
let count = 0
const check = (value: any, why: string) => { assert.ok(value, why); count += 1 }

// Inject the otherwise locked clear option into a store fixture solely to test both barriers. The
// real UI must still refuse selecting clear/migrate, and that lock is tested separately below.
for (const lang of ['en', 'zh']) {
  const tr = trOf(lang)
  const keyword = tr('switch.clearKeyword')
  check(keyword === (lang === 'en' ? 'CONFIRM CLEAR' : '确认清空'), lang + ': one keyword in the copy table')
  const sent: any[] = []
  const kernel = load(['src/client/kernel/store-switch.ts'], ['switchClearKeyword', 'confirmSwitchConfirm'], {
    tr, emit() {}, setCachedSelection() {}, host: { call: (...args: any[]) => { sent.push(args); return new Promise(() => {}) } },
  })
  const state = (input: string): any => ({ cwd: '/test', selection: { backendId: 'github' }, switchConfirm: { open: true, curBackendId: 'github', targetBackendId: 'gitlab', option: 'clear', clearInput: input } })
  const invalid = ['', keyword.slice(0, -1), ' ' + keyword, keyword + ' ', lang === 'en' ? keyword.toLowerCase() : 'CONFIRM CLEAR', lang === 'en' ? '确认清空' : 'confirm clear']
  const makeView = (st: any) => {
    const React = { useContext: () => ({ h, storeSvc: { useStore: () => st } }), useEffect() {} }
    return load(['src/client/views/shared/SwitchConfirmModal.ts'], ['SwitchConfirmModal'], {
      React, DswsCtx: {}, h, tr, switchClearKeyword: kernel.switchClearKeyword, Tip: 'tip', otherFiltered: () => [], emit() {},
    }).SwitchConfirmModal({ sessionId: 'test' })
  }
  for (const input of invalid) {
    const st = state(input)
    kernel.confirmSwitchConfirm(st)
    check(sent.length === 0 && !st.switchConfirm.confirming, lang + ': store rejects ' + JSON.stringify(input))
    const tree = makeView(st)
    const button = nodes(tree).find(n => n.props['data-log'] === 'switch.confirm')
    const field = nodes(tree).find(n => n.type === 'input')
    check(button?.props.disabled === true, lang + ': modal rejects ' + JSON.stringify(input))
    check(field?.props.placeholder === keyword && text(tree).includes(tr('switch.clearDesc', { keyword })) && text(tree).includes(tr('switch.clearNeedInput', { keyword })), lang + ': visible prompt and placeholder use the exact keyword')
  }
  const st = state(keyword)
  const tree = makeView(st)
  check(nodes(tree).find(n => n.props['data-log'] === 'switch.confirm')?.props.disabled === false, lang + ': exact keyword satisfies the modal barrier')
  kernel.confirmSwitchConfirm(st)
  check(sent.length === 1 && sent[0][0] === 'wf.bind' && st.switchConfirm.confirming, lang + ': exact keyword satisfies the store barrier')
  const normal = state(''); normal.switchConfirm.option = 'keep'
  const locked = nodes(makeView(normal)).filter(n => n.props['data-opt-locked'] === 1)
  check(locked.length === 2, lang + ': clear and migrate remain locked')
  locked.forEach(n => n.props.onClick())
  check(normal.switchConfirm.option === 'keep', lang + ': locked options cannot be selected')
}
// With no copy translator, an empty keyword is not a valid confirmation.
const noTr = load(['src/client/kernel/store-switch.ts'], ['switchClearKeyword', 'confirmSwitchConfirm'], { emit() {} })
check(noTr.switchClearKeyword() === '', 'missing translator returns no valid keyword')
const empty: any = { switchConfirm: { targetBackendId: 'gitlab', option: 'clear', clearInput: '' } }
noTr.confirmSwitchConfirm(empty)
check(!empty.switchConfirm.confirming, 'missing translator cannot authorize the operation')

// Bilingual labels respect the active language, with English as the fallback rather than zh first.
for (const lang of ['en', 'zh', 'unknown']) {
  const mod = load(['src/client/kernel/slotRenderer-queue.ts'], ['openFormModal'], { promptLang: () => lang, emit() {}, flash() {} })
  const st: any = {}
  mod.openFormModal(st, { type: 'form', schema: [], label: { en: 'English label', zh: '中文标签' } }, () => {})
  check(st.formModal.label === (lang === 'zh' ? '中文标签' : 'English label'), lang + ': correct form label')
}

// Level/form are internal codes. Keep them unchanged for tones and decisions, translating only what
// the user sees. English copy and Chinese copy come from the real generated table, not test strings.
const levels = ['读', '写', '改写', '毁', '非 git']
const forms = ['操作', '只读', '说明']
const caps = levels.map((level, i) => ({ id: String(i + 1), name: 'Capability ' + i, level, finalForm: forms[i % forms.length], page: 'worktrees', domainName: 'Domain' }))
for (const lang of ['en', 'zh']) {
  const t = trOf(lang)
  const view = load([
    'src/client/views/versionControl/vcPageHead.ts', 'src/client/views/versionControl/vcShellPrimitives.ts', 'src/client/views/versionControl/vcPalette.ts',
  ], ['vcCapLevelTextOf', 'vcCapFormTextOf', 'vcPageCapSummaryNode', 'vcShellSurfaceNode', 'vcShellCapabilityRowNode', 'vcCapabilitySummaryOf', 'vcCapabilityPageNameOf', 'vcPaletteMatchOf', 'vcCapabilityNeedsObjectOf', 'vcCapabilitySurfaceKindOf'], {
    CAPABILITIES: caps, PAGE_SURFACES: [{ id: 'worktrees', name: 'Worktrees' }], vcCapabilityOf: (id: string) => caps.find(c => c.id === id),
  })
  for (const cap of caps) {
    const level = view.vcCapLevelTextOf(t, cap.level)
    const form = view.vcCapFormTextOf(t, cap.finalForm)
    check(lang === 'en' ? !/[㐀-鿿]/.test(level + form) : level === cap.level && form === cap.finalForm, lang + ': display text has the expected language')
    const head = view.vcPageCapSummaryNode(h, t, cap.id, '')
    const chip = nodes(head).find(n => (n.props.className || '').includes('obj-cap-level'))
    check(text(chip) === level && chip.props.title.endsWith(level) && chip.props['aria-label'].endsWith(level), lang + ': text and accessible labels use the translated level')
    const surface = view.vcShellSurfaceNode(h, t, { cap })
    check(text(surface).includes(level) && text(surface).includes(form), lang + ': surface translates both fields')
    const row = view.vcShellCapabilityRowNode(h, t, { cap })
    check(text(row).includes(level + ' · ' + form), lang + ': row badges translate both fields')
    check(view.vcCapabilitySummaryOf(cap, t).endsWith(form), lang + ': palette summary translates the final form')
    check(cap.level === levels[Number(cap.id) - 1], lang + ': the ledger code is not mutated')
    check(view.vcCapabilityNeedsObjectOf(cap) === ['写', '毁', '改写'].includes(cap.level), lang + ': object requirements still use the raw code')
  }
  check(view.vcCapabilityPageNameOf(caps[0], t) === t('vc.shell.tab.worktrees'), lang + ': palette page name matches the visible tab')
  check(view.vcPaletteMatchOf(t('vc.shell.tab.worktrees'), '', t).length === caps.length, lang + ': search recognizes the displayed page name')
  check(view.vcCapLevelTextOf(t, 'future') === 'future' && view.vcCapFormTextOf(t, 'future') === 'future', lang + ': unknown codes remain visible')
}

// New-session inference reads old Chinese markers and the English prompts shipped by this fork.
const named: string[] = []
const naming = load(['src/client/kernel/api-new-session.ts'], ['openTextInNewSession'], {
  ctx: { get: () => null }, newSessionTitleNew: (kind: string) => { named.push(kind); return kind }, inject() {}, flash() {}, tr: (k: string) => k,
})
for (const [prompt, kind] of [
  ['Start from first principles.\n\n## Health check (put orphaned open tickets where they belong)', 'health'],
  ['从第一性原理出发。\n\n## 体检（把游离的开放票归位）', 'health'],
  ['Pause progress and run the "alignment & consolidation" pass', 'supplement'],
  ['思维对齐 · 成果沉淀', 'supplement'],
]) {
  naming.openTextInNewSession({}, prompt, '[New] New Requirement')
  check(named.pop() === kind, 'inference reads: ' + kind)
}
console.log('PASS verify-9-client-english (' + count + ' checks)')
