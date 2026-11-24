// tests/verify-97-suggest-card.ts —— 门禁：建议卡片作为协议数据、以及它在 dsh-go 里的原生视图（#97）
// 用法：在插件根目录执行 node --import ./scripts/ts-hook.mts tests/verify-97-suggest-card.ts，可独立运行。
//
// 为什么要有这一扇：#97 把「建议」从一团只活在网页界面里的样式，变成一份说明数据——主行、次行、
// 每颗按钮的标签与提示词。这份数据有两个读者：插件自己的网页界面，和 dsh-go（它读工具定义里
// output.presentationMeta 的 `dsh-go/view`）。三条边界最容易在后续改动里被顺手破坏：
//   ① 形状：卡片的字段就那几格，网页界面与 dsh-go 认的是同一份；
//   ② 失败代价：dsh-go 的 quickstart 写明 presentationMeta 抛错、返回值不是无损 JSON、视图超过
//      8 KiB，都会让整次工具调用失败——所以这里钉住它是纯函数、永不抛、只产无损 JSON；
//   ③ 工具卡第 0 期不能点：这里不许出现 actions / confirm 这类「看着能点、其实点不动」的组件。
// 另外钉住登记接线（output.presentationMeta 真的挂上去了）与「没有新增参数」——本票只有数据，没有新功能。
// #97 复审（第二轮）：这是**只给 dsh-go 用的数据**。桌面那一侧的外观一个字都不改（浮动的建议药丸照旧），
// 所以这一扇不再断言面板动作条的形状 —— 那一块被还原了。

const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { printGateResult } = require('./lib/gate-result.ts')

const ROOT = path.resolve(__dirname, '..')
let total = 0
let failed = 0
function check(ok, message) {
  total += 1
  if (ok) console.log('  PASS ' + message)
  else { failed += 1; console.log('  FAIL ' + message) }
}
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 一条形状完整的建议：六格齐、分最高排最前。 */
const FULL = { intro: '先做这张', prompt: '/implement 97', reason: '它还开着', gain: '能马上收尾', cost: '要半小时', priority: 9.5 }
/** 第二条：简介留空（旧事件没有简介时按钮要退回印提示词）、理由不是一个字符串。 */
const LEGACY = { prompt: '继续收尾', reason: 123, gain: '改动小', cost: '', priority: 3 }
/** dsh-go 工具卡的上限（docs/plugins/components.md：字节 8 KiB、40 个组件、6 层、每个容器 16 个子组件）。 */
const TOOL_CARD_MAX_NODES = 40
const TOOL_CARD_MAX_DEPTH = 6
const TOOL_CARD_MAX_CHILDREN = 16

/** 数一棵视图树的组件个数（字符串、数字不算节点；title/items/children 里的组件都算）。 */
function countNodes(node) {
  let n = 0
  const walk = function (value) {
    if (!value) return
    if (Array.isArray(value)) { for (const one of value) walk(one); return }
    if (typeof value !== 'object') return
    if (typeof value.type === 'string') n += 1
    for (const key of Object.keys(value)) {
      if (key === 'type' || key === 'title') continue
      walk(value[key])
    }
  }
  walk(node)
  return n
}

/** 数一棵视图树的层数（根算 1 层）。 */
function depthOf(node) {
  if (!node || typeof node !== 'object') return 0
  let deepest = 1
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'title') continue
    const value = node[key]
    const list = Array.isArray(value) ? value : [value]
    for (const one of list) {
      if (one && typeof one === 'object' && typeof one.type === 'string') {
        const childDepth = depthOf(one) + 1
        if (childDepth > deepest) deepest = childDepth
      } else if (one && typeof one === 'object') {
        const nested = depthOf(one) + 0
        if (nested > deepest) deepest = nested
      }
    }
  }
  return deepest
}

async function main() {
  const cardMod = await imp('src/deck/tools/suggest-card.ts')
  const registerMod = await imp('src/deck/registration/suggest-steps-register.ts')
  const toolMod = await imp('src/deck/tools/suggest-next-steps.ts')

  // ---------- 1. 协议常量：dsh-go 认的键与它的上限 ----------
  check(cardMod.TOOL_CARD_VIEW_KEY === 'dsh-go/view', '常量：元数据键就是 dsh-go 认的 dsh-go/view')
  check(cardMod.TOOL_CARD_MAX_BYTES === 8192, '常量：工具卡字节上限 8 KiB 与 dsh-go 一致')

  // ---------- 2. 说明数据：只有那几格，缺的当没有，超限按上限截 ----------
  const texts = { title: '下一步建议 · 2', subtitle: '选一条填进输入框' }
  const card = cardMod.suggestCardOf([FULL, LEGACY], texts)
  check(card.title === texts.title && card.subtitle === texts.subtitle, '说明数据：主行与次行照调用方给的字，不改写成别的口径')
  check(card.options.length === 2, '说明数据：两条建议收成两颗按钮')
  check(card.options[0].label === '先做这张' && card.options[0].prompt === '/implement 97', '说明数据：第一颗带简介、提示词与推荐分')
  check(card.options[0].reason === '它还开着' && card.options[0].gain === '能马上收尾' && card.options[0].cost === '要半小时', '说明数据：理由、优点、缺点的三格原样保留')
  check(card.options[1].label === '继续收尾', '说明数据：没有简介时按钮退回印提示词（旧事件也要能画）')
  check(card.options[1].reason === '' && card.options[1].cost === '', '说明数据：理由不是字符串就当没有，不硬转成 "123"')
  const tooMany = cardMod.suggestCardOf([FULL, LEGACY, FULL, LEGACY, FULL, LEGACY], texts)
  check(tooMany.options.length === toolMod.MAX_ITEMS, '说明数据：超过上限按工具同一组上限截到 4 条')
  const noPrompt = cardMod.suggestCardOf([{ intro: '只有简介' }, FULL], texts)
  check(noPrompt.options.length === 1 && noPrompt.options[0].prompt === '/implement 97', '说明数据：没有提示词的条目不进卡片（点了也没东西可填）')
  check(cardMod.suggestCardOf('not-an-array', texts).options.length === 0, '说明数据：items 不是数组时给一份空卡片，不抛')
  check(cardMod.suggestCardDetailOf(card.options[0]) === '它还开着 · 能马上收尾 · 要半小时', '说明数据：三格理由收成一行，有哪格写哪格')
  check(cardMod.suggestCardDetailOf({ reason: '', gain: '', cost: '' }) === '', '说明数据：三格都空时收成空串，不补占位文字')

  // ---------- 3. dsh-go 视图：主行当折叠摘要，每个选项一行，第 0 期不放按钮 ----------
  const view = cardMod.suggestCardViewOf(card)
  check(view.type === 'stack' && view.title === texts.title, '视图：根是 stack，title 就是折叠时工具行的那行摘要')
  const kids = Array.isArray(view.children) ? view.children : []
  check(kids.length === 2 && kids[0].type === 'text' && kids[0].text === texts.subtitle, '视图：次行是一行灰字')
  check(kids[0].tone === 'muted', '视图：次行用 muted 色调（主行与它分主次）')
  check(kids[1].type === 'list' && kids[1].items.length === 2, '视图：每颗按钮是 list 的一行，不是按钮')
  check(kids[1].items[0].title === '先做这张' && kids[1].items[0].subtitle === '它还开着 · 能马上收尾 · 要半小时', '视图：第一行印标签与三格理由')
  check(kids[1].items[0].trailing === '9.5', '视图：推荐分放行尾（数字按原值印）')
  check(kids[1].items[1].subtitle === '改动小', '视图：缺格的行只印有的一格，不补空行')
  const viewText = JSON.stringify(view)
  check(viewText.indexOf('"actions"') < 0 && viewText.indexOf('"confirm"') < 0 && viewText.indexOf('"options"') < 0, '视图：不出现 actions/confirm/options —— 工具卡第 0 期不能点，不许画成能点的样子')
  check(countNodes(view) <= TOOL_CARD_MAX_NODES, '视图：组件数在上限内（' + countNodes(view) + ' ≤ ' + TOOL_CARD_MAX_NODES + '）')
  check(depthOf(view) <= TOOL_CARD_MAX_DEPTH, '视图：层数在上限内（' + depthOf(view) + ' ≤ ' + TOOL_CARD_MAX_DEPTH + '）')
  const biggest = cardMod.suggestCardViewOf(cardMod.suggestCardOf([
    Object.assign({}, FULL, { intro: '一'.repeat(30) }),
    Object.assign({}, FULL, { intro: '二'.repeat(30) }),
    Object.assign({}, FULL, { intro: '三'.repeat(30) }),
    Object.assign({}, FULL, { intro: '四'.repeat(30) }),
  ], texts))
  check(JSON.stringify(biggest).length < cardMod.TOOL_CARD_MAX_BYTES, '视图：四条满字（汉字）的卡片也远在 8 KiB 之内')

  // ---------- 4. presentationMeta：纯函数、永不抛、只产无损 JSON ----------
  const envelope = { ok: true, status: 'ok', text: 'Recorded 2 next steps.', data: { items: [FULL, LEGACY], counts: { received: 2, returned: 2, clipped: 0 } } }
  const meta = cardMod.suggestPresentationMetaOf(envelope)
  check(Object.keys(meta).length === 1 && meta['dsh-go/view'] !== undefined, '元数据：返回值就是 { "dsh-go/view": 视图 } 这一格')
  check(meta['dsh-go/view'].title === 'Next steps · 2', '元数据：宿主自己给的两行英语字带上条数（网页界面各用各的语言）')
  const again = cardMod.suggestPresentationMetaOf(envelope)
  check(JSON.stringify(again) === JSON.stringify(meta), '元数据：同一份输入两次算出同一张卡（纯函数，宿主可重放）')
  check(JSON.stringify(JSON.parse(JSON.stringify(meta))) === JSON.stringify(meta), '元数据：返回值是无损 JSON（过一遍 JSON 不变形）')
  let lossless = true
  const walkLossless = function (value) {
    if (value === undefined) { lossless = false; return }
    if (typeof value === 'number' && !Number.isFinite(value)) lossless = false
    if (value && typeof value === 'object') for (const key of Object.keys(value)) walkLossless(value[key])
  }
  walkLossless(meta)
  check(lossless, '元数据：树里没有 undefined / NaN / Infinity（有的话整次工具调用会失败）')
  const fromArgsOnly = cardMod.suggestPresentationMetaOf({ items: [FULL] })
  check(fromArgsOnly['dsh-go/view'] !== undefined, '元数据：返回值里没有 data.items 时退回参数里的那一份')
  const preferred = cardMod.suggestPresentationMetaOf({ data: { items: [FULL] }, items: [FULL, LEGACY, FULL] })
  check(preferred['dsh-go/view'].children[1].items.length === 1, '元数据：两处都有时以返回值里那份（已排序、已截断）为准')
  check(JSON.stringify(cardMod.suggestPresentationMetaOf({})) === '{}', '元数据：没有建议就回 {}（不出卡片，绝不编）')
  check(JSON.stringify(cardMod.suggestPresentationMetaOf({ data: { items: 'nope' } })) === '{}', '元数据：items 不是数组就回 {}')
  check(JSON.stringify(cardMod.suggestPresentationMetaOf({ data: { items: [{}, { prompt: '' }] } })) === '{}', '元数据：一个能用的选项都没有就回 {}')
  check(JSON.stringify(cardMod.suggestPresentationMetaOf(null)) === '{}', '元数据：null 也回 {}')
  check(JSON.stringify(cardMod.suggestPresentationMetaOf('boom')) === '{}', '元数据：字符串也回 {}')
  let threw = false
  try {
    // 读 data 就抛的对象：真实世界里宿主快照也可能坏掉，这里要求它只回 {}。
    const hostile = Object.defineProperty({}, 'data', { get: function () { throw new Error('boom') }, enumerable: true })
    cardMod.suggestPresentationMetaOf(hostile)
  } catch (e) { threw = true }
  check(!threw, '元数据：属性读取抛错也被兜住（presentationMeta 抛错 = 整次工具调用失败）')

  // ---------- 5. 接线：登记里真的挂上了 output.presentationMeta，且没有新增参数 ----------
  const registration = registerMod.makeSuggestRegistration({ log: null })
  const output = registration.output
  check(typeof output.presentationMeta === 'function', '接线：注册数据的 output 上有 presentationMeta')
  check(typeof output.render === 'function' && output.schema && typeof output.schema === 'object', '接线：原来的输出模式与 render 一字不变地留着')
  const wired = output.presentationMeta({ items: [FULL, LEGACY] }, envelope)
  check(wired && wired['dsh-go/view'] && wired['dsh-go/view'].title.indexOf('Next steps') === 0, '接线：走注册那条路也画得出同一张卡')
  check(typeof registration.execute === 'function' && registration.name === 'suggest_next_steps', '接线：执行函数与工具名没变')
  const params = registration.parameters && registration.parameters.properties
  check(params && Object.keys(params).length === 1 && params.items && params.items.type === 'array', '接线：参数表还是只有 items 一项（本票不加新参数、不加新设置）')

  // ---------- 6. 源码守卫：宿主这一侧不 import 界面那一侧 ----------
  const cardSrc = fs.readFileSync(path.join(ROOT, 'src/deck/tools/suggest-card.ts'), 'utf8')
  check(!/from\s+'[^']*\/client\//.test(cardSrc) && !/import\(\s*['"][^'"]*\/client\//.test(cardSrc), '守卫：宿主模块不 import 界面那一侧（两边只共享形状，不共享代码）')
  check(cardSrc.indexOf('import ') >= 0 && cardSrc.indexOf("from './suggest-next-steps.js'") >= 0, '守卫：只从建议工具取上限，不再抄第二份数字')
  const registerSrc = fs.readFileSync(path.join(ROOT, 'src/deck/registration/suggest-steps-register.ts'), 'utf8')
  check(registerSrc.indexOf('presentationMeta') >= 0 && registerSrc.indexOf('suggestPresentationMetaOf') >= 0, '守卫：登记处把卡片挂进 output（改回不带卡片会被这行挡住）')

  console.log('\n' + total + ' 条断言，' + (failed ? '失败' : '通过'))
  printGateResult('verify-97-suggest-card', total, failed ? 1 : 0)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('门禁抛错：' + ((e && e.stack) || e)); process.exit(1) })
