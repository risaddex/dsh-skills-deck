// tests/lib/suggest-bubble-harness.ts —— 「下一步建议」两扇渲染门禁共用的夹具（#109）
//
// 为什么单独一片：#109 把原来一扇 42 KB 的气泡门禁按行为拆成三扇 —— 形状与交互、锚点与重算、
// 外观与源码守卫。前两扇要的夹具完全一样（真 jsdom、真 React、跨叶子的桩、挂载夹具、按键事件），
// 抄两份的话改一处夹具就得同步改两处，迟早漂开；所以夹具收在这里，两扇门禁只 require 它。
// 第三扇（外观与源码守卫）只读源码文本、不要 DOM，故意不引入本文件。
//
// 真到什么程度：真 jsdom、真 React（两者都来自本仓 devDependencies）、组件从真源原样加载。
// 只有三样是替身，都在这里接上并记下调用：注入口子 inject、页面浮层 PortalOverlay、动效执行器
// createSuggestEngine（不接 —— 组件在 try/catch 里调用它，拿不到就按最终态显示，正是无浏览器布局时该有的样子）。
// 相邻叶子的函数（条目洗形、选项画法、浮层夹取）接的是真实现，按 index.ts 的拼接次序列出。

const path = require('path')
const { pathToFileURL } = require('url')
const { JSDOM } = require('jsdom')
const React = require('react')

const ROOT = path.resolve(__dirname, '..', '..')
const imp = function (rel: string) { return import(pathToFileURL(path.join(ROOT, rel)).href) }

/**
 * 建一套夹具，返回两扇门禁都要用的东西。一个进程建一次：jsdom 的全局（window / document / React）
 * 一旦装在 global 上就影响后续所有模块求值，重装没有意义。
 */
async function createSuggestBubbleHarness() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:59519/',
    runScripts: 'dangerously',
  })
  const win = dom.window
  ;(global as any).window = win
  ;(global as any).document = win.document
  try { (global as any).navigator = win.navigator } catch (eNav) {}
  ;(global as any).Node = win.Node
  ;(global as any).HTMLElement = win.HTMLElement
  ;(global as any).getComputedStyle = win.getComputedStyle.bind(win)
  ;(global as any).requestAnimationFrame = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : function (cb: any) { return setTimeout(cb, 0) }
  ;(global as any).cancelAnimationFrame = win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : function (id: any) { clearTimeout(id) }
  ;(win as any).React = React
  ;(global as any).React = React
  const ReactDOMClient = require('react-dom/client')
  ;(win as any).ReactDOM = ReactDOMClient
  ;(global as any).ReactDOM = ReactDOMClient
  ;(global as any).IS_REACT_ACT_ENVIRONMENT = true
  const act = React.act

  // 词表：与 config/copy/panel.yaml 的 suggest.* 同形；键缺了按键名回退（和真 tr 一致）。
  const dict: Record<string, string> = {
    'suggest.group': '下一步建议',
    'suggest.close': '关闭（等于一条都不选）',
    'suggest.label.score': '推荐分',
    'suggest.label.reason': '理由',
    'suggest.label.gain': '优点',
    'suggest.label.cost': '缺点',
    'suggest.live': '有 {n} 条下一步建议',
  }
  function trFn(key: string, params: any) {
    let text = (dict[key] !== undefined) ? dict[key] : key
    if (params) {
      text = text.replace(/\{(\w+)\}/g, function (m: string, name: string) {
        return (params[name] !== undefined) ? String(params[name]) : m
      })
    }
    return text
  }
  ;(global as any).tr = trFn

  // 跨叶子自由变量：外观常量、动效令牌，以及三片叶子互相的调用，都在这里接上（真机由构建闭包提供）。
  const appearanceMod = await imp('src/client/statusbar/suggestAppearance.ts')
  ;(global as any).SUGGEST_Z = appearanceMod.SUGGEST_Z
  ;(global as any).SUGGEST_APPEARANCE = appearanceMod.SUGGEST_APPEARANCE
  // #1236：动画时长住在 kernel/motion.ts 的 MOTION 里，样式叶子求值前必须先接上。
  const motionMod = await imp('src/client/kernel/motion.ts')
  ;(global as any).MOTION = motionMod.MOTION
  const injectCalls: any[] = []
  const portalCalls: any[] = []
  ;(global as any).inject = function (st: any, text: any) { injectCalls.push({ st: st, text: text }) }
  ;(global as any).PortalOverlay = function (props: any, children: any) {
    portalCalls.push(props)
    return React.createElement('div', props || {}, children)
  }
  portalCalls.length = 0

  const itemViewMod = await imp('src/client/statusbar/suggestItemView.ts')
  const pillMod = await imp('src/client/statusbar/suggestPill.ts')
  const stylesMod = await imp('src/client/statusbar/suggestStyles.ts')
  const bubbleMod = await imp('src/client/statusbar/suggestBubble.ts')
  ;(global as any).suggestViewItemsOf = itemViewMod.suggestViewItemsOf
  ;(global as any).popBodyOf = itemViewMod.popBodyOf
  ;(global as any).suggestPillNodeOf = pillMod.suggestPillNodeOf
  ;(global as any).suggestClampPopToViewport = pillMod.suggestClampPopToViewport

  // ---------- 渲染夹具：真 jsdom + 真 React，只有跨叶子调用是桩 ----------
  const extraInputs: any[] = []
  async function mount(options: any) {
    const opts = options || {}
    const host = document.createElement('div')
    document.body.appendChild(host)
    // 输入框锚点用：真的往文档里塞 textarea（宿主输入框的最小仿形），量不到时自然退回胶囊。
    if (opts.inputRect) {
      const input = document.createElement('textarea')
      input.getBoundingClientRect = function () { return opts.inputRect }
      document.body.appendChild(input)
      extraInputs.push(input)
    }
    // 折叠状态整条状态栏都不在（探针最近处没有 .dsws-capsule）：用 noCapsule 真正模拟 DOM 里没有它，
    // 而不是建一个量不到的元素；两种情形的兜底路径不一样，要分开测（#1665 真机复测）。
    const holder = document.createElement('div')
    let capsule: any = null
    if (opts.noCapsule) {
      host.appendChild(holder)
    } else {
      capsule = document.createElement('div')
      capsule.className = 'dsws-capsule'
      if (opts.capsuleRect) {
        capsule.getBoundingClientRect = function () { return opts.capsuleRect }
      }
      host.appendChild(capsule)
      capsule.appendChild(holder)
    }
    const st = { injector: function () {} }
    let setGroup: any = null
    function Host() {
      const state = React.useState(opts.initial ? { id: 1, items: opts.initial } : null)
      setGroup = state[1]
      const group = state[0]
      if (!group) return null
      return React.createElement(bubbleMod.SuggestBubble, {
        st: st,
        sid: 'sid-1',
        group: group,
        onDismiss: function () { setGroup(null) },
      })
    }
    const root = ReactDOMClient.createRoot(holder)
    await act(async function () {
      root.render(React.createElement(Host))
      await new Promise(function (resolve) { setTimeout(resolve, 0) })
    })
    return {
      host: host,
      capsule: capsule,
      holder: holder,
      st: st,
      async setItems(items: any, id: any) {
        await act(async function () {
          setGroup({ id: id || 2, items: items })
          await new Promise(function (resolve) { setTimeout(resolve, 0) })
        })
      },
      pills: function () { return Array.prototype.slice.call(holder.querySelectorAll('.dsws-sugg-pill')) },
      layer: function () { return holder.querySelector('.dsws-sugg-layer') },
      closeBtn: function () { return holder.querySelector('.dsws-sugg-close') },
      sr: function () { return holder.querySelector('.dsws-sugg-sr') },
      async fire(node: any, type: string, event: any) {
        await act(async function () {
          node.dispatchEvent(event)
          await new Promise(function (resolve) { setTimeout(resolve, 0) })
        })
      },
      async click(node: any) {
        await act(async function () {
          node.click()
          await new Promise(function (resolve) { setTimeout(resolve, 0) })
        })
      },
      async unmount() {
        await act(async function () { root.unmount() })
        if (host.parentNode) host.parentNode.removeChild(host)
        while (extraInputs.length) {
          const input = extraInputs.pop()
          if (input && input.parentNode) input.parentNode.removeChild(input)
        }
      },
    }
  }
  function keyEvent(key: string) {
    return new win.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true })
  }

  return {
    dom: dom,
    win: win,
    act: act,
    mount: mount,
    keyEvent: keyEvent,
    injectCalls: injectCalls,
    portalCalls: portalCalls,
    appearanceMod: appearanceMod,
    motionMod: motionMod,
    itemViewMod: itemViewMod,
    pillMod: pillMod,
    stylesMod: stylesMod,
    bubbleMod: bubbleMod,
    ROOT: ROOT,
  }
}

module.exports = { createSuggestBubbleHarness: createSuggestBubbleHarness }
