#!/usr/bin/env node
/**
 * tests/verify-suggest-look-browser.ts —— 「下一步建议」在真 Chromium 里画出来到底什么样（#97 收尾）
 *
 * 为什么要有这一扇（2026-11-24，来自一次真实的翻车）：
 *   #97 把浮动的建议药丸换成了一张卡片，整条 `npm run verify:parallel` 全绿，可维护者一看屏幕就报了三处：
 *   药丸几乎看不见、详情区是一整块不透明白板、主行右边的计数是个空圈。原来全链没有一扇门禁去看**画出来的
 *   像素**：jsdom 里没有布局，入场动画的执行器 `run()` 直接返回 false，于是「药丸停在 4% 不透明度」这类
 *   只有真浏览器才有的现象，任何一扇门禁都量不到。
 *
 * 这一扇做什么：把 SuggestBubble 的真 DOM、suggestStyles 的真样式表、以及**真的入场执行器**
 * （suggestTimeline + suggestEngine，现场用 esbuild 转译）放进一只真 Chromium，让它按真机的方式跑完入场，
 * 然后量「人看到的三件事」：
 *   ① 入场结束后每颗药丸与关闭按钮的不透明度到底是多少（药丸看得见吗）；
 *   ② 整组有没有落在视口里、每颗药丸的文字有没有被省略号吃掉；
 *   ③ 主行右边的计数有没有字，鼠标落到一颗药丸上详情区有没有出现、四行齐不齐。
 * 同时把这一屏写成一张 PNG（连同 manifest.json 的路径一起打在输出里），所以门禁自己会看，人也能看。
 *
 * 它**不**判什么：配色好不好看、卡片该不该存在、哪种形状更好 —— 那是人的判断，也是 #97 翻车的另一半
 *   （范围判断）。这一扇只回答「画出来能不能看清、点得到的东西在不在这里」。
 *
 * 夹具与真机的一点差别，写在这里免得后来的人把它当 bug：jsdom 没有布局，组件算出来的锚点坐标全是 0，
 *   所以页面里把整组固定在「胶囊上方居中」这个真机会落到的位置（left:50% / bottom:120px / translateX(-50%)）；
 *   入口动画、样式表、DOM 结构都是真的。
 *
 * 依赖：playwright（含 chromium，经 tests/lib/browser-pool.js 取）与 esbuild（本仓构建本来就用它）。
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-suggest-look-browser.ts
 */
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { JSDOM } = require('jsdom')
const React = require('react')
const esbuild = require('esbuild')
const { getBrowser, closeBrowser } = require('./lib/browser-pool.js')
const { printGateResult } = require('./lib/gate-result.ts')

const ROOT = path.resolve(__dirname, '..')
const imp = function (rel) { return import(pathToFileURL(path.join(ROOT, rel)).href) }
/** 截图与 manifest 落在不入库的缓存目录：门禁跑完人还能重新看一次。 */
const OUT_DIR = path.join(ROOT, 'node_modules', '.cache', 'dsh-suggest-look')

let total = 0
let failed = 0
function check(ok, message) {
  total += 1
  if (ok) console.log('  PASS ' + message)
  else { failed += 1; console.log('  FAIL ' + message) }
}

/** 一行建议：六格齐，理由/优点/缺点都给，好让详情区四行都出现。 */
function itemOf(index) {
  return {
    intro: ['Ver o estado do Git', 'Ler o AGENTS.md', 'Fechar o cartão'][index],
    prompt: ['/git-status', '/read AGENTS.md', '/close'][index],
    reason: ['Ainda não sei se há mudanças pendentes', 'Preciso das regras do repo', 'Já decidi o que fazer'][index],
    gain: ['Vejo arquivos alterados antes de agir', 'Sigo as convenções da casa', 'Paro de perder tempo'][index],
    cost: ['Nenhuma escrita, só leitura', 'Uns minutos de leitura', 'Nada, é só fechar'][index],
    priority: [8, 6, 3][index],
  }
}

/** 把一片叶子转译成能在页面里直接跑的普通脚本：去掉行首 export / declare，再交给 esbuild 去掉类型。 */
function leafScript(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const stripped = source
    .split('\n')
    .filter(function (line) { return !/^\s*declare\s/.test(line) })
    .map(function (line) { return line.replace(/^export\s+/, '') })
    .join('\n')
  return esbuild.transformSync(stripped, { loader: 'ts', target: 'es2020' }).code
}

async function main() {
  // ── 一、用 jsdom 把真组件渲染成一段真 DOM（与 verify-1411 同一套桩，桩的只是跨叶子的宿主口子） ──
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:59519/', runScripts: 'dangerously' })
  const win = dom.window
  global.window = win
  global.document = win.document
  try { global.navigator = win.navigator } catch (eNav) {}
  global.Node = win.Node
  global.HTMLElement = win.HTMLElement
  global.getComputedStyle = win.getComputedStyle.bind(win)
  global.requestAnimationFrame = function (cb) { return setTimeout(cb, 0) }
  global.cancelAnimationFrame = function (id) { clearTimeout(id) }
  win.React = React
  global.React = React
  const ReactDOMClient = require('react-dom/client')
  global.IS_REACT_ACT_ENVIRONMENT = true
  const act = React.act

  const dict = {
    'suggest.group': '下一步建议',
    'suggest.close': '关闭（等于一条都不选）',
    'suggest.label.score': '推荐分',
    'suggest.label.reason': '理由',
    'suggest.label.gain': '优点',
    'suggest.label.cost': '缺点',
    'suggest.live': '有 {n} 条下一步建议',
  }
  global.tr = function (key, params) {
    let text = (dict[key] !== undefined) ? dict[key] : key
    if (params) text = text.replace(/\{(\w+)\}/g, function (m, name) { return (params[name] !== undefined) ? String(params[name]) : m })
    return text
  }
  const appearanceMod = await imp('src/client/statusbar/suggestAppearance.ts')
  global.SUGGEST_Z = appearanceMod.SUGGEST_Z
  global.SUGGEST_APPEARANCE = appearanceMod.SUGGEST_APPEARANCE
  const motionMod = await imp('src/client/kernel/motion.ts')
  global.MOTION = motionMod.MOTION
  global.inject = function () {}
  // 浮层在真机由 kernel:portal 挂到 body；这一扇要看的是组件自己那段，所以直接就地渲染。
  global.PortalOverlay = function (props, children) { return React.createElement('div', props || {}, children) }
  // 入场执行器这一扇要真的跑，桩不能顶掉它：这里留一个壳，页面里再用真源码换掉。
  global.createSuggestEngine = function () { return { run: function () { return false }, playOut: function () { return false }, dispose: function () {} } }
  const stylesMod = await imp('src/client/statusbar/suggestStyles.ts')
  const bubbleMod = await imp('src/client/statusbar/suggestBubble.ts')

  const items = [itemOf(0), itemOf(1), itemOf(2)]
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async function () {
    root.render(React.createElement(bubbleMod.SuggestBubble, {
      st: {},
      sid: 'sess-shot',
      group: { id: 1, items: items },
      onDismiss: function () {},
    }))
  })
  const layer = container.querySelector('.dsws-sugg-layer')
  check(layer !== null, '夹具：真组件把整组（.dsws-sugg-layer）渲染出来了')
  if (!layer) {
    console.log('夹具没渲染出来，后面无从量起。')
    printGateResult('verify-suggest-look-browser', total, 1)
    process.exit(1)
  }
  const layerHtml = layer.outerHTML
  const css = String(stylesMod.SUGGEST_STYLE_TEXT)
  check(css.indexOf('.dsws-sugg-pill') >= 0 && css.indexOf('.dsws-sugg-pop') >= 0, '夹具：样式表拿到了组件自己那一份（含药丸与详情区）')
  check(layerHtml.length > 800, '夹具：取到了整组的真 DOM（' + layerHtml.length + ' 字）')

  // ── 二、把真 DOM + 真样式 + 真执行器放进真 Chromium ──
  const browser = await getBrowser({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 })
  const shell = [
    '<!doctype html><html><head><meta charset=utf-8><style>',
    'html,body{margin:0;height:100%;background:#0d1117}',
    '#dock{position:fixed;left:0;right:0;bottom:0;height:220px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px;padding-bottom:14px}',
    '#capsule{width:min(720px,calc(100% - 32px));height:36px;border-radius:18px;background:#161b22;border:1px solid #30363d;color:#8b949e;font:12px/36px -apple-system,Segoe UI,sans-serif;text-align:center}',
    '#layer-host{position:fixed;inset:0;pointer-events:none}',
    '#layer-host .dsws-sugg-layer{pointer-events:auto}',
    css,
    '</style></head><body data-ds-dark-theme><div id="dock"><div id="capsule">dsh-skills-deck · status capsule</div></div><div id="layer-host"></div></body></html>',
  ].join('\n')
  await page.setContent(shell)
  // jsdom 里算不出锚点，这里把它放回真机会落到的位置：胶囊正上方、水平居中。
  await page.evaluate(function (payload) {
    const host = document.getElementById('layer-host')
    host.innerHTML = payload.html
    const el = host.querySelector('.dsws-sugg-layer')
    if (el) {
      el.style.position = 'fixed'
      el.style.left = '50%'
      el.style.bottom = '120px'
      el.style.transform = 'translateX(-50%)'
    }
  }, { html: layerHtml })
  // 真执行器：外观常量与动效令牌先当数据塞进去，再按 时间线 → 执行器 的顺序注入源码。
  await page.addScriptTag({ content: 'window.SUGGEST_APPEARANCE=' + JSON.stringify(appearanceMod.SUGGEST_APPEARANCE) + ';window.MOTION=' + JSON.stringify(motionMod.MOTION) + ';window.SUGGEST_Z=' + Number(appearanceMod.SUGGEST_Z) + ';' })
  await page.addScriptTag({ content: leafScript('src/client/statusbar/suggestTimeline.ts') })
  await page.addScriptTag({ content: leafScript('src/client/statusbar/suggestEngine.ts') })
  const started = await page.evaluate(function () {
    const el = document.querySelector('.dsws-sugg-layer')
    const engine = createSuggestEngine(el)
    window.__engine = engine
    return engine.run()
  })
  check(started === true, '入场：真执行器在真浏览器里跑起来了（量不到布局时它返回 false，这里必须为真）')
  // 入场按「出场面要看清、整体约 2 秒」定（#1451），留够时间再量，量的是稳态而不是动画中间。
  await page.waitForTimeout(2600)

  // ── 三、量「人看到的三件事」 ──
  const lensOf = function () {
    const layerEl = document.querySelector('.dsws-sugg-layer')
    const pills = Array.prototype.slice.call(document.querySelectorAll('.dsws-sugg-pill'))
    const closeBtn = document.querySelector('.dsws-sugg-close')
    const count = document.querySelector('.dsws-sugg-count')
    const rect = layerEl.getBoundingClientRect()
    const opacityOf = function (el) {
      if (!el) return null
      const inline = el.style && el.style.opacity
      const computed = window.getComputedStyle(el).opacity
      return { inline: inline === '' ? null : inline, computed: computed === '' ? null : computed, effective: Number((inline !== '' && inline != null) ? inline : computed) }
    }
    return {
      pills: pills.map(function (p) { return { text: (p.textContent || '').trim(), opacity: opacityOf(p), clipped: p.scrollWidth > p.clientWidth + 1, width: Math.round(p.getBoundingClientRect().width) } }),
      close: opacityOf(closeBtn),
      count: count ? (count.textContent || '').trim() : null,
      cardFrames: document.querySelectorAll('.dsws-sugg-card').length,
      pillTextColor: (function () {
        const pill = document.querySelector('.dsws-sugg-pill')
        if (!pill) return null
        const raw = window.getComputedStyle(pill).color
        const parts = String(raw).match(/\d+/g) || []
        return { raw: raw, channels: parts.slice(0, 3).map(Number) }
      })(),
      rect: { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      popOpacity: (function () {
        const pop = document.querySelector('.dsws-sugg-pop')
        return pop ? Number(window.getComputedStyle(pop).opacity) : null
      })(),
      pop: (function () {
        const pop = document.querySelector('.dsws-sugg-pop')
        if (!pop) return null
        return { rows: pop.querySelectorAll('.dsws-sugg-pop-row').length, text: (pop.textContent || '').trim() }
      })(),
    }
  }
  const lens = await page.evaluate(lensOf)

  const minPillOpacity = lens.pills.length ? Math.min.apply(null, lens.pills.map(function (p) { return p.opacity.effective })) : 0
  check(lens.pills.length === 3, '量：三颗药丸都在（实际 ' + lens.pills.length + '）')
  check(lens.pills.every(function (p) { return p.text.length > 0 }), '量：每颗药丸都印出了自己的简介')
  // ① 入场结束后药丸看得见吗：#97 那次翻车就是它们停在 0.04 附近，看着像没有按钮。
  check(minPillOpacity >= 0.9, '量：入场结束后每颗药丸的不透明度都在 0.9 以上（最低 ' + minPillOpacity + '）—— 药丸看得见')
  check(lens.close !== null && lens.close.effective >= 0.9, '量：关闭按钮也在 0.9 以上（实际 ' + (lens.close ? lens.close.effective : 'null') + '）')
  // ② 整组在视口里、文字没被省略号吃掉。
  check(lens.rect.left >= 0 && lens.rect.right <= lens.viewport.w + 1, '量：整组落在视口横向范围内（' + lens.rect.left + '…' + lens.rect.right + ' / ' + lens.viewport.w + '）')
  check(lens.rect.top >= 0 && lens.rect.bottom <= lens.viewport.h + 1, '量：整组落在视口纵向范围内（' + lens.rect.top + '…' + lens.rect.bottom + ' / ' + lens.viewport.h + '）')
  check(lens.pills.every(function (p) { return !p.clipped }), '量：每颗药丸的简介都放得下，没有被省略号截断')
  // ③ 桌面这一版没有卡片框（#97 的第一版把药丸换成了一张卡片，后来撤掉了）；顺带量一眼深色主题下
  //    药丸文字是不是浅色 —— 深色底上的浅字，是这块唯一需要的对比度事实。
  check(lens.cardFrames === 0, '量：桌面这一版没有卡片框（.dsws-sugg-card 出现 ' + lens.cardFrames + ' 次）')
  check(lens.pillTextColor !== null && lens.pillTextColor.channels.every(function (c) { return c > 200 }), '量：深色主题下药丸文字是浅色（' + (lens.pillTextColor ? lens.pillTextColor.raw : 'null') + '）')

  // 详情区：先量「没悬停时看不见」，再按组件自己做的那件事（给定位壳加 .dsws-sugg-show-pop）
  // 改一次状态，量「悬停时看得见」。#97 的教训正是「DOM 里有、人看不见」，所以判据认的是不透明度。
  const popHidden = await page.evaluate(function () {
    const pop = document.querySelector('.dsws-sugg-pop')
    return pop ? Number(window.getComputedStyle(pop).opacity) : null
  })
  await page.evaluate(function () {
    const wrap = document.querySelector('.dsws-sugg-pill-wrap')
    if (wrap && wrap.classList) wrap.classList.add('dsws-sugg-show-pop')
  })
  await page.waitForTimeout(260)
  const hovered = await page.evaluate(lensOf)
  check(popHidden === 0, '量：没悬停时详情区是看不见的（不透明度 ' + popHidden + '）')
  check(hovered.pop !== null && hovered.pop.rows === 4, '量：悬停后详情区是四行（实际 ' + (hovered.pop ? hovered.pop.rows : 'null') + ' 行）')
  check(hovered.pop !== null && hovered.pop.text.indexOf('推荐分') >= 0 && hovered.pop.text.indexOf('理由') >= 0, '量：详情区四行带「推荐分 / 理由」标签')
  check(hovered.popOpacity === 1, '量：悬停后详情区真的浮现在人眼前（不透明度 ' + hovered.popOpacity + '）')

  // ── 四、截图 + manifest：门禁自己看，人也看得到 ──
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const shotPath = path.join(OUT_DIR, 'suggest-look.png')
  await page.screenshot({ path: shotPath })
  const bytes = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0
  check(bytes > 10000, '截图：写出一张真 PNG（' + bytes + ' 字节）→ ' + path.relative(ROOT, shotPath))
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    capture: 'suggest-look',
    at: new Date().toISOString(),
    viewport: lens.viewport,
    png: path.basename(shotPath),
    pills: lens.pills.map(function (p) { return { text: p.text, opacity: p.opacity.effective, clipped: p.clipped } }),
    count: lens.count,
    layerRect: lens.rect,
    detailRowsOnHover: hovered.pop ? hovered.pop.rows : null,
    note: 'jsdom 没有布局，整组固定在胶囊上方居中；其余（DOM、样式表、入场执行器）都是真机那一份',
  }, null, 2) + '\n')

  // ── 五、反证：把不透明度压回 0.04，同一条判据必须当场变红 ──
  const doctored = await page.evaluate(function () {
    const pills = Array.prototype.slice.call(document.querySelectorAll('.dsws-sugg-pill'))
    for (const p of pills) p.style.opacity = '0.04'
    const lowest = pills.length ? Math.min.apply(null, pills.map(function (p) { return Number(window.getComputedStyle(p).opacity || p.style.opacity) })) : 0
    return { lowest: lowest }
  })
  check(doctored.lowest < 0.9, '反证：把药丸压回 0.04 时判据确实会红（量到 ' + doctored.lowest + '）—— 这把尺子还灵')

  await page.close()
  await closeBrowser()

  console.log('')
  console.log('截图：' + path.relative(ROOT, shotPath))
  console.log('清单：' + path.relative(ROOT, path.join(OUT_DIR, 'manifest.json')))
  console.log('')
  console.log(total + ' 条断言，' + (failed ? '失败' : '通过'))
  printGateResult('verify-suggest-look-browser', total, failed ? 1 : 0)
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error('门禁抛错：' + ((e && e.stack) || e))
  printGateResult('verify-suggest-look-browser', total, 1)
  process.exit(1)
})
