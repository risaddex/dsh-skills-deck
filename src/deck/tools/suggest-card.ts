// src/deck/tools/suggest-card.ts —— 「下一步建议」那张卡片的说明数据，以及它在 dsh-go 里的原生视图（#97）
//
// 为什么把卡片做成一份说明数据、而不是界面里的 JSX：维护者在 #97 定下的口径是「卡片必须作为
// 协议数据携带」—— 主行、次行、每颗按钮的标签与提示词都是一份纯数据，谁能读就按同一份画。
// 于是同一个东西有两个读者：
//   1. 插件自己的网页界面（src/client/statusbar/suggestBubble.ts）按这份形状画一张可点的卡片；
//   2. dsh-go / DSH Remote 按这份形状画同一张卡片 —— 它读的是工具定义的
//      output.presentationMeta 里那一格 `dsh-go/view`（视图随对话记录走，不过任何新路由）。
//
// 为什么文本也是入参、不作常量写死：卡片上那两行字属于渲染方（网页界面按界面语言取词），
// 说明数据只保证形状一致。宿主要对 dsh-go 说英语，就把英语两行递进来；网页界面递它自己的
// tr() 取到的词。形状一致、文字各自负责，两边才都不必为了对方的语言将就。
//
// 为什么 dsh-go 那一侧画成 list 的行、而不是按钮：dsh-go 第 0 期（docs/plugins/actions.md）明写
// 工具卡里按钮与确认根本不画。所以这里用 list 的行承载每个选项，不用 actions 伪造成能点的样子。
// #102：维护者的分支 risaddex/dsh-Go 让工具卡里带 `insert: "<文字>"` 的行可以点 —— 点一下就把
// 这段文字放进输入框、不发送（与 App 已有的 insert 效果同一条路，没有新路由、新审批）。所以每一行
// 再带上这个选项的提示词；不认这个字段的 App（上游 dsh-go、旧版本）把它当未知字段忽略，照旧画只读的行。
//
// 契约（与仓库其它模块同一套）：本文件是普通 ESM 模块，由宿主编译单元装载；界面那半边不 import
// 它（界面是拼接出来的闭包片段），两边的形状由 tests/verify-97-suggest-card.ts 对着同一组夹具钉住。

import { MAX_ITEMS } from './suggest-next-steps.js'

/** 外层递进来的东西形状不由本文件定，逐格验，不猜。 */
type UnknownRecord = Record<string, unknown>

/** 卡片上那两行字：由渲染方按自己的语言与口径给。 */
export interface SuggestCardTexts {
  title: string
  subtitle: string
}

/** 卡片上的一颗按钮：标签（选项框与按钮上印的字）与点下去要填进输入框的提示词，外加三格理由与推荐分。 */
export interface SuggestCardOption {
  label: string
  prompt: string
  reason: string
  gain: string
  cost: string
  priority: number
}

/** 一份卡片说明：主行、次行、按推荐分从高到低排好的按钮。 */
export interface SuggestCard {
  title: string
  subtitle: string
  options: SuggestCardOption[]
}

/** dsh-go 认的那一格元数据键：工具定义里 presentationMeta 返回它，App 就把值画成原生卡片。 */
export const TOOL_CARD_VIEW_KEY = 'dsh-go/view'
/** dsh-go 对工具卡的总字节上限（超出它 App 会画一行「插件界面有误」，所以这里先自己挡）。 */
export const TOOL_CARD_MAX_BYTES = 8 * 1024
/**
 * 工具卡一行 `insert` 的字符上限（#102）：与 App 的 insert 效果同一个数（dsh-go 的 UiSchema.sendTextMax）。
 * 按 JS 字符串的 length 数，与 App 那边 Dart 的 String.length 同一把尺（都是 UTF-16 单元）。
 * 超过的 App 不截断、整个丢掉并在卡上记一条「插件界面有误」，所以这里干脆不写，那一行照旧只读。
 */
export const TOOL_CARD_INSERT_MAX_CHARS = 2000

/** 宿主对 dsh-go 说的英语两行字：数出几条选项，主行带上条数，次行说清每一行给的是什么。 */
export function suggestCardTextsOf(count: number): SuggestCardTexts {
  const n = (typeof count === 'number' && Number.isFinite(count) && count > 0) ? Math.floor(count) : 0
  return {
    title: n > 0 ? 'Next steps · ' + n : 'Next steps',
    subtitle: 'Each option states its reason, gain and cost.',
  }
}

/**
 * 把一条建议收成一张卡片上的一颗按钮：只要 prompt 是非空字符串，其余各格按字符串收，缺的当没有。
 * 推荐分不是有限数字就不带分（0 是「最后再做」，与「没打分」不是一回事，所以不拿 0 顶替）。
 */
export function suggestCardOptionOf(raw: unknown): SuggestCardOption | null {
  const item = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as UnknownRecord : null
  if (!item) return null
  const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
  if (!prompt) return null
  const text = function (key: string): string {
    const value = item[key]
    return typeof value === 'string' ? value : ''
  }
  const label = text('intro') || prompt
  const priority = (typeof item.priority === 'number' && Number.isFinite(item.priority)) ? item.priority : 0
  return { label: label, prompt: prompt, reason: text('reason'), gain: text('gain'), cost: text('cost'), priority: priority }
}

/**
 * 把工具收到的 items 收成一份卡片说明：顺序照原样（工具那边已经按推荐分排好、截到上限），
 * 条数再按同一组上下限兜一次底 —— 界面那一层也照同一组数再兜一次，谁都不假设对方合法。
 */
export function suggestCardOf(items: unknown, texts: SuggestCardTexts): SuggestCard {
  const list = Array.isArray(items) ? items : []
  const options: SuggestCardOption[] = []
  for (let i = 0; i < list.length && options.length < MAX_ITEMS; i++) {
    const option = suggestCardOptionOf(list[i])
    if (option) options.push(option)
  }
  const title = (texts && typeof texts.title === 'string') ? texts.title : ''
  const subtitle = (texts && typeof texts.subtitle === 'string') ? texts.subtitle : ''
  return { title: title, subtitle: subtitle, options: options }
}

/** 一颗按钮的三格理由收成一行：有哪格写哪格，用间隔点连起来，空格不补。 */
export function suggestCardDetailOf(option: SuggestCardOption): string {
  const parts: string[] = []
  if (option && option.reason) parts.push(option.reason)
  if (option && option.gain) parts.push(option.gain)
  if (option && option.cost) parts.push(option.cost)
  return parts.join(' · ')
}

/**
 * 把一份卡片说明画成 dsh-go 的原生视图。
 *
 * 为什么是 stack + text + list：工具卡的折叠摘要取根节点的 title，所以主行放 title；
 * 次行用一行灰字；每颗按钮用 list 的一行（标签在上、三格理由在下、推荐分在行尾）。
 * 不用 actions：工具卡里按钮根本不画，写了只会让人以为能点。
 * 选项超过 list 的行数上限（50）不会发生（上限只有 4 条），这里不再截。
 *
 * #102：每一行再带 `insert`，值就是这个选项的提示词，原样写、不截断 —— 认它的 App 点这一行
 * 就把提示词放进输入框（不发送）。提示词超过 TOOL_CARD_INSERT_MAX_CHARS 的那一行不写 insert：
 * 截断的提示词比没有更糟，而写进去 App 也只会丢掉它并在卡上记一条错。
 * 整张卡放不放得进 8 KiB 不在这里管，由 suggestPresentationMetaOf 量过之后再摘。
 */
export function suggestCardViewOf(card: SuggestCard): UnknownRecord {
  const options = (card && Array.isArray(card.options)) ? card.options : []
  const rows = options.map(function (option) {
    const row: UnknownRecord = { title: option.label }
    const detail = suggestCardDetailOf(option)
    if (detail) row.subtitle = detail
    if (typeof option.priority === 'number' && Number.isFinite(option.priority)) row.trailing = String(option.priority)
    if (option.prompt && option.prompt.length <= TOOL_CARD_INSERT_MAX_CHARS) row.insert = option.prompt
    return row
  })
  const children: UnknownRecord[] = []
  if (card && card.subtitle) children.push({ type: 'text', text: card.subtitle, tone: 'muted' })
  if (rows.length) children.push({ type: 'list', items: rows })
  return { type: 'stack', title: (card && card.title) || '', children: children }
}

/**
 * UTF-8 字节数：宿主这份编译配置里没有 Node 的 Buffer（也不引 DOM 的 TextEncoder 类型），
 * 所以自己数一遍。口径与 Buffer.byteLength 一致：ASCII 一字节、常用双字节字符两字节、
 * 汉字等三字节、代理对（emoji）四字节。数大一点最多是「本来放得下却不出卡片」，不会反过来。
 */
export function utf8BytesOf(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1 }
    else bytes += 3
  }
  return bytes
}

/**
 * 工具定义里 output.presentationMeta 的实现：从这次调用的返回值里取回 items，收成卡片，画成 dsh-go 视图。
 *
 * 三条硬约束（dsh-go 的 quickstart 写明，违反会让整次工具调用失败）：
 *   1. presentationMeta 抛错 = 工具调用失败 —— 所以整段包在 try 里，出错就回 {}（不出卡片）；
 *   2. 返回值必须是无损 JSON（不能有 undefined / NaN / Infinity）—— 所以过一遍 JSON；
 *   3. 视图超过 8 KiB 也不出卡片 —— 先量字节，超了就回 {}。
 * 数据来源优先用返回值里的 data.items（工具已排好序、截到上限的那一份），取不到再退回参数里的
 * items（调用方自己给的那一份），两者都没有就回 {}，不凭空造建议。
 *
 * #102：每行的 insert 带着整段提示词（一段最多 2000 字），四段长提示词加起来能把卡片撑过 8 KiB。
 * 超了先摘 insert，不先丢卡片：从字节最多的那一行起一行一行摘，摘到放得下为止 —— 摘掉的那一行
 * 只是变回只读，其余的行照样能点；insert 全摘了还放不下，才回 {}（与 #97 的老规矩一样）。
 * 为什么不截短提示词来凑：截过的提示词填进输入框是另一句话，比点不了更糟。
 */
export function suggestPresentationMetaOf(value: unknown, texts?: SuggestCardTexts | null): UnknownRecord {
  try {
    const bag = (value && typeof value === 'object') ? value as UnknownRecord : {}
    const data = (bag.data && typeof bag.data === 'object') ? bag.data as UnknownRecord : {}
    const items = Array.isArray(data.items) ? data.items : bag.items
    if (!Array.isArray(items) || !items.length) return {}
    // 调用方没给两行字就用宿主自己的英语一份，条数按实际收下来的选项算（洗过的条数，不是收到的条数）。
    const given = (texts && typeof texts === 'object') ? texts : suggestCardTextsOf(items.length)
    const card = suggestCardOf(items, given)
    if (!card.options.length) return {}
    const view = suggestCardViewOf(card)
    const measure = function (): string { return JSON.stringify({ [TOOL_CARD_VIEW_KEY]: view }) }
    let text = measure()
    if (typeof text !== 'string') return {}
    if (utf8BytesOf(text) > TOOL_CARD_MAX_BYTES) {
      const children = Array.isArray(view.children) ? view.children as UnknownRecord[] : []
      const list = children.find(function (child) { return child.type === 'list' })
      const rows = (list && Array.isArray(list.items)) ? list.items as UnknownRecord[] : []
      const heaviest = rows
        .filter(function (row) { return typeof row.insert === 'string' })
        .sort(function (a, b) { return utf8BytesOf(b.insert as string) - utf8BytesOf(a.insert as string) })
      for (let i = 0; i < heaviest.length && utf8BytesOf(text) > TOOL_CARD_MAX_BYTES; i += 1) {
        delete heaviest[i].insert
        text = measure()
      }
      if (utf8BytesOf(text) > TOOL_CARD_MAX_BYTES) return {}
    }
    return JSON.parse(text) as UnknownRecord
  } catch (eMeta) {
    return {}
  }
}
