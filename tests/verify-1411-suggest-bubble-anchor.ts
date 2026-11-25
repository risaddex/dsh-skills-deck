// tests/verify-1411-suggest-bubble-anchor.ts —— 门禁：建议气泡贴在哪儿、什么时候重新量（#1411 / #109）
//
// 契约（票面 #1411 验收②与 #1665 真机复测）：
//   - 锚点跟状态栏外框（胶囊）走：横向对准它的中心，纵向贴它的顶边上方；
//   - 输入框被对话框内容撑高、把胶囊整体顶起时，整组跟着胶囊重算（胶囊自身尺寸没变，所以只观察
//     胶囊收不到通知，得连最宽的输入框一起观察）；
//   - 折叠状态整条状态栏都不在、或老宿主没有探针时，锚点退回最宽的输入框，输入框长高同样要重算；
//   - 量不到任何锚点、或锚点已经跑到视口上方时，退回视口中央靠下，气泡至少留在屏幕里；
//   - 窄栏时不横向溢出（层宽收在视口内）。
//
// 这一扇只管「位置」。形状与交互在 verify-1411-suggest-bubble.ts，样式与源码守卫在
// verify-1411-suggest-bubble-look.ts；三扇共用 tests/lib/suggest-bubble-harness.ts。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-1411-suggest-bubble-anchor.ts
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
  const act = h.act

  // ---------- 1. 锚点：横向取胶囊中心，纵向贴胶囊顶边上方 ----------
  {
    const m = await mount({
      initial: [
        { intro: '接着做', prompt: '/next', reason: '因为还有一张票没关' },
        { intro: '收尾', prompt: '继续收尾', reason: '' },
      ],
      capsuleRect: { left: 100, top: 700, width: 400, height: 36 },
    })
    const layer = m.layer()
    check(layer !== null && layer.style.left === '300px', '锚点：横向 = 胶囊中心（100+400/2）')
    check(layer !== null && layer.style.bottom === '77px', '锚点：纵向 = 视口高 - 胶囊顶 + 9（768-700+9）')
    await m.unmount()
  }

  // ---------- 1.5 状态栏锚点：#1665 起锚点跟状态栏外框走（它的尺寸不随对话框内容变，但位置会被长高的输入框顶起） ----------
  {
    // 胶囊和输入框都在时按胶囊定：横向对准胶囊中心（100+400/2=300），纵向贴胶囊顶边上方（768-700+9=77）。
    const mCap = await mount({
      initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
      inputRect: { left: 200, top: 600, width: 800, height: 44 },
      capsuleRect: { left: 100, top: 700, width: 400, height: 36 },
    })
    check(mCap.layer() !== null && mCap.layer().style.left === '300px', '胶囊锚点：输入框也在时仍对准胶囊中心，而不是输入框中心')
    check(mCap.layer().style.bottom === '77px', '胶囊锚点：纵向贴在胶囊顶边上方（768-700+9）')
    await mCap.unmount()
    // 对话框内容把输入框撑高（顶边上移到 300）时，锚点仍跟胶囊，不被顶到内容区顶部（#1665 现象二）。
    const mTall = await mount({
      initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
      inputRect: { left: 200, top: 300, width: 800, height: 300 },
      capsuleRect: { left: 100, top: 700, width: 400, height: 36 },
    })
    check(mTall.layer() !== null && mTall.layer().style.left === '300px', '胶囊锚点：输入框被内容撑高时横向仍对准胶囊中心')
    check(mTall.layer().style.bottom === '77px', '胶囊锚点：输入框被内容撑高时纵向仍贴胶囊顶边（不飘到内容区顶部）')
    await mTall.unmount()
    // 胶囊量不到（老宿主、没有探针）时才退回最宽的输入框当兜底。
    const mNoCap = await mount({
      initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
      inputRect: { left: 200, top: 600, width: 800, height: 44 },
    })
    check(mNoCap.layer() !== null && mNoCap.layer().style.left === '600px', '胶囊锚点：量不到胶囊时才退回输入框中心（200+800/2）')
    check(mNoCap.layer().style.bottom === '177px', '胶囊锚点：退回输入框时纵向贴输入框顶边上方（768-600+9）')
    await mNoCap.unmount()
    // 页面上有好几个输入域、胶囊又量不到时挑最宽的那个（小的搜索框不该抢锚点）。
    const narrow = document.createElement('textarea')
    narrow.getBoundingClientRect = function () { return { left: 0, top: 500, width: 120, height: 30 } }
    document.body.appendChild(narrow)
    const mWidest = await mount({
      initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
      inputRect: { left: 300, top: 620, width: 640, height: 44 },
    })
    check(mWidest.layer().style.left === '620px', '胶囊锚点：多个输入域兜底时挑最宽的那个当锚点（300+640/2）')
    await mWidest.unmount()
    if (narrow.parentNode) narrow.parentNode.removeChild(narrow)
  }

  // ---------- 1.6 位置重算触发：#1665 现象二（输入框长高把胶囊整体顶起、胶囊自身尺寸不变，气泡也要重跟） ----------
  {
    // jsdom 没有 ResizeObserver：临时装一个假的，能记下观察了谁，并且只触发「观察了这个元素」的回调——
    // 真机上让胶囊整体平移的信号是输入框变高（胶囊被顶上去），胶囊自己的尺寸一直没变，所以只观察胶囊
    // 收不到通知；这一段就是拿这个信号验证位置会不会重新量。
    const roInstances: any[] = []
    function FakeResizeObserver(this: any, callback: any) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      roInstances.push(this)
    }
    FakeResizeObserver.prototype.observe = function (el: any) {
      if (el && this.targets.indexOf(el) < 0) this.targets.push(el)
    }
    FakeResizeObserver.prototype.disconnect = function () { this.disconnected = true }
    function observedTargets() {
      const all: any[] = []
      for (let i = 0; i < roInstances.length; i++) {
        for (let j = 0; j < roInstances[i].targets.length; j++) all.push(roInstances[i].targets[j])
      }
      return all
    }
    async function fireResize(el: any) {
      await act(async function () {
        for (let i = 0; i < roInstances.length; i++) {
          const inst = roInstances[i]
          if (inst.targets.indexOf(el) < 0) continue
          inst.callback(inst.targets.map(function (t: any) { return { target: t } }), inst)
        }
        await new Promise(function (resolve) { setTimeout(resolve, 0) })
      })
    }
    const g: any = global as any
    const hadRO = Object.prototype.hasOwnProperty.call(g, 'ResizeObserver')
    const previousRO = g.ResizeObserver
    g.ResizeObserver = FakeResizeObserver
    try {
      // 胶囊可见：初始胶囊顶边 700、输入框 44 高，气泡贴 700 上方（bottom 77）。
      const capsuleRect = { left: 100, top: 700, width: 400, height: 36 }
      const inputRect = { left: 200, top: 600, width: 800, height: 44 }
      const mGrow = await mount({
        initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
        inputRect: inputRect,
        capsuleRect: capsuleRect,
      })
      const inputEl = document.querySelector('textarea')
      const targets = observedTargets()
      check(targets.indexOf(mGrow.capsule) >= 0, '重算触发：ResizeObserver 仍观察胶囊（胶囊自身尺寸变化时重算）')
      check(inputEl !== null && targets.indexOf(inputEl) >= 0, '重算触发：胶囊可见时也观察输入框（输入框长高会把胶囊整体顶起，胶囊自身尺寸不变）')
      // 模拟粘贴长文：输入框长到 244 高、胶囊被顶到 500 且横向小挪；胶囊自己的 400x36 没变。
      capsuleRect.left = 200
      capsuleRect.top = 500
      inputRect.left = 300
      inputRect.top = 400
      inputRect.height = 244
      await fireResize(inputEl)
      check(mGrow.layer() !== null && mGrow.layer().style.left === '400px', '重算触发：输入框长高后横向重新对准胶囊中心（200+400/2=400）')
      check(mGrow.layer() !== null && mGrow.layer().style.bottom === '277px', '重算触发：输入框长高后纵向重贴胶囊新顶边（768-500+9=277），不留在旧位置')
      await mGrow.unmount()
      check(roInstances.length > 0 && roInstances.every(function (inst: any) { return inst.disconnected }), '重算触发：卸载后 ResizeObserver 全部 disconnect')

      // 折叠状态整条状态栏都不在：锚点退回输入框自己，输入框长高时也要重算，否则气泡被顶出屏幕。
      roInstances.length = 0
      const foldedRect = { left: 200, top: 600, width: 800, height: 44 }
      const mFolded = await mount({
        initial: [{ intro: '一条', prompt: '/a', reason: 'r' }, { intro: '两条', prompt: '/b', reason: 'r' }],
        inputRect: foldedRect,
        noCapsule: true,
      })
      check(mFolded.host.querySelector('.dsws-capsule') === null, '重算触发：折叠状态真的没有状态栏外框（noCapsule 用例不是零矩形冒充）')
      const foldedInput = document.querySelector('textarea')
      const foldedTargets = observedTargets()
      check(foldedInput !== null && foldedTargets.indexOf(foldedInput) >= 0, '重算触发：折叠状态没有状态栏时观察输入框本身（兜底锚点也要能重算）')
      foldedRect.left = 300
      foldedRect.top = 300
      foldedRect.height = 300
      await fireResize(foldedInput)
      check(mFolded.layer() !== null && mFolded.layer().style.left === '700px', '重算触发：折叠态输入框长高后横向重新对准输入框中心（300+800/2=700）')
      check(mFolded.layer() !== null && mFolded.layer().style.bottom === '477px', '重算触发：折叠态输入框长高后纵向重贴输入框新顶边（768-300+9=477），不留在旧位置')
      // 继续粘贴长文：输入框顶边被顶到视口上方（真机复测里是 -538），按它算气泡会跟着飞出屏幕。
      // 这种锚点量得到但不可用，应退回视口中央靠下的兜底位置（1024/2=512，bottom 120）。
      foldedRect.left = 200
      foldedRect.top = -538
      foldedRect.height = 1684
      await fireResize(foldedInput)
      check(mFolded.layer() !== null && mFolded.layer().style.left === '512px', '重算触发：折叠态输入框顶边跑到视口上方时退回视口中央（1024/2=512），气泡不跟出屏幕')
      check(mFolded.layer() !== null && mFolded.layer().style.bottom === '120px', '重算触发：折叠态输入框顶边跑到视口上方时纵向退回视口中央靠下（bottom 120）')
      await mFolded.unmount()
    } finally {
      if (hadRO) g.ResizeObserver = previousRO
      else delete g.ResizeObserver
    }
  }

  // ---------- 8. 拿不到胶囊 / 窄栏：退回视口中央，不横向溢出 ----------
  {
    const mFallback = await mount({ initial: [{ prompt: '没有胶囊祖先', reason: '' }] })
    const lyr = mFallback.layer()
    check(lyr.style.left === '512px', '降级：量不到胶囊时横向落在视口中央（1024/2）')
    check(lyr.style.bottom === '120px', '降级：量不到胶囊时纵向用固定兜底')
    await mFallback.unmount()

    const widthProp = Object.getOwnPropertyDescriptor(win, 'innerWidth')
    Object.defineProperty(win, 'innerWidth', { value: 320, configurable: true, writable: true })
    const mNarrow = await mount({ initial: [{ prompt: '窄栏里也要收住', reason: '' }] })
    const lyrNarrow = mNarrow.layer()
    check(lyrNarrow.style.left === '160px', '窄栏：横向锚点仍按视口宽计算')
    check(lyrNarrow.style.maxWidth.indexOf('100vw') >= 0, '窄栏：层宽随视口收（100vw 兜底）')
    await mNarrow.unmount()
    if (widthProp) Object.defineProperty(win, 'innerWidth', widthProp)
    else Object.defineProperty(win, 'innerWidth', { value: 1024, configurable: true, writable: true })
  }

  if (failures.length) {
    console.log('verify-1411-suggest-bubble-anchor 失败项：')
    for (const item of failures) console.log('  - ' + item)
  }
  console.log('verify-1411-suggest-bubble-anchor：' + total + ' 条断言，' + failures.length + ' 条失败')
  printGateResult('verify-1411-suggest-bubble-anchor', total, failures.length ? 1 : 0)
  process.exit(failures.length ? 1 : 0)
}

main().catch(function (err: any) {
  console.log('verify-1411-suggest-bubble-anchor 异常：' + ((err && err.stack) || err))
  printGateResult('verify-1411-suggest-bubble-anchor', total, 1)
  process.exit(1)
})
