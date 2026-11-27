/**
 * src/client/kernel/settings-prompt-overrides.ts — 内核模块（#100：每个动作按钮注入的提示词可以在本机设置里改写）
 *
 * 契约：本文件为模块真源（ESM 导出）；scripts/build.mts 在构建时去掉每行行首 export 关键字，把声明体文本
 *   拼回 src/client/index.ts 里那一行 kernel:settingsPromptOverrides 拼接标记处（apply 闭包内原位）。
 *   这一行标记必须排在 kernel:settingsViewWrite 与 kernel:settingsViewReload 之后：本片要用它们的待写队列、
 *   防抖排期与文档状态（viewFlagState / viewFlagScheduleWrite），与 settings-ui.ts、settings-templates.ts 同型。
 *   本片没有真实的值 import（构建会拒绝残留的模块级 import/export），跨片引用一律写 declare；
 *   唯一的 import type 只是给 TypeScript 看，构建时整条擦除。
 *
 * 它管什么：本机设置文件 settings.yaml 里新增的 promptOverrides 节。键是提示词登记表（config/prompts/ 生成的
 *   PROMPTS）里的 id，值是用户改写后的整段提示词；值为空串（或去掉首尾空白后为空）表示「这一格用插件自带的默认
 *   文本」。读口是 promptOverrideOf（提示词取用口 promptText 在拿到默认正文之后问它一句），写口是
 *   setPromptOverride（设置页每一格的「保存」与「恢复默认」）。
 *
 * 与旧的 templates 节的关系（维护者 2026-11-24 定：旧节原样留着，不动）：templates 节是 11 条旧动作模板，编辑入口
 *   在 #519 已删，键是 diagnose / fix 这类旧名字；本节的键是登记表 id（tpl.diagnose / mapInspect …），两处互不读取。
 *   唯一的交点在 config.ts 的 tplText：同一个按钮若旧节里还留着非空的老文本，它会先于默认文本生效，所以 tplText
 *   在本节有生效的改写时让改写赢（见那里的注释），否则用户在设置页改了字、按钮却还在发旧文本。
 *
 * 为什么没有「写不进文件就写旧键兜底」那一条：旧的三族（ui / templates / debug）有 localStorage 旧键可退，本节是新的，
 *   没有旧键；写不进文件时这一笔留在待写队列里等下一趟，内存文档里已经改好，所以本次会话内按钮仍用改写后的文本，
 *   settings-view-write.ts 的兜底分支对本节只跳过、不另写别处。
 *
 * 几条约定，改之前先读懂：
 *   一、生效的改写必须通过校验才用：去掉空白后非空、没有登记表之外的占位符、该有的 {url} 没丢。手改文件造出的坏值
 *       不会让按钮注入一段没有链接的提示词，而是按默认文本走（设置页那一格会标出「这一条没有生效」及原因）。
 *   二、允许的占位符 = 登记条目声明的占位符 ∪ 默认正文里实际出现的占位符 ∪ 词表占位符 {cli} {cliBrand}。
 *       必须保留的只有 {url}，而且只在默认正文里本来就有它时才要求。
 *   三、改写按语言无关存一份：默认正文有中英两版，改写只有一份文字，所以设置页的说明里写明「改写对所有语言生效」。
 *   四、文档还在路上（loading）时读口回空串（按默认文本走）；写口直接拒绝（reason: loading）而不是先记着：先记着的话，
 *       文档随后若读失败或是更高版本，这一笔就既不在文档里也不在待写队列里，设置页却已经弹了「已保存」并丢掉了草稿
 *       （#111 评审指出的丢字缺口）。拒绝时设置页保留草稿，用户等文档到手再点一次保存。所以本节不进 deferred，也没有收口函数。
 */
import type { PromptTemplateId } from './prompt-data.js'

// 跨闭包的值引用按仓里规矩写模块级 declare（实现只在拼好的闭包里有一份，类型检查各看各的）：
// viewFlagState 的真源在 kernel/settings-view-state.ts，settingsViewLoad 在 kernel/settings-view.ts，
// viewFlagScheduleWrite 在 kernel/settings-view-write.ts，PROMPTS / promptChainOf / promptPickText 在 kernel/prompts.ts。
// 类型一律写 any 是刻意的：在这里凭记忆写窄，只会把那边正常的改动变成这里的假报错（与 kernel/link.ts 同例）。
declare const viewFlagState: any
declare const PROMPTS: any
declare function settingsViewLoad(...args: any[]): any
declare function viewFlagScheduleWrite(...args: any[]): any
declare function promptChainOf(...args: any[]): any
declare function promptPickText(...args: any[]): any
// 此片也作为宿主的模块编译；宿主只调用下方不依赖日志的纯校验函数。
declare function log(...args: any[]): void

/**
 * 设置页给出改写入口的提示词 id（维护者 2026-11-24 定：只给「点在 issue 或 map 上的动作按钮」）。
 * 用 satisfies 对着生成物里的 id 联合类型校验：拼错、或登记表里删了某个 id，类型检查当场红，
 * 不会拖到运行时才变成「设置页有一格、按钮却取不到默认文本」。创建类（newWayfinder 等）、交接类（tpl.handoff*）
 * 与初始化类（setupRun 等）不在名单里，是有意不给入口，不是漏了。
 */
export const PROMPT_OVERRIDE_IDS = [
  'mapInspect', 'mapExecute', 'complete', 'fixate', 'healthCheck',
  'specSplit', 'specExecute', 'specComplete',
  'tpl.implement', 'tpl.diagnose', 'tpl.fix', 'tpl.discuss', 'tpl.research', 'tpl.prototype', 'tpl.takeover', 'tpl.supplement', 'tpl.execute',
] as const satisfies ReadonlyArray<PromptTemplateId>

/** 词表占位符：提示词取用口对所有条目都会补 {cli} 与 {cliBrand}（后端没声明时落中性说法），所以任何条目都允许写它们。 */
const PROMPT_OVERRIDE_VOCABULARY_NAMES = ['cli', 'cliBrand']

// 队列里本节那几笔的记号：固定段名 + \u0000 + 提示词 id（工作区路径里不可能出现 \u0000，几族记号不会撞上）。
const settingsPromptOverridesJournalKeyOf = function (name: string): string { return '\u0000promptOverrides\u0000' + name }

// 文档里的 promptOverrides 节：形状对不上（更高版本插件写的文件、或不是一组「名字 → 值」）时回 null。
const settingsPromptOverridesSectionOf = function (doc: any): any {
  try {
    if (!doc || typeof doc !== 'object') return null
    const sec = doc.promptOverrides
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return null
    return sec
  } catch (e) { return null }
}

// 把一格改写写进内存文档的 promptOverrides 节：别的节与别的格一律不动；这一节缺失或形状不对就新建一份空的。
//   空串是合法值（表示这一格用默认文本），所以「恢复默认」也是走这里写一个空串，不是删键 ——
//   写前重读合并时，两个窗口里一个改字一个恢复默认，才有一个确定的「谁后写谁赢」。
export const settingsPromptOverridesSetInDoc = function (doc: any, name: any, value: any): any {
  try {
    if (!doc || typeof doc !== 'object') return false
    if (!doc.promptOverrides || typeof doc.promptOverrides !== 'object' || Array.isArray(doc.promptOverrides)) doc.promptOverrides = {}
    doc.promptOverrides[name] = value
    return true
  } catch (e) { return false }
}

// 一笔写不进内存文档时记一行：沿用既有的 storage.fail，不新开事件名（key 记固定记号，日志纪律不许把用户的提示词写进日志）。
const settingsPromptOverridesLogDocFail = function (): void {
  try { log('warn', 'storage.fail', { key: 'settings.promptOverrides', op: 'write' }) } catch (eL) {}
}

/** 文件里这一格存的原文（没写、不是文字、或 id 不在名单里都回空串）。设置页用它判断「这一格现在有没有改写」。 */
export const promptOverrideStoredOf = function (id: any): string {
  try {
    if ((PROMPT_OVERRIDE_IDS as ReadonlyArray<string>).indexOf(String(id)) < 0) return ''
    const sec = settingsPromptOverridesSectionOf(viewFlagState.doc)
    const v = sec ? sec[id] : undefined
    return typeof v === 'string' ? v : ''
  } catch (e) { return '' }
}

/** 插件自带的默认正文（未替换占位符；按当前语言链取一份）。设置页的输入框默认显示它，「恢复默认」就是回到它。 */
export const promptOverrideDefaultOf = function (id: any): string {
  try {
    const p = PROMPTS[id]
    if (!p) return ''
    return String(promptPickText(p, promptChainOf()) || '')
  } catch (e) { return '' }
}

// 一段文字里出现的占位符名，按首次出现的次序去重。正则与提示词取用口 promptText 替换用的是同一条（\{(\w+)\}），
//   所以这里认为「是占位符」的，正是取用口会去替换的。
const promptOverrideNamesIn = function (text: string): string[] {
  const out: string[] = []
  const re = /\{(\w+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) { if (out.indexOf(m[1]) < 0) out.push(m[1]) }
  return out
}

// 这一条提示词允许出现的占位符：登记条目声明的 ∪ 条目里每一种语言正文实际出现的 ∪ 词表占位符。
//   为什么把「正文里实际出现的」也算上：生成物里个别条目的 placeholders 声明比正文少（mapExecute 声明为空），
//   以默认正文为准才不会把默认文本自己用到的占位符判成「未知」。
const promptOverrideAllowedNames = function (p: any): string[] {
  const out: string[] = PROMPT_OVERRIDE_VOCABULARY_NAMES.slice()
  if (!p) return out
  const declared = Array.isArray(p.placeholders) ? p.placeholders : []
  for (let i = 0; i < declared.length; i++) { if (out.indexOf(declared[i]) < 0) out.push(declared[i]) }
  const keys = Object.keys(p)
  for (let i = 0; i < keys.length; i++) {
    if (typeof p[keys[i]] !== 'string') continue
    const names = promptOverrideNamesIn(p[keys[i]])
    for (let j = 0; j < names.length; j++) { if (out.indexOf(names[j]) < 0) out.push(names[j]) }
  }
  return out
}

/**
 * 给设置页的说明行用：这一条提示词能写哪些占位符（names，不含 {cli} {cliBrand} 那两个词表占位符，写不写都行，不值得
 * 占一行说明）、必须保留哪些（required，目前只有默认正文里本来就有 {url} 时才是 url）。
 */
export const promptOverrideHelpOf = function (id: any): { names: string[]; required: string[] } {
  try {
    const names = promptOverrideAllowedNames(PROMPTS[String(id)]).filter(function (n) { return PROMPT_OVERRIDE_VOCABULARY_NAMES.indexOf(n) < 0 })
    const required = promptOverrideNamesIn(promptOverrideDefaultOf(id)).filter(function (n) { return n === 'url' })
    return { names: names, required: required }
  } catch (e) { return { names: [], required: [] } }
}

/**
 * 校验一段改写文字（设置页保存前与读口取用前都走它）。
 * 返回 { ok, empty, unknown, missing }：empty 为真表示去掉首尾空白后什么都没有（按「用默认文本」处理，ok 也为真）；
 * unknown 是登记表之外的占位符名；missing 是该保留却丢了的占位符名（目前只有 url）。
 */
export function checkPromptOverrideText(entry: any, defaultText: string, text: unknown): { ok: boolean; empty: boolean; unknown: string[]; missing: string[] } {
  const value = String(text == null ? '' : text)
  if (value.trim() === '') return { ok: true, empty: true, unknown: [], missing: [] }
  const used = promptOverrideNamesIn(value)
  const allowed = promptOverrideAllowedNames(entry)
  const unknown = used.filter(function (n) { return allowed.indexOf(n) < 0 })
  const missing = promptOverrideNamesIn(defaultText).filter(function (n) { return n === 'url' && used.indexOf(n) < 0 })
  return { ok: unknown.length === 0 && missing.length === 0, empty: false, unknown: unknown, missing: missing }
}

export const promptOverrideCheck = function (id: any, text: any) {
  return checkPromptOverrideText(PROMPTS[String(id)], promptOverrideDefaultOf(id), text)
}

/**
 * 读口：这一条提示词现在有没有生效的改写。有就返回改写原文（占位符仍是 {url} 这样的原样，由取用口照常替换），
 * 没有（没写、空白、校验不过、文档还没到手、id 不在名单里）一律返回空串，取用口据此走默认文本。
 * 每次按钮点下去才会走到这里，是内存读，不碰宿主。
 */
export const promptOverrideOf = function (id: any): string {
  try {
    if ((PROMPT_OVERRIDE_IDS as ReadonlyArray<string>).indexOf(String(id)) < 0) return ''
    // 惰性加载：第一次有人读时才去问宿主要文档（问过之后这一句立刻返回，见 settingsViewLoad 第一行）。
    settingsViewLoad()
    const stored = promptOverrideStoredOf(id)
    if (stored.trim() === '') return ''
    return promptOverrideCheck(id, stored).ok ? stored : ''
  } catch (e) { return '' }
}

/**
 * 写口：保存一格改写，或（传空串）恢复这一格的默认文本。返回 { ok: true } 或 { ok: false, reason, unknown?, missing? }，
 * reason 是 unknown-id（名单里没有这个 id）、loading（文档还在路上，稍后重试）、invalid（有未知占位符或丢了 {url}）、readonly（文件是更高版本，不许写）、
 * unavailable（问不到宿主文档）、doc-fail（文档在手却写不进这一格）、error（过程中抛错）。
 * 与默认文本逐字相同的文字按「没有改写」存空串：这样插件以后升级了默认文本，没动过它的人会跟着用新的。
 */
export const setPromptOverride = function (id: any, text: any): any {
  try {
    if ((PROMPT_OVERRIDE_IDS as ReadonlyArray<string>).indexOf(String(id)) < 0) return { ok: false, reason: 'unknown-id' }
    const value = String(text == null ? '' : text)
    const check = promptOverrideCheck(id, value)
    if (!check.ok) return { ok: false, reason: 'invalid', unknown: check.unknown, missing: check.missing }
    const stored = (check.empty || value === promptOverrideDefaultOf(id)) ? '' : value
    settingsViewLoad()
    // 文档还在路上：不接这一笔（文件头第四条），调用方保留草稿、稍后重试。
    if (viewFlagState.status === 'loading') return { ok: false, reason: 'loading' }
    if (viewFlagState.status !== 'ready') return { ok: false, reason: viewFlagState.status === 'readonly' ? 'readonly' : 'unavailable' }
    if (!settingsPromptOverridesSetInDoc(viewFlagState.doc, id, stored)) { settingsPromptOverridesLogDocFail(); return { ok: false, reason: 'doc-fail' } }
    viewFlagState.journal[settingsPromptOverridesJournalKeyOf(id)] = { section: 'promptOverrides', name: id, value: stored }
    viewFlagScheduleWrite()
    return { ok: true }
  } catch (e) { return { ok: false, reason: 'error' } }
}
