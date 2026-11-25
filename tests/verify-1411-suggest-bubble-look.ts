// tests/verify-1411-suggest-bubble-look.ts —— 门禁：建议气泡的样式文本与源码守卫（#1411 / #109）
//
// 契约（票面 #1411 验收⑤、⑨ 的「长相」与「不越权」两半）：
//   - 样式文本结构齐：选项行可换行、单颗有上限、窄栏不溢出，尺寸与颜色全部来自外观旋钮或主题 token，
//     不写死数字；
//   - 外观旋钮集中一处（层级常量值不变、样式不写死尺寸）；
//   - 界面不越权碰会话服务；薄壳不新增定时器；逐帧轮询锚点的间隔取自 MOTION；
//   - 三片叶子（条目洗形、一颗选项、气泡薄壳）在入口与构建清单里登记齐全、次序正确。
//
// 这一扇只读源码文本、不建 jsdom：它量的都是「文本里写着什么」，不需要真的把气泡画一遍。
// 形状与交互在 verify-1411-suggest-bubble.ts，锚点与重算在 verify-1411-suggest-bubble-anchor.ts。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-1411-suggest-bubble-look.ts
// 断言数变化时同步 scripts/gate-map.mts 里 COMPLETION_RECORDED_GATES 的对应一行。
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { printGateResult } = require('./lib/gate-result.ts')
const ROOT = path.resolve(__dirname, '..')
const imp = function (rel: string) { return import(pathToFileURL(path.join(ROOT, rel)).href) }

const failures: string[] = []
let total = 0
function check(ok: boolean, label: string) {
  total++
  if (!ok) failures.push(label)
}
// 源码守卫只看代码行：整行注释与块注释里的字眼不算（注释里可以提到「sessions」「2147483000」这类名字）。
function codeOnly(src: any) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(function (line: string) { return line.trim().indexOf('//') !== 0 })
    .join('\n')
}

async function main() {
  // 样式叶子求值时要有外观常量与动效令牌（真机由构建闭包按次序提供）；这里不建 DOM，只接这两个。
  const appearanceMod = await imp('src/client/statusbar/suggestAppearance.ts')
  ;(global as any).SUGGEST_Z = appearanceMod.SUGGEST_Z
  ;(global as any).SUGGEST_APPEARANCE = appearanceMod.SUGGEST_APPEARANCE
  const motionMod = await imp('src/client/kernel/motion.ts')
  ;(global as any).MOTION = motionMod.MOTION
  const stylesMod = await imp('src/client/statusbar/suggestStyles.ts')

  // ---------- 9. 样式文本：结构齐、关键尺寸来自外观常量、窄栏 wrap ----------
  {
    const css = stylesMod.SUGGEST_STYLE_TEXT
    check(typeof css === 'string' && css.indexOf('.dsws-sugg-pill') >= 0, '样式：选项样式存在')
    check(css.indexOf('flex-wrap:wrap') >= 0, '样式：选项行可换行（窄栏不溢出）')
    check(css.indexOf('max-width:100%') >= 0, '样式：选项行宽度不超过层')
    check(css.indexOf('max-width:' + appearanceMod.SUGGEST_APPEARANCE.pillMaxWidthPx + 'px') >= 0, '样式：单颗最大宽度来自外观旋钮')
    check(css.indexOf('font-size:' + appearanceMod.SUGGEST_APPEARANCE.pillFontPx + 'px') >= 0, '样式：药丸字号来自外观旋钮')
    check(css.indexOf('border-radius:' + appearanceMod.SUGGEST_APPEARANCE.pillRadiusPx + 'px') >= 0, '样式：圆角来自外观旋钮')
    check(css.indexOf('.dsws-sugg-close') >= 0, '样式：关闭按钮样式存在')
    check(css.indexOf('opacity:' + appearanceMod.SUGGEST_APPEARANCE.closeIdleOpacity) >= 0, '样式：关闭按钮空闲透明度来自外观旋钮')
    check(css.indexOf(':focus-visible') >= 0, '样式：键盘焦点可见')
    check(css.indexOf('.dsws-sugg-sr') >= 0, '样式：读屏节点视觉隐藏')
    check(css.indexOf('--dsw-alias-') >= 0, '样式：颜色走宿主主题 token（亮暗主题都不用另写）')
    check(css.indexOf('.dsws-sugg-intro') >= 0 && css.indexOf('.dsws-sugg-pill-wrap') >= 0 && css.indexOf('.dsws-sugg-pop') >= 0, '样式：简介、浮层定位壳、浮层的样式都在')
    check(css.indexOf('.dsws-sugg-cmd') < 0, '样式：提示词不再进按钮，旧的两段样式已删')
    check(css.indexOf('bottom:calc(100% + ' + appearanceMod.SUGGEST_APPEARANCE.popGapPx + 'px)') >= 0, '样式：浮层固定在框顶边正上方（间距来自外观旋钮，不跟鼠标）')
    check(css.indexOf('max-width:min(' + appearanceMod.SUGGEST_APPEARANCE.popMaxWidthPx + 'px, calc(100vw - ' + (appearanceMod.SUGGEST_APPEARANCE.popViewportMarginPx * 2) + 'px))') >= 0, '样式：浮层最大宽度来自外观旋钮，同时收在视口内（窄窗口不横向溢出）')
    const popRule = (css.match(/\.dsws-sugg-pop\{[^}]*\}/) || [''])[0]
    check(popRule.indexOf('display:block') >= 0 && popRule.indexOf('display:flex') < 0, '样式：浮层按普通文字流排版（不用竖排 flex），评分才能和理由排在同一行')
    check(css.indexOf('.dsws-sugg-pop-row{display:grid') >= 0 && css.indexOf('column-gap:' + appearanceMod.SUGGEST_APPEARANCE.popLabelGapPx + 'px') >= 0, '样式：四行按两列网格排，标签与正文间距来自外观旋钮')
    check(css.indexOf('.dsws-sugg-pop-row + .dsws-sugg-pop-row{margin-top:' + appearanceMod.SUGGEST_APPEARANCE.popRowGapPx + 'px}') >= 0, '样式：行与行之间留空，行距来自外观旋钮')
    check(css.indexOf('.dsws-sugg-pop-label') >= 0 && css.indexOf('.dsws-sugg-pop-value') >= 0, '样式：四行的灰色标签与正文样式都在')
    check(css.indexOf('.dsws-sugg-score') < 0 && css.indexOf('.dsws-sugg-reason') < 0, '样式：旧分数泡与理由同行样式已删（四行取代它们）')
    check(popRule.indexOf('background:' + appearanceMod.SUGGEST_APPEARANCE.popBg) >= 0, '样式：浮层底色取自浮层专用旋钮（比选项框淡一档）')
    check(css.indexOf('body:not([data-ds-dark-theme]) .dsws-sugg-pop{background:' + appearanceMod.SUGGEST_APPEARANCE.lightPopBg) >= 0, '样式：浅色主题下浮层也另给一档更淡的底色')
    check(popRule.indexOf('color:' + appearanceMod.SUGGEST_APPEARANCE.popText) >= 0 && css.indexOf('.dsws-sugg-pop[role="tooltip"]{color:' + appearanceMod.SUGGEST_APPEARANCE.popText) >= 0, '样式：浮层正文用浮层自己的深色文字色，且颜色规则带 role 属性选择器（特异性高过宿主 body [role="tooltip"] 规则，#1834）')
    check(css.indexOf('.dsws-sugg-pop-label{color:' + appearanceMod.SUGGEST_APPEARANCE.popLabelText) >= 0 && (css.match(/\.dsws-sugg-pop-value\{[^}]*\}/) || [''])[0].indexOf('color:' + appearanceMod.SUGGEST_APPEARANCE.popText) >= 0, '样式：四行标签有自己的深色文字色（不用主题次要色），正文也显式写深色、不再只靠继承（#1834）')
    check(popRule.indexOf('backdrop-filter') < 0, '样式：浮层不再做半透明磨砂（改成不透明卡片，标签对比度才稳）')
    check(css.indexOf('--dsw-alias-label-secondary') < 0, '样式：浮层标签与关闭按钮都不再借用主题次要文字色')
    const closeRule = (css.match(/\.dsws-sugg-close\{[^}]*\}/) || [''])[0]
    check(closeRule.indexOf('background:' + appearanceMod.SUGGEST_APPEARANCE.closeBg) >= 0 && closeRule.indexOf('border:1px solid ' + appearanceMod.SUGGEST_APPEARANCE.closeBorder) >= 0 && closeRule.indexOf('color:' + appearanceMod.SUGGEST_APPEARANCE.closeText) >= 0, '样式：关闭按钮有空闲可见的实心底、描边与深色「×」')
    check(css.indexOf('body:not([data-ds-dark-theme]) .dsws-sugg-close{background:' + appearanceMod.SUGGEST_APPEARANCE.lightCloseBg + ';color:' + appearanceMod.SUGGEST_APPEARANCE.lightCloseText) >= 0, '样式：浅色主题的关闭按钮换成反色芯片')
    check(css.indexOf('prefers-reduced-motion') >= 0, '样式：尊重系统减少动效偏好')
  }

  // ---------- 10. 源码守卫：外观旋钮集中、层级常量值不变、界面不越权碰会话 ----------
  {
    const appearanceSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestAppearance.ts'), 'utf8')
    const stylesSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestStyles.ts'), 'utf8')
    const bubbleSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestBubble.ts'), 'utf8')
    // #109：一颗选项的画法与条目洗形各住一片相邻叶子，守卫按职责分头看，别拿薄壳的文本冒充它们。
    const pillSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestPill.ts'), 'utf8')
    const itemViewSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestItemView.ts'), 'utf8')
    const streamSrc = fs.readFileSync(path.join(ROOT, 'src/client/statusbar/suggestStream.ts'), 'utf8')
    const indexSrc = fs.readFileSync(path.join(ROOT, 'src/client/index.ts'), 'utf8')
    const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts/build.mts'), 'utf8')
    const leavesSrc = fs.readFileSync(path.join(ROOT, 'tests/verify-leaves.ts'), 'utf8')

    check(appearanceMod.SUGGEST_Z === 0, '守卫：SUGGEST_Z 的具体值是 0（与胶囊同层，#1665）')
    check(appearanceMod.SUGGEST_Z < 2147483000, '守卫：SUGGEST_Z 低于仓库顶层浮层（2147483000）')
    check(/export const SUGGEST_Z = 0/.test(appearanceSrc), '守卫：层级常量在 appearance 叶子且只有一个定义')
    const bubbleCode = codeOnly(bubbleSrc)
    check(bubbleCode.indexOf('SUGGEST_Z') >= 0 && !/zIndex:\s*\d/.test(bubbleCode), '守卫：气泡层取具名常量，不写字面量层级')
    check(stylesSrc.indexOf('SUGGEST_APPEARANCE.pillFontPx') >= 0 && stylesSrc.indexOf('12.5') < 0, '守卫：样式尺寸来自外观旋钮，不写死数字')
    check(stylesSrc.indexOf('SUGGEST_APPEARANCE.popText') >= 0 && stylesSrc.indexOf('SUGGEST_APPEARANCE.popLabelText') >= 0 && stylesSrc.indexOf('--dsw-alias-label-secondary') < 0, '守卫：浮层文字用不透明卡片上的深色文字色，不再借主题次要色')
    check(stylesSrc.indexOf('SUGGEST_APPEARANCE.closeBg') >= 0 && stylesSrc.indexOf('SUGGEST_APPEARANCE.closeText') >= 0 && stylesSrc.indexOf('SUGGEST_APPEARANCE.lightCloseBg') >= 0, '守卫：关闭按钮的实心底与反色芯片来自外观旋钮')
    check(stylesSrc.indexOf('SUGGEST_APPEARANCE.popBlurPx') < 0 && stylesSrc.indexOf('SUGGEST_APPEARANCE.popViewportMarginPx') >= 0, '守卫：浮层不再磨砂，宽度同时收在视口内')
    check(stylesSrc.indexOf('--dsw-alias-') >= 0, '守卫：样式颜色只用主题 token')
    check(bubbleSrc.indexOf('setInterval') < 0 && bubbleSrc.indexOf('setTimeout') < 0 && pillSrc.indexOf('setInterval') < 0 && pillSrc.indexOf('setTimeout') < 0, '守卫：薄壳与选项画法都不新增定时器')
    check(bubbleSrc.indexOf('requestAnimationFrame') >= 0 && bubbleSrc.indexOf('suggestAnchorPollMs') >= 0, '守卫：气泡薄壳逐帧轮询锚点，间隔取自 MOTION（侧栏收起后重排，#1787）')
    check(pillSrc.indexOf('dsws-sugg-pop-shift') >= 0 && pillSrc.indexOf('dsws-sugg-pop-shift-y') >= 0 && pillSrc.indexOf('suggestPopShiftOf') >= 0, '守卫：浮层靠自己的横向/纵向位移变量夹在视口内（窄窗口不溢出、顶边越界下推；算术取自时间线纯函数）')
    check(pillSrc.indexOf('dsws-sugg-intro') >= 0 && pillSrc.indexOf('dsws-sugg-pop') >= 0 && pillSrc.indexOf('dsws-sugg-pill-wrap') >= 0 && pillSrc.indexOf("role: 'tooltip'") >= 0, '守卫：选项画法只印简介、理由进正上方浮层，并保留 role=tooltip（读屏的 aria-describedby 依赖它，不能为绕样式而删，#1834）')
    check(pillSrc.indexOf('dsws-sugg-cmd') < 0 && bubbleSrc.indexOf('dsws-sugg-cmd') < 0 && itemViewSrc.indexOf('dsws-sugg-cmd') < 0 && bubbleSrc.indexOf('Tip') < 0 && pillSrc.indexOf('Tip') < 0, '守卫：按钮里不再有提示词那段，也不再用跟鼠标走的悬停提示')
    check(bubbleCode.indexOf('sessions') < 0 && bubbleCode.indexOf('retain') < 0 && bubbleCode.indexOf('.binding') < 0 && codeOnly(pillSrc).indexOf('sessions') < 0 && codeOnly(itemViewSrc).indexOf('sessions') < 0, '守卫：气泡三片都不碰会话服务（只读订阅在取数层）')
    check(streamSrc.indexOf('SuggestBubble') >= 0, '接线：取数层的挂载组件把建议交给气泡')
    check(indexSrc.indexOf('leaf:suggestAppearance') >= 0 && indexSrc.indexOf('leaf:suggestStyles') >= 0 && indexSrc.indexOf('leaf:suggestItemView') >= 0 && indexSrc.indexOf('leaf:suggestPill') >= 0 && indexSrc.indexOf('leaf:suggestBubble') >= 0, '接线：五片叶子（外观、样式、条目洗形、选项画法、薄壳）在入口登记了拼接标记')
    check(indexSrc.indexOf('leaf:suggestItemView') < indexSrc.indexOf('leaf:suggestPill') && indexSrc.indexOf('leaf:suggestPill') < indexSrc.indexOf('leaf:suggestBubble'), '接线：拼接次序是条目洗形 → 选项画法 → 气泡薄壳（薄壳要调用前两片导出的函数）')
    check(indexSrc.indexOf('styles.insert(SUGGEST_STYLE_TEXT)') >= 0, '接线：气泡样式走同一个 styles.insert 接缝')
    check(buildSrc.indexOf("id: 'suggestAppearance'") >= 0 && buildSrc.indexOf("id: 'suggestStyles'") >= 0 && buildSrc.indexOf("id: 'suggestItemView'") >= 0 && buildSrc.indexOf("id: 'suggestPill'") >= 0 && buildSrc.indexOf("id: 'suggestBubble'") >= 0, '接线：五片叶子在构建清单登记')
    check(leavesSrc.indexOf('suggestAppearance.ts') >= 0 && leavesSrc.indexOf('suggestStyles.ts') >= 0 && leavesSrc.indexOf('suggestItemView.ts') >= 0 && leavesSrc.indexOf('suggestPill.ts') >= 0 && leavesSrc.indexOf('suggestBubble.ts') >= 0, '接线：五片叶子在叶子清单登记（单文件行数上限检查）')
  }

  if (failures.length) {
    console.log('verify-1411-suggest-bubble-look 失败项：')
    for (const item of failures) console.log('  - ' + item)
  }
  console.log('verify-1411-suggest-bubble-look：' + total + ' 条断言，' + failures.length + ' 条失败')
  printGateResult('verify-1411-suggest-bubble-look', total, failures.length ? 1 : 0)
  process.exit(failures.length ? 1 : 0)
}

main().catch(function (err: any) {
  console.log('verify-1411-suggest-bubble-look 异常：' + ((err && err.stack) || err))
  printGateResult('verify-1411-suggest-bubble-look', total, 1)
  process.exit(1)
})
