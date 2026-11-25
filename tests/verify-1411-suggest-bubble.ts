// tests/verify-1411-suggest-bubble.ts —— 门禁：状态胶囊上方建议气泡的形状与交互（#1411 / #109）
//
// 契约（票面 #1411 验收①~⑤、⑦、⑨）：
//   - 挂页面浮层：层由 kernel:portal 的 PortalOverlay 挂到 body，position:fixed，z-index 取 SUGGEST_Z
//     （与胶囊同层，宿主设置面板能盖住它，#1665）；悬停理由用框正上方浮层，位置固定、不跟鼠标；
//   - 选项 2~4 颗，框上只印简介、提示词不进按钮，点一条走既有 inject（把文本填进输入框、不发送），
//     点完/关闭整组消失；第二组覆盖第一组；真按钮可聚焦，回车/空格填入，Esc 关整组；
//   - 浮层四行固定为「推荐分 / 理由 / 优点 / 缺点」，缺格跳过；理由对读屏可读（aria-describedby）；
//   - 数据不合法不崩、不渲染半成品。
//
// 这一扇只管「画成什么样、点下去发生什么」。锚点与位置重算在 verify-1411-suggest-bubble-anchor.ts，
// 样式文本与源码守卫在 verify-1411-suggest-bubble-look.ts；三扇共用 tests/lib/suggest-bubble-harness.ts。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-1411-suggest-bubble.ts
// 断言数变化时同步 scripts/gate-map.mts 里 COMPLETION_RECORDED_GATES 的对应一行。
const { printGateResult } = require('./lib/gate-result.ts')
const { createSuggestBubbleHarness } = require('./lib/suggest-bubble-harness.ts')

const failures: string[] = []
let total = 0
function check(ok: boolean, label: string) {
  total++
  if (!ok) failures.push(label)
}

async function main() {
  const h = await createSuggestBubbleHarness()
  const mount = h.mount
  const win = h.win
  const injectCalls = h.injectCalls
  const portalCalls = h.portalCalls
  const appearanceMod = h.appearanceMod
  const keyEvent = h.keyEvent

  // ---------- 1. 基本形状：两颗选项、层属性、层级、读屏 ----------
  {
    injectCalls.length = 0
    const m = await mount({
      initial: [
        { intro: '接着做', prompt: '/next', reason: '因为还有一张票没关' },
        { intro: '收尾', prompt: '继续收尾', reason: '' },
      ],
      capsuleRect: { left: 100, top: 700, width: 400, height: 36 },
    })
    check(m.pills().length === 2, '基本：显示 2 颗选项')
    // #1451 后续：选项框上只印简介，提示词不进按钮（点选时才填进输入框）；两颗时每颗最大宽度均分整组（(720-6)/2=357）。
    check(m.pills()[0].textContent === '接着做', '基本：选项框上只显示简介')
    check(m.pills()[0].querySelector('.dsws-sugg-cmd') === null && m.pills()[0].textContent.indexOf('/next') < 0, '基本：提示词不进按钮（点选时才填）')
    check(m.pills()[0].style.maxWidth === '357px' && m.pills()[1].style.maxWidth === '357px', '基本：两颗时每颗最大宽度均分整组（(720-6)/2=357）')
    check(m.pills()[0].parentNode !== null && m.pills()[0].parentNode.className.indexOf('dsws-sugg-pill-wrap') >= 0, '基本：有理由的选项包在定位壳里（浮层按框顶边摆）')
    const layer = m.layer()
    check(layer !== null, '基本：气泡层已渲染')
    check(layer.getAttribute('role') === 'group', '基本：层 role=group')
    check(layer.getAttribute('aria-label') === '下一步建议', '基本：层 aria-label 走词表')
    check(layer.getAttribute('data-log') === 'suggest.group', '基本：层挂 data-log 便于查日志')
    check(layer.style.position === 'fixed', '基本：层 position:fixed（页面浮层）')
    check(layer.style.zIndex === String(appearanceMod.SUGGEST_Z), '基本：层 z-index 取具名常量 SUGGEST_Z')
    check(layer.style.pointerEvents === 'none', '基本：层本身不吃鼠标事件（只有子控件可点）')
    check(layer.style.maxWidth.indexOf('100vw') >= 0 && layer.style.maxWidth.indexOf('720') >= 0, '基本：层最大宽度受视口与旋钮共同约束')
    check(m.pills()[0].getAttribute('aria-label') === '接着做 /next', '基本：选项 aria-label 只念「简介 提示词」，理由交给浮层（读屏走 aria-describedby）')
    check(m.pills()[0].parentNode.querySelector('.dsws-sugg-pop') !== null && m.pills()[0].parentNode.querySelector('.dsws-sugg-pop').textContent === '理由因为还有一张票没关', '基本：理由收进框正上方的浮层，带「理由」标签')
    check(m.pills()[0].getAttribute('aria-describedby') === m.pills()[0].parentNode.querySelector('.dsws-sugg-pop').getAttribute('id'), '基本：按钮用 aria-describedby 指到自己的浮层')
    check(m.pills()[1].getAttribute('aria-label') === '收尾 继续收尾', '基本：没理由的选项 aria-label 念「简介 提示词」，不念理由')
    check(m.pills()[1].parentNode.querySelector('.dsws-sugg-pop') === null, '基本：没理由的选项不挂浮层')
    check(m.sr() !== null && m.sr().getAttribute('role') === 'status' && m.sr().getAttribute('aria-live') === 'polite', '基本：读屏播报节点 role=status aria-live=polite')
    check(m.sr().textContent === '有 2 条下一步建议', '基本：读屏播报条数')
    check(m.closeBtn() !== null && m.closeBtn().getAttribute('type') === 'button', '基本：关闭是真按钮')
    check(m.closeBtn().getAttribute('aria-label') === '关闭（等于一条都不选）', '基本：关闭按钮 aria-label 说明含义')
    check(portalCalls.length >= 1, '基本：层经 PortalOverlay 挂载（与胶囊菜单同招）')
    await m.fire(m.pills()[0], 'mouseover', new win.MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    check(m.pills()[0].parentNode.className.indexOf('dsws-sugg-show-pop') >= 0, '基本：鼠标进入选项框浮层显现（固定在框上方，不跟鼠标）')
    await m.fire(m.pills()[0], 'mouseout', new win.MouseEvent('mouseout', { bubbles: true, cancelable: true }))
    check(m.pills()[0].parentNode.className.indexOf('dsws-sugg-show-pop') < 0, '基本：鼠标离开选项框浮层收起')
    await m.unmount()

    // 三条、四条时也要排得进一行：宽度按条数均分，条数越多每颗越窄（#1451）。
    const m3 = await mount({
      initial: [
        { intro: '一', prompt: '/one', reason: '' },
        { intro: '二', prompt: '/two', reason: '' },
        { intro: '三', prompt: '/three', reason: '' },
      ],
    })
    check(m3.pills().length === 3 && m3.pills().every(function (p: any) { return p.style.maxWidth === '236px' }),
      '基本：三条时每颗最大宽度均分整组（(720-12)/3=236，三条排得进一行）')
    await m3.unmount()
    const m4 = await mount({
      initial: [
        { intro: '一', prompt: '/one', reason: '' },
        { intro: '二', prompt: '/two', reason: '' },
        { intro: '三', prompt: '/three', reason: '' },
        { intro: '四', prompt: '/four', reason: '' },
      ],
    })
    check(m4.pills().length === 4 && m4.pills().every(function (p: any) { return p.style.maxWidth === '175px' }),
      '基本：四条时每颗最大宽度均分整组（(720-18)/4=175）')
    await m4.unmount()
  }

  // ---------- 1.7 浮层四行：推荐分 / 理由 / 优点 / 缺点，缺格跳过 ----------
  {
    const rowsOf = function (pop: any) { return Array.prototype.slice.call(pop.querySelectorAll('.dsws-sugg-pop-row')) }
    const labelsOf = function (pop: any) {
      return rowsOf(pop).map(function (row: any) { return row.querySelector('.dsws-sugg-pop-label').textContent })
    }
    const valuesOf = function (pop: any) {
      return rowsOf(pop).map(function (row: any) { return row.querySelector('.dsws-sugg-pop-value').textContent })
    }
    const mScore = await mount({
      initial: [
        { intro: '先做', prompt: '/a', reason: '卡在后面', gain: '能马上解阻塞', cost: '要多花十分钟', priority: 9.5 },
        { intro: '后做', prompt: '/b', reason: '顺手做', gain: '改动小', cost: '收益也小', priority: 3 },
      ],
    })
    const pops = function () { return Array.prototype.slice.call(mScore.holder.querySelectorAll('.dsws-sugg-pop')) }
    check(pops().length === 2, '四行：两颗选项各有自己的浮层')
    check(rowsOf(pops()[0]).length === 4, '四行：完整条目给出推荐分、理由、优点、缺点四行')
    check(labelsOf(pops()[0]).join('|') === '推荐分|理由|优点|缺点', '四行：行序固定为推荐分、理由、优点、缺点')
    check(valuesOf(pops()[0]).join('|') === '9.5|卡在后面|能马上解阻塞|要多花十分钟', '四行：每行印对应正文（分数取模型原值）')
    check(rowsOf(pops()[1]).length === 4 && valuesOf(pops()[1]).join('|') === '3|顺手做|改动小|收益也小', '四行：第二条同形，分数 3 原样印出')
    const mZero = await mount({
      initial: [
        { intro: '最后', prompt: '/a', reason: 'r', gain: 'g', cost: 'c', priority: 0 },
        { intro: '其次', prompt: '/b', reason: 'r', gain: 'g', cost: 'c', priority: 6 },
      ],
    })
    const zeroRows = rowsOf(mZero.holder.querySelector('.dsws-sugg-pop'))
    check(zeroRows.length === 4 && zeroRows[0].querySelector('.dsws-sugg-pop-value').textContent === '0', '四行：0 分也印出来（0 是「最后再做」，不是没打分）')
    await mZero.unmount()
    // 旧事件（改四行之前存下的条目）没有 gain/cost/priority：能印几行印几行，不补空行。
    const mLegacy = await mount({ initial: [{ intro: '旧', prompt: '/old', reason: '旧理由' }] })
    const legacyPops = mLegacy.holder.querySelectorAll('.dsws-sugg-pop')
    check(legacyPops.length === 1 && rowsOf(legacyPops[0]).length === 1 && labelsOf(legacyPops[0]).join('|') === '理由', '四行：旧事件缺优点、缺点与推荐分时只印有的一行，不补空行')
    await mLegacy.unmount()
    await mScore.unmount()
  }

  // ---------- 2. 点一条：走既有 inject、不发送、整组消失 ----------
  {
    injectCalls.length = 0
    const m = await mount({ initial: [{ prompt: '再跑一遍验证', reason: '上次没跑完' }] })
    await m.click(m.pills()[0])
    check(injectCalls.length === 1, '点选：调用既有 inject 恰好一次')
    check(injectCalls.length === 1 && injectCalls[0].text === '再跑一遍验证', '点选：把提示词原样交给 inject（补尾换行由 inject 负责）')
    check(injectCalls.length === 1 && injectCalls[0].st === m.st, '点选：交给同一份会话 store（不另造注入通路）')
    check(m.layer() === null && m.pills().length === 0, '点选：随后整组消失，不留半成品')
    await m.unmount()
  }

  // ---------- 3. 关闭按钮：一条不选，不注入 ----------
  {
    injectCalls.length = 0
    const m = await mount({ initial: [{ prompt: '随便一条', reason: '' }] })
    await m.click(m.closeBtn())
    check(injectCalls.length === 0, '关闭：不调用 inject（等于一条都不选）')
    check(m.layer() === null && m.pills().length === 0, '关闭：整组消失')
    await m.unmount()
  }

  // ---------- 4. 键盘：回车与空格填入；都不触发浏览器默认激活 ----------
  {
    injectCalls.length = 0
    const m = await mount({ initial: [{ prompt: '回车填入', reason: '' }] })
    const enterEvent = keyEvent('Enter')
    await m.fire(m.pills()[0], 'keydown', enterEvent)
    check(injectCalls.length === 1 && injectCalls[0].text === '回车填入', '键盘：回车把提示词填入')
    check(enterEvent.defaultPrevented === true, '键盘：回车 preventDefault，避免同一次按键触发两次')
    check(m.pills().length === 0, '键盘：回车填入后整组消失')
    await m.unmount()

    injectCalls.length = 0
    const m2 = await mount({ initial: [{ prompt: '空格填入', reason: '' }] })
    const spaceEvent = keyEvent(' ')
    await m2.fire(m2.pills()[0], 'keydown', spaceEvent)
    check(injectCalls.length === 1 && injectCalls[0].text === '空格填入', '键盘：空格把提示词填入')
    check(m2.pills().length === 0, '键盘：空格填入后整组消失')
    await m2.unmount()
  }

  // ---------- 5. Esc 关整组（焦点在哪都能关） ----------
  {
    injectCalls.length = 0
    const m = await mount({ initial: [{ prompt: '不该被填进去', reason: '' }] })
    await m.fire(document, 'keydown', keyEvent('Escape'))
    check(injectCalls.length === 0, 'Esc：关组不等于选一条，不注入')
    check(m.layer() === null, 'Esc：整组消失')
    await m.unmount()
    // 卸载后监听要摘掉：再按 Esc 不该有任何异常或副作用。
    let threw = false
    try { document.dispatchEvent(keyEvent('Escape')) } catch (eEsc) { threw = true }
    check(threw === false, 'Esc：组件卸载后监听已摘，再按不抛')
  }

  // ---------- 6. 第二组覆盖第一组 ----------
  {
    const m = await mount({ initial: [{ prompt: '旧的一组', reason: '' }] })
    await m.setItems([{ prompt: '新的第一条', reason: '' }, { prompt: '新的第二条', reason: '' }], 7)
    check(m.holder.querySelectorAll('.dsws-sugg-layer').length === 1, '覆盖：任何时刻只有一组气泡层')
    check(m.holder.textContent.indexOf('旧的一组') < 0, '覆盖：旧一组不再显示')
    check(m.pills().length === 2 && m.pills()[0].textContent === '新的第一条', '覆盖：显示的是新一组')
    await m.unmount()
  }

  // ---------- 7. 防御性渲染：条数越界、空数组、坏形状都不崩 ----------
  {
    const m6 = await mount({ initial: [
      { prompt: '一', reason: '' }, { prompt: '二', reason: '' }, { prompt: '三', reason: '' },
      { prompt: '四', reason: '' }, { prompt: '五', reason: '' }, { prompt: '六', reason: '' },
    ] })
    check(m6.pills().length === 4, '防御：超过上限截到 4 颗')
    await m6.unmount()

    const mEmpty = await mount({ initial: [] })
    check(mEmpty.layer() === null && mEmpty.pills().length === 0, '防御：空数组不渲染任何东西')
    await mEmpty.unmount()

    const mBad = await mount({ initial: 'not-an-array' })
    check(mBad.layer() === null && mBad.pills().length === 0, '防御：items 不是数组时安静不渲染')
    await mBad.unmount()

    const mMix = await mount({ initial: [null, {}, { prompt: '' }, { prompt: '好的', reason: 123 }, { prompt: '第二条', reason: '有理由' }] })
    check(mMix.pills().length === 2, '防御：坏条目被过滤，只留 prompt 非空的')
    check(mMix.pills()[0].getAttribute('aria-label') === '好的', '防御：reason 不是字符串就不当理由')
    check(mMix.pills()[0].parentNode.querySelector('.dsws-sugg-pop') === null, '防御：reason 不是字符串就不挂浮层')
    check(mMix.pills()[1].textContent === '第二条' && mMix.pills()[1].parentNode.querySelector('.dsws-sugg-pop').textContent === '理由有理由', '防御：只有字符串理由才挂浮层，浮层里带「理由」标签与正文、框里仍只显示简介')
    await mMix.unmount()
  }

  if (failures.length) {
    console.log('verify-1411-suggest-bubble 失败项：')
    for (const item of failures) console.log('  - ' + item)
  }
  console.log('verify-1411-suggest-bubble：' + total + ' 条断言，' + failures.length + ' 条失败')
  printGateResult('verify-1411-suggest-bubble', total, failures.length ? 1 : 0)
  process.exit(failures.length ? 1 : 0)
}

main().catch(function (err: any) {
  console.log('verify-1411-suggest-bubble 异常：' + ((err && err.stack) || err))
  printGateResult('verify-1411-suggest-bubble', total, 1)
  process.exit(1)
})
