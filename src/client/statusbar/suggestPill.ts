// src/client/statusbar/suggestPill.ts —— 「下一步建议」里一颗选项的画法（#1411 / #109）
//
// 一颗选项 = 定位壳 + 真按钮 + 框正上方的浮层。壳管悬停进出：鼠标进入、键盘聚焦都露出浮层；
// 离开、失焦都收起，并把上一颗留下的位移清回零。浮层正文由 suggestItemView 的 popBodyOf 拼；
// 浮层超出视口时，位移写进两个 CSS 变量（横向 --dsws-sugg-pop-shift、纵向 --dsws-sugg-pop-shift-y，
// 算术在 suggestTimeline 的 suggestPopShiftOf），这一步 export 出去给薄壳的 measure 回调复用。
//
// 点选与回车/空格故意不在这里：那一下要注入提示词、让整组退场，属于会话与退场，留在 suggestBubble.ts；
// 本文件只回答「怎么画」与「悬停什么时候露出理由」，所以它不需要会话、也不需要知道退场怎么演。
//
// 契约（与仓库其它叶子文件同一套，见 scripts/build.mts 里的叶子清单）：
//   模块真源是 ESM 导出，构建时剥掉行首 export 拼进 apply 闭包；运行时不许跨文件 import；
//   不许 export default；只写可剥离的 TypeScript（不用 enum、不用构造函数参数属性）。
//   入口 index.ts 的拼接标记必须排在 leaf:suggestItemView 之后（浮层正文 popBodyOf 住那里）、
//   leaf:suggestBubble 之前（气泡薄壳要调用这里导出的 suggestPillNodeOf）。

declare const SUGGEST_APPEARANCE: any;
declare function suggestPopShiftOf(rect: any, viewWidth: any, viewHeight: any, margin: any): any;
// 相邻叶子（拼接标记排在 suggestPill 之前）：浮层四行的正文由它拼。
declare function popBodyOf(item: any, index: number): any;

/**
 * 把浮层推回视口内：只写两个 CSS 变量（横向 --dsws-sugg-pop-shift、纵向 --dsws-sugg-pop-shift-y），
 * 位移量由 suggestTimeline 的 suggestPopShiftOf 算（纯函数、可脱 DOM 验）。先清成 0 再量，上一颗
 * 留下的位移不能掺进这次测量。显示浮层前调一次（悬停进来时），锚点被窗口或侧栏挪动后再对打开着的
 * 浮层调一次（薄壳的 measure 回调，见 suggestBubble.ts；#1787 现象③的窄窗口分支）。
 * 它住在这里而不是薄壳：浮层是这一颗选项的一部分，夹取它属于「怎么画」，不属于「贴在哪」。
 */
export const suggestClampPopToViewport = function (pop: any) {
  try {
    if (!pop || !pop.style || typeof pop.style.setProperty !== 'function' || typeof pop.getBoundingClientRect !== 'function') return
    pop.style.setProperty('--dsws-sugg-pop-shift', '0px')
    pop.style.setProperty('--dsws-sugg-pop-shift-y', '0px')
    const rect = pop.getBoundingClientRect()
    if (!rect) return
    const margin = Number(SUGGEST_APPEARANCE && SUGGEST_APPEARANCE.popViewportMarginPx) || 0
    const viewWidth = (typeof window !== 'undefined' && Number(window.innerWidth)) || 0, viewHeight = (typeof window !== 'undefined' && Number(window.innerHeight)) || 0
    const shift = suggestPopShiftOf(rect, viewWidth, viewHeight, margin)
    if (shift && shift.x) pop.style.setProperty('--dsws-sugg-pop-shift', shift.x + 'px')
    if (shift && shift.y) pop.style.setProperty('--dsws-sugg-pop-shift-y', shift.y + 'px')
  } catch (eClampPop) {}
}

/**
 * 画一颗选项。spec 的字段：
 *   item / index      suggestItemView 洗过的一条建议与它在整组里的位置（浮层正文靠 index 拼 key）；
 *   groupKey          这一组的标识，拼进浮层 id，好让按钮的 aria-describedby 指到自己那颗浮层；
 *   pillCapPx         这一颗按钮的最大宽度（按当前条数均分整组宽度算出来，见 suggestBubble.ts）；
 *   onClick / onKeyDown  点选与键盘激活的真正行为（薄壳给：注入提示词加整组退场）。
 * 返回定位壳节点；没有理由、优点、缺点时壳里不放浮层，但 DOM 形状不变（壳照样在）。
 */
export const suggestPillNodeOf = function (spec: any) {
  const safe = (spec && typeof spec === 'object') ? spec : {}
  const item = (safe.item && typeof safe.item === 'object') ? safe.item : {}
  const index = Number(safe.index) || 0
  const groupKey = (safe.groupKey !== undefined && safe.groupKey !== null) ? String(safe.groupKey) : '0'
  const pillCapPx = Number(safe.pillCapPx) || 0
  const onClick = (typeof safe.onClick === 'function') ? safe.onClick : function () {}
  const onKeyDown = (typeof safe.onKeyDown === 'function') ? safe.onKeyDown : function () {}
  const intro = (typeof item.intro === 'string') ? item.intro : ''
  const prompt = item.prompt
  const reason = (typeof item.reason === 'string') ? item.reason : ''
  const gain = (typeof item.gain === 'string') ? item.gain : ''
  const cost = (typeof item.cost === 'string') ? item.cost : ''
  // 读屏念「简介 提示词」；理由、优点、缺点由 aria-describedby 指向浮层正文读出，不在按钮名里重复念。
  const spoken = intro ? intro + ' ' + prompt : prompt
  // 选项框上只印简介（#1451 后续拍板）：提示词不进按钮，点选时才原样填进输入框；
  // 没有简介的旧事件退回只印提示词。理由、优点、缺点收进框正上方的浮层（2026-10-31 改成四行），
  // 进出由这一层定位壳负责显隐。
  const label = intro
    ? React.createElement('span', { key: 'suggest-intro-' + index, className: 'dsws-sugg-intro' }, intro)
    : prompt
  const popId = 'suggest-pop-' + groupKey + '-' + index
  const hasPop = Boolean(reason || gain || cost)
  const button = React.createElement('button', {
    key: 'suggest-pill-' + index,
    type: 'button',
    className: 'dsws-sugg-pill',
    'data-press': 'button',
    'data-log': 'suggest.pill',
    style: { maxWidth: pillCapPx + 'px' },
    'aria-label': spoken,
    'aria-describedby': hasPop ? popId : undefined,
    onClick: function (ev: any) { onClick(ev, prompt) },
    onKeyDown: function (ev: any) { onKeyDown(ev, prompt) },
  }, label)
  // 没有理由也不裸奔：照样包进定位壳（只是里面不放浮层），有理由没理由 DOM 形状一致。
  // 显示浮层：#1787 现象③的窄窗口分支——先让浮层按原位置显示，再量一次矩形，把超出视口
  // 边距的部分写进两个位移变量推回来。算术在 suggestTimeline.suggestPopShiftOf，这里只搬 DOM。
  function showPop(ev: any) {
    const wrap = ev && ev.currentTarget
    try { if (wrap && wrap.classList) wrap.classList.add('dsws-sugg-show-pop') } catch (eShow) {}
    try {
      const pop = (wrap && typeof wrap.querySelector === 'function') ? wrap.querySelector('.dsws-sugg-pop') : null
      if (pop) suggestClampPopToViewport(pop)
    } catch (eShowShift) {}
  }
  function hidePop(ev: any) {
    const wrap = ev && ev.currentTarget
    try { if (wrap && wrap.classList) wrap.classList.remove('dsws-sugg-show-pop') } catch (eHide) {}
    try {
      const pop = (wrap && typeof wrap.querySelector === 'function') ? wrap.querySelector('.dsws-sugg-pop') : null
      if (pop && pop.style && typeof pop.style.setProperty === 'function') {
        pop.style.setProperty('--dsws-sugg-pop-shift', '0px')
        pop.style.setProperty('--dsws-sugg-pop-shift-y', '0px')
      }
    } catch (eHideShift) {}
  }
  return React.createElement('span', {
    key: 'suggest-wrap-' + index,
    className: 'dsws-sugg-pill-wrap',
    onMouseEnter: showPop,
    onMouseLeave: hidePop,
    onFocus: showPop,
    onBlur: hidePop,
  }, hasPop ? [button, React.createElement('div', {
    key: 'suggest-pop-' + index,
    id: popId,
    className: 'dsws-sugg-pop',
    role: 'tooltip',
  }, popBodyOf(item, index))] : button)
}
