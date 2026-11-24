// src/client/statusbar/suggestBubble.ts —— 「下一步建议」卡片的渲染与交互薄壳（#1411；#97 改成一张卡片）
//
// 职责：把取数层（#1409 的 suggestStream）交来的 items = {intro, prompt, reason, gain, cost, priority}[]
// 画成一张卡片，挂在输入框上方的停靠栏里（conversation.input.dock，状态胶囊那一列的上面）。
//
// #97 之前它是一排浮在状态胶囊上方的药丸（挂页面浮层、position:fixed、跟着胶囊矩形走）。改成卡片
// 的原因是维护者要「把 git-manager 那张审批卡的界面搬到建议上来」：卡片有主行、次行，再一列按钮。
// 卡片占正常文档流，于是跟着一起消失的还有：页面浮层、锚点测量与逐帧轮询（#1787 现象④）、浮层
// 夹在视口内的两条位移变量 —— 浮层之所以要夹，是因为它盖在别的东西上；卡片里的详情区是卡片自己的
// 一块地方，撑开卡片往下长，不会溢出任何别人的边界。
//
// 卡片上的东西，从上到下四块：
//   1. 主行（.dsws-sugg-head）：这是什么，右边带条数；
//   2. 次行（.dsws-sugg-sub）：怎么用 —— 选一条填进输入框，关掉就都不选；
//   3. 选项行（.dsws-sugg-row）：一条建议一颗按钮，按钮上只印简介（#1451 后续：原来印「简介 + 提示词」
//      两段，用户要求只留简介）；完整提示词不进按钮，点一下才交给既有的「填进输入框」口子（kernel 的
//      inject，自带补尾换行、注入提示与光标落末尾），随后整组退场；
//   4. 详情区（.dsws-sugg-pop）：当前这一颗的四行「推荐分 / 理由 / 优点 / 缺点」。默认显示第一条
//      （推荐分最高那条），鼠标进入或键盘聚焦另一颗就换成那一颗 —— 默认就看得见，不用先悬停才知道有理由。
//      底下是关闭行（.dsws-sugg-xrow）：点它整组消失，等于一条都不选。
//
// 一行排满：每颗按钮的最大宽度按当前条数均分整组宽度（见下面 pillCapPx），条数越多每颗越窄，
// 三条、四条都排得进一行；只有窄到每颗连一个字都放不下时，才靠选项行的 flex-wrap 换行。
//
// 硬约束（票面 #1411 沿用）：
//   - 只读借用：界面绝不碰会话服务里那几个保活接口（#1409 已设守卫，本文件连 sessions 都不提）；
//   - 不新增常驻定时器：卡片不再需要锚点轮询，本文件一条常驻循环都没有；
//   - 数据防御：缺字段、空数组、条数越界都不许崩，也不假设 item 形状合法；
//   - 不新增日志事件：#1409 已有 suggest.bind/call/ready，本票只挂既有交互标识（data-log / data-press）。
//
// 契约（与仓库其它叶子文件同一套，见 scripts/build.mts 里的叶子清单）：
//   模块真源是 ESM 导出，构建时剥掉行首 export 拼进 apply 闭包；运行时不许跨文件 import；
//   不许 export default；只写可剥离的 TypeScript（不用 enum、不用构造函数参数属性）。
declare function inject(...args: any[]): any;
declare const SUGGEST_Z: any;
declare const SUGGEST_APPEARANCE: any;
declare const MOTION: any;
declare function createSuggestEngine(...args: any[]): any;

/** 一组建议最多显示多少颗按钮：与工具/取数层同一组上下限，界面这层只防越界，不重复校验内容。 */
const SUGGEST_VIEW_MAX_ITEMS = 4

/**
 * 清洗 items：只留 prompt 是非空字符串的条目，条数截到上限；reason 不是字符串就当没有理由；
 * priority 不是有效数字就当没打分（null），排序与详情区都不认它。
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
  } catch (eItems) { return [] }
  return out
}

/** 一条建议有没有详情可看：理由、优点、缺点里只要有一格是字符串就行（推荐分单独不算）。 */
export const suggestHasDetailOf = function (item: any) {
  if (!item || typeof item !== 'object') return false
  return Boolean(item.reason || item.gain || item.cost)
}

/** 详情内容：四行固定顺序「推荐分 / 理由 / 优点 / 缺点」，每行左边一个灰色标签、右边正文；
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

/**
 * 挂载组件：props = { st, sid, group, onDismiss }。group = { id, items }，id 变更即换一组
 * （第二组覆盖第一组）。sid 只用于调试定位，本组件不读会话。
 */
export const SuggestBubble = function (props: any) {
  const safeProps = (props && typeof props === 'object') ? props : {}
  const group = safeProps.group
  const st = safeProps.st
  const onDismiss = (typeof safeProps.onDismiss === 'function') ? safeProps.onDismiss : null
  const items = suggestViewItemsOf(group && group.items)
  const groupKey = (group && group.id !== undefined && group.id !== null) ? String(group.id) : '0'
  const layerRef = React.useRef(null)
  const engineRef = React.useRef(null)
  // 已经进入退场：点选与关闭只认第一次，免得退出途中再点一下重复注入、重复关整组。
  const leavingRef = React.useRef(false)
  // 详情区当前显示哪一条：默认第一条（推荐分最高那条）。为什么不默认留空：留空的话，想知道某条
  // 为什么该先做得先悬停，而卡片本来就是要把理由摊开给人看的（#97 的卡片形状来自 git-manager 的审批卡）。
  const activeState = React.useState(0)
  const rawActive = Number(activeState[0]) || 0
  const active = (rawActive >= 0 && rawActive < items.length) ? rawActive : 0
  const setActive = activeState[1]

  // 一次一行排满的宽度预算：整组最大宽度减去按钮之间的间隙，再按当前条数均分；每颗不超过单颗
  // 上限。为什么这么算：三条各取 360 像素时一行要 720 多，只能一颗一行，正好是 #1451 报的
  // 「三个选项竖着排」；均分后三条各约 236 像素，一条就排得下。四条时每颗约 175 像素，仍在
  // 可读范围里；真窄到放不下时才换行。
  const pillGapPx = Number(SUGGEST_APPEARANCE && SUGGEST_APPEARANCE.pillGapPx) || 0
  const groupMaxWidthPx = Number(SUGGEST_APPEARANCE && SUGGEST_APPEARANCE.maxWidthPx) || 0
  const singleMaxWidthPx = Number(SUGGEST_APPEARANCE && SUGGEST_APPEARANCE.pillMaxWidthPx) || 0
  const cardPadX = (Number(SUGGEST_APPEARANCE && SUGGEST_APPEARANCE.cardPadX) || 0) * 2
  const innerMaxWidthPx = Math.max(0, groupMaxWidthPx - cardPadX)
  const evenSharePx = items.length ? Math.floor((innerMaxWidthPx - pillGapPx * (items.length - 1)) / items.length) : 0
  const pillCapPx = (evenSharePx > 0 ? Math.min(singleMaxWidthPx, evenSharePx) : singleMaxWidthPx) || singleMaxWidthPx

  // 动效：卡片挂上以后建一次执行器（量布局、生成小泡、逐帧抬高透明度）；
  // 换了组或卸载时把它关掉。jsdom 里量不到布局，run 直接返回 false，整组按最终态显示。
  React.useEffect(function () {
    if (!items.length) return undefined
    let engine: any = null
    try {
      const layerEl = layerRef.current
      if (layerEl) {
        engine = createSuggestEngine(layerEl)
        try { engine.run() } catch (eRun) {}
        engineRef.current = engine
      }
    } catch (eEngine) { engine = null }
    return function () {
      if (engineRef.current === engine) engineRef.current = null
      if (engine) { try { engine.dispose() } catch (eDispose) {} }
    }
  }, [groupKey])

  /** 关掉整组：一条不选也走这里。 */
  function dismiss() {
    if (!onDismiss) return
    try { onDismiss() } catch (eDismiss) {}
  }
  /**
   * 退场：能演就交给动效执行器，演不了立刻整组消失。
   * kind 是 'pick'（选中一条：胶囊化作小泡上飘，整体约半秒）或 'fade'（关闭整组：约 170 毫秒淡出）。
   * 只认第一次调用，重复点击不会重复触发。
   */
  function playOut(kind: string) {
    if (leavingRef.current) return
    leavingRef.current = true
    let animated = false
    try {
      const engine = engineRef.current
      animated = engine ? engine.playOut(kind, dismiss) : false
    } catch (ePlay) { animated = false }
    if (!animated) dismiss()
  }

  // 键盘：Esc 关整组（焦点不管在哪都能关）；回车/空格落在按钮上时由下面的 onPillKey 处理。
  React.useEffect(function () {
    if (!items.length) return undefined
    function onKey(ev: any) {
      if (!ev || ev.key !== 'Escape') return
      dismiss()
    }
    document.addEventListener('keydown', onKey)
    return function () { document.removeEventListener('keydown', onKey) }
  }, [groupKey, items.length])

  /** 选中一条：先交给既有注入口子，再让整组消失（注入失败也消失，界面不卡着）。 */
  function pick(prompt: string) {
    try { inject(st, prompt) } catch (eInject) {}
    playOut('pick')
  }
  /** 键盘回车/空格 = 点这一颗；preventDefault 掉浏览器的默认激活，避免同一次按键触发两次。 */
  function onPillKey(ev: any, prompt: string) {
    if (!ev) return
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar' || ev.key === 'Space') {
      try { ev.preventDefault() } catch (ePrevent) {}
      try { if (ev.stopPropagation) ev.stopPropagation() } catch (eStop) {}
      pick(prompt)
    }
  }
  function onPillClick(ev: any, prompt: string) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation() } catch (eStop) {}
    pick(prompt)
  }
  function onCloseClick(ev: any) {
    try { if (ev && ev.stopPropagation) ev.stopPropagation() } catch (eStop) {}
    playOut('fade')
  }
  /** 换详情区显示哪一条：鼠标进入与键盘聚焦都走这里，只认合法下标。 */
  function showDetailOf(index: number) {
    if (typeof index !== 'number' || index < 0 || index >= items.length) return
    setActive(function (prev: any) { return prev === index ? prev : index })
  }
  function pillNodeOf(item: any, index: number) {
    const intro = (typeof item.intro === 'string') ? item.intro : ''
    const prompt = item.prompt
    // 读屏念「简介 提示词」；理由、优点、缺点由 aria-describedby 指向详情区正文读出，不在按钮名里重复念。
    const spoken = intro ? intro + ' ' + prompt : prompt
    // 选项框上只印简介（#1451 后续拍板）：提示词不进按钮，点选时才原样填进输入框；
    // 没有简介的旧事件退回只印提示词。
    const label = intro
      ? React.createElement('span', { key: 'suggest-intro-' + index, className: 'dsws-sugg-intro' }, intro)
      : prompt
    const button = React.createElement('button', {
      key: 'suggest-pill-' + index,
      type: 'button',
      className: 'dsws-sugg-pill',
      'data-press': 'button',
      'data-log': 'suggest.pill',
      style: { maxWidth: pillCapPx + 'px' },
      'aria-label': spoken,
      'aria-describedby': suggestHasDetailOf(item) ? 'suggest-pop-' + groupKey : undefined,
      onClick: function (ev: any) { onPillClick(ev, prompt) },
      onKeyDown: function (ev: any) { onPillKey(ev, prompt) },
    }, label)
    // 定位壳留着：它是「这一颗」的边界，鼠标进入/聚焦都按它算，也免得有理由没理由的 DOM 形状不一致。
    return React.createElement('span', {
      key: 'suggest-wrap-' + index,
      className: 'dsws-sugg-pill-wrap',
      onMouseEnter: function () { showDetailOf(index) },
      onFocus: function () { showDetailOf(index) },
    }, button)
  }

  if (!items.length) return null

  const detailRows = suggestHasDetailOf(items[active]) ? popBodyOf(items[active], active) : []
  const children: any[] = [
    // 主行：这是什么 + 条数。条数单独一颗小胶囊，扫一眼知道有几条可选。
    React.createElement('div', { className: 'dsws-sugg-head', key: 'suggest-head' }, [
      React.createElement('span', { key: 'suggest-head-title', className: 'dsws-sugg-title' }, tr('suggest.group')),
      React.createElement('span', { key: 'suggest-head-count', className: 'dsws-sugg-count' }, String(items.length)),
    ]),
    // 次行：怎么用。用界面词表里的那句话，不写死。
    React.createElement('div', { className: 'dsws-sugg-sub', key: 'suggest-sub' }, tr('suggest.cardPick')),
  ]
  const nodes: any[] = []
  for (let i = 0; i < items.length; i++) nodes.push(pillNodeOf(items[i], i))
  children.push(React.createElement('div', { className: 'dsws-sugg-row', key: 'suggest-row' }, nodes))
  if (detailRows.length) {
    children.push(React.createElement('div', {
      key: 'suggest-detail',
      id: 'suggest-pop-' + groupKey,
      className: 'dsws-sugg-pop',
      role: 'tooltip',
      'data-log': 'suggest.detail',
    }, detailRows))
  }
  children.push(React.createElement('div', { className: 'dsws-sugg-xrow', key: 'suggest-close-row' },
    React.createElement('button', {
      type: 'button',
      className: 'dsws-sugg-close dsws-hov',
      title: tr('suggest.close'),
      'aria-label': tr('suggest.close'),
      'data-press': 'button',
      'data-log': 'suggest.close',
      onClick: onCloseClick,
    }, tr('suggest.closeShort'))))
  // 读屏播报：有几条建议可读（不参与视觉布局）。
  children.push(React.createElement('div', { className: 'dsws-sugg-sr', key: 'suggest-sr', role: 'status', 'aria-live': 'polite' },
    tr('suggest.live', { n: items.length })))

  return React.createElement('div', {
    ref: layerRef,
    className: 'dsws-sugg-layer dsws-sugg-card',
    role: 'group',
    'aria-label': tr('suggest.group'),
    'data-log': 'suggest.group',
    style: {
      position: 'relative',
      zIndex: SUGGEST_Z,
      maxWidth: 'min(calc(100vw - 32px), ' + SUGGEST_APPEARANCE.maxWidthPx + 'px)',
      width: 'max-content',
    },
  }, children)
}
