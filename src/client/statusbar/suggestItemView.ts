// src/client/statusbar/suggestItemView.ts —— 「下一步建议」把工具交来的条目洗成界面能画的两段（#1411 / #109）
//
// 这一片只做两件与状态栏位置无关的账：
//   1. 洗条目：只留提示词非空的条目、条数截到上限；理由、优点、缺点不是字符串就当没有；
//      推荐分不是有效数字就当没打分。界面侧不假设数据一定合法（票面 #1411 ⑥）。
//   2. 拼浮层正文：悬停时框正上方那四行「推荐分 / 理由 / 优点 / 缺点」，缺哪一格跳过哪一行。
//
// 为什么从 suggestBubble.ts 搬出来：这两件与「锚点跟谁走、退场怎么演、点选走哪个注入口子」
// 不同步改动，混在一个文件里既让改动互不牵连的边界变糊，也让那份文件越过了 20 KB 的文件上限（#109）。
//
// 契约（与仓库其它叶子文件同一套，见 scripts/build.mts 里的叶子清单）：
//   模块真源是 ESM 导出，构建时剥掉行首 export 拼进 apply 闭包；运行时不许跨文件 import；
//   不许 export default；只写可剥离的 TypeScript（不用 enum、不用构造函数参数属性）。
//   入口 index.ts 的拼接标记必须排在 leaf:suggestPill 与 leaf:suggestBubble 之前：
//   选项框那一颗要调用这里导出的 popBodyOf，气泡薄壳要调用这里导出的 suggestViewItemsOf。

/** 一组建议最多显示多少颗按钮：与工具/取数层同一组上下限，界面这层只防越界，不重复校验内容。 */
export const SUGGEST_VIEW_MAX_ITEMS = 4

/**
 * 清洗 items：只留 prompt 是非空字符串的条目，条数截到上限；reason 不是字符串就当没有理由；
 * priority 不是有效数字就当没打分（null），排序与浮层都不认它。
 * 为什么要再洗一遍：取数层保证的是「工具参数校验过」，但界面侧不假设数据一定合法（票面⑥）。
 */
export const suggestViewItemsOf = function (items: any) {
  const out: any[] = []
  try {
    if (!Array.isArray(items)) return out
    for (let i = 0; i < items.length && out.length < SUGGEST_VIEW_MAX_ITEMS; i++) {
      const item = items[i]
      if (!item || typeof item !== 'object') continue
      const prompt = item.prompt
      if (typeof prompt !== 'string' || !prompt) continue
      const intro = (typeof item.intro === 'string') ? item.intro : ''
      const reason = (typeof item.reason === 'string') ? item.reason : ''
      const gain = (typeof item.gain === 'string') ? item.gain : ''
      const cost = (typeof item.cost === 'string') ? item.cost : ''
      const priority = (typeof item.priority === 'number' && Number.isFinite(item.priority)) ? item.priority : null
      out.push({ intro: intro, prompt: prompt, reason: reason, gain: gain, cost: cost, priority: priority })
    }
  } catch (eItems) {}
  return out
}

/** 浮层内容：四行固定顺序「推荐分 / 理由 / 优点 / 缺点」，每行左边一个灰色标签、右边正文；
 *  旧事件缺哪一格就跳过哪一行，不补空行。推荐分印数字不画进度条：模型给的是「谁更该先做」的
 *  相对判断，画条会让人以为它是可校准的刻度。 */
export const popBodyOf = function (item: any, index: number) {
  const priority = (item && typeof item.priority === 'number' && Number.isFinite(item.priority)) ? item.priority : null
  const rows: any[] = []
  function pushRow(key: string, labelKey: string, text: any) {
    if (typeof text !== 'string' || !text) return
    rows.push(React.createElement('div', { key: 'suggest-row-' + index + '-' + key, className: 'dsws-sugg-pop-row' },
      React.createElement('span', { className: 'dsws-sugg-pop-label' }, tr(labelKey)),
      React.createElement('span', { className: 'dsws-sugg-pop-value' }, text)))
  }
  pushRow('score', 'suggest.label.score', priority === null ? '' : String(priority))
  pushRow('reason', 'suggest.label.reason', item ? item.reason : '')
  pushRow('gain', 'suggest.label.gain', item ? item.gain : '')
  pushRow('cost', 'suggest.label.cost', item ? item.cost : '')
  return rows
}
