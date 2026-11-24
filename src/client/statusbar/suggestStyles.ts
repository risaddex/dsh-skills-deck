// src/client/statusbar/suggestStyles.ts —— 「下一步建议」卡片的视觉语言（#1411；#97 改成一张卡片）
//
// 职责：只产出一段 CSS 文本（SUGGEST_STYLE_TEXT），由入口真源 src/client/index.ts 在
// kernel:styles 的同一个接缝上 styles.insert 一次。为什么另起一个样式叶子：kernel/styles.ts
// 已经贴着单文件 350 行上限（#851 先例，反馈样式 feedback-styles.ts 同款做法）。
//
// 看得见的颜色、尺寸与比例从 suggestAppearance 的 SUGGEST_APPEARANCE 取，动效时长从
// kernel/motion.ts 的 MOTION 取（#1236），本文件不写死；
// 深色主题走 C 版玻璃质感（半透明渐变、内高光、细描边），亮色主题在下面另给一组覆盖，
// 避免深色描边与高光在浅底上糊在一起。小泡（.dsws-sugg-bub）的节点由 suggestEngine 生成。
//
// #97 起整组是一张卡片（.dsws-sugg-card），挂在输入框上方的停靠栏里、占正常文档流：
// 主行、次行、选项行、详情区、关闭行从上到下排。详情区（.dsws-sugg-pop）也在流里 —— 它撑开卡片
// 往下长，不再绝对定位在按钮上方，所以这里没有位移变量，也不需要「夹回视口」那一套。
//
// 契约（与仓库其它叶子文件同一套）：模块真源是 ESM 导出，构建时剥掉行首 export 拼进 apply
// 闭包；运行时不许跨文件 import；不许 export default；只写可剥离的 TypeScript。
declare const SUGGEST_APPEARANCE: any;
declare const MOTION: any; // #1236 动效时长统一在 kernel/motion.ts，本文件只引用不写真值

/** 建议卡片的全部样式（字符串在模块求值时拼好，所以外观叶子必须排在它之前）。 */
export const SUGGEST_STYLE_TEXT: string = [
  // 整组：一张卡片，竖排四块（主行、次行、选项行、详情区、关闭行）。卡片自己占正常文档流，
  // 不再挂页面浮层，所以这里没有 position:fixed、没有 z-index；左边对齐，读起来才像一张卡。
  '.dsws-sugg-layer{display:flex;flex-direction:column;align-items:stretch;gap:' + SUGGEST_APPEARANCE.groupGapPx + 'px;text-align:left}',
  // 卡片框本体：圆角、内边距、描边与玻璃底。尺寸都从外观旋钮取，改外观只改那一处。
  '.dsws-sugg-card{box-sizing:border-box;padding:' + SUGGEST_APPEARANCE.cardPadY + 'px ' + SUGGEST_APPEARANCE.cardPadX + 'px;border-radius:' + SUGGEST_APPEARANCE.cardRadiusPx + 'px;border:1px solid ' + SUGGEST_APPEARANCE.pillBorder + ';background:' + SUGGEST_APPEARANCE.pillBg + ';box-shadow:' + SUGGEST_APPEARANCE.pillShadow + ';backdrop-filter:blur(' + SUGGEST_APPEARANCE.pillBlurPx + 'px) saturate(1.2);-webkit-backdrop-filter:blur(' + SUGGEST_APPEARANCE.pillBlurPx + 'px) saturate(1.2)}',
  // 主行：这是什么（粗一点、大一档），右边带条数小胶囊。
  '.dsws-sugg-head{display:flex;align-items:baseline;gap:6px;min-width:0}',
  '.dsws-sugg-title{font-size:' + SUGGEST_APPEARANCE.headFontPx + 'px;line-height:1.35;font-weight:700;color:var(--dsw-alias-label-primary,#e6edf3)}',
  '.dsws-sugg-count{flex:none;padding:0 6px;border-radius:999px;border:1px solid ' + SUGGEST_APPEARANCE.pillBorder + ';color:var(--dsw-alias-label-caption,#8b8b95);font-size:' + SUGGEST_APPEARANCE.subFontPx + 'px;line-height:1.5;font-weight:600}',
  // 次行：怎么用。比主行小半档、颜色更淡，扫一眼先读主行。
  '.dsws-sugg-sub{font-size:' + SUGGEST_APPEARANCE.subFontPx + 'px;line-height:1.5;color:var(--dsw-alias-label-caption,#8b8b95)}',
  // 选项行：横排，窄栏自动换行；每颗按钮自己收宽度，不把整行撑出卡片。左对齐（卡片是左对齐的）。
  '.dsws-sugg-row{position:relative;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:' + SUGGEST_APPEARANCE.pillGapPx + 'px;max-width:100%;pointer-events:none}',
  // 选项药丸：C 版玻璃质感（渐变底、内高光、细描边、文字投影）；框里只印简介（#1451 后续），
  // 完整提示词点选时才填进输入框。单行省略留着兜底（旧事件没有简介时退回显示提示词）。
  '.dsws-sugg-pill{position:relative;pointer-events:auto;box-sizing:border-box;max-width:' + SUGGEST_APPEARANCE.pillMaxWidthPx + 'px;font:inherit;font-size:' + SUGGEST_APPEARANCE.pillFontPx + 'px;line-height:' + SUGGEST_APPEARANCE.pillLineHeight + ';padding:' + SUGGEST_APPEARANCE.pillPadY + 'px ' + SUGGEST_APPEARANCE.pillPadX + 'px;border-radius:' + SUGGEST_APPEARANCE.pillRadiusPx + 'px;border:1px solid ' + SUGGEST_APPEARANCE.pillBorder + ';background:' + SUGGEST_APPEARANCE.pillBg + ';color:var(--dsw-alias-label-primary,#e6edf3);box-shadow:' + SUGGEST_APPEARANCE.pillShadow + ';text-shadow:' + SUGGEST_APPEARANCE.pillTextShadow + ';cursor:pointer;backdrop-filter:blur(' + SUGGEST_APPEARANCE.pillBlurPx + 'px) saturate(1.2);-webkit-backdrop-filter:blur(' + SUGGEST_APPEARANCE.pillBlurPx + 'px) saturate(1.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background ' + MOTION.suggestPillMs + 'ms ease,border-color ' + MOTION.suggestPillMs + 'ms ease,box-shadow ' + MOTION.suggestPillMs + 'ms ease}',
  // 左上角那团柔光：C 版药丸的「玻璃反光」，不参与布局、不吃事件。
  '.dsws-sugg-pill::before{content:"";position:absolute;left:4%;top:0;width:56%;height:50%;border-radius:50%;pointer-events:none;background:radial-gradient(ellipse 62% 58% at 34% 28%,rgba(255,255,255,.20),transparent 72%)}',
  '.dsws-sugg-pill:hover{border-color:' + SUGGEST_APPEARANCE.pillHoverBorder + ';box-shadow:' + SUGGEST_APPEARANCE.pillHoverShadow + '}',
  '.dsws-sugg-pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#58a6ff));outline-offset:2px}',
  // 简介这段：说清这一步做什么，加粗；它是框里唯一的文字。
  '.dsws-sugg-intro{font-weight:600;letter-spacing:.01em}',
  // 选项框的定位壳：一颗建议的边界（鼠标进入、键盘聚焦都按它算）。#97 起详情区在卡片里占一块地方，
  // 这里不再当绝对定位的锚点，只留一颗建议自己的盒子。
  '.dsws-sugg-pill-wrap{position:relative;display:inline-flex;pointer-events:auto}',
  // 详情区：四行「推荐分 / 理由 / 优点 / 缺点」，在选项行下面占卡片自己的一块地方，撑开卡片往下长。
  // 为什么不再绝对定位、不再夹回视口：#97 之前它浮在按钮正上方，必须靠两条位移变量躲开视口边界；
  // 现在它是流里的一块，宽度取卡片内宽（上限仍是外观旋钮的 popMaxWidthPx），不会溢出任何人的边界。
  // 默认显示第一条（推荐分最高那条），换一条由组件换内容，不换节点。
  '.dsws-sugg-pop{box-sizing:border-box;width:100%;max-width:' + SUGGEST_APPEARANCE.popMaxWidthPx + 'px;padding:' + SUGGEST_APPEARANCE.popPadY + 'px ' + SUGGEST_APPEARANCE.popPadX + 'px;border-radius:' + SUGGEST_APPEARANCE.popRadiusPx + 'px;border:1px solid ' + SUGGEST_APPEARANCE.pillBorder + ';background:' + SUGGEST_APPEARANCE.popBg + ';color:' + SUGGEST_APPEARANCE.popText + ';box-shadow:' + SUGGEST_APPEARANCE.pillShadow + ';font-size:' + SUGGEST_APPEARANCE.pillFontPx + 'px;line-height:1.5;text-align:left;white-space:normal;opacity:1;display:block;z-index:1}',
  // #1834：详情节点带着 role="tooltip"（读屏的 aria-describedby 依赖它，不能删）。宿主样式表里有一条
  // body [role="tooltip"]{color:...}（深色主题给 tooltip 的浅色文字），特异性 (0,1,1) 压过上面
  // .dsws-sugg-pop 的 (0,1,0)，把浮层自己写的深色文字色顶掉了。这里把颜色单独写成带属性选择器的规则，
  // 抬到 (0,2,0)，宿主那条就压不动；右列正文另有 .dsws-sugg-pop-value 的显式颜色兜底。
  '.dsws-sugg-pop[role="tooltip"]{color:' + SUGGEST_APPEARANCE.popText + '}',
  // 浮层里的四行：左边一列深色标签（推荐分/理由/优点/缺点），右边正文；标签列固定宽，几行对齐。
  '.dsws-sugg-pop-row{display:grid;grid-template-columns:3.2em auto;column-gap:' + SUGGEST_APPEARANCE.popLabelGapPx + 'px;align-items:baseline}',
  '.dsws-sugg-pop-row + .dsws-sugg-pop-row{margin-top:' + SUGGEST_APPEARANCE.popRowGapPx + 'px}',
  '.dsws-sugg-pop-label{color:' + SUGGEST_APPEARANCE.popLabelText + ';font-weight:600}',
  // #1834：正文显式给深色，不再只靠从浮层继承——浮层的颜色可能被宿主规则压掉，继承链一断正文就发白。
  '.dsws-sugg-pop-value{white-space:normal;color:' + SUGGEST_APPEARANCE.popText + '}',
  // 关闭按钮行：占卡片最后一行，靠右 —— 卡片左对齐，关闭是收尾动作，放右边不挡阅读顺序。
  // #1787 现象⑥：按钮改成实心芯片（深色主题浅芯片配深字），空闲就完全不透明；
  // 以前是透明底 + 主题次要色 + 0.6 透明度，看起来几乎不存在。
  '.dsws-sugg-xrow{position:relative;z-index:2;display:flex;justify-content:flex-end;margin-top:' + SUGGEST_APPEARANCE.closeRowMarginTopPx + 'px;pointer-events:none}',
  '.dsws-sugg-close{pointer-events:auto;font:inherit;font-size:' + SUGGEST_APPEARANCE.closeFontPx + 'px;line-height:1.5;padding:' + SUGGEST_APPEARANCE.closePadY + 'px ' + SUGGEST_APPEARANCE.closePadX + 'px;border-radius:' + SUGGEST_APPEARANCE.pillRadiusPx + 'px;border:1px solid ' + SUGGEST_APPEARANCE.closeBorder + ';background:' + SUGGEST_APPEARANCE.closeBg + ';color:' + SUGGEST_APPEARANCE.closeText + ';cursor:pointer;opacity:' + SUGGEST_APPEARANCE.closeIdleOpacity + ';transition:opacity ' + MOTION.suggestCloseMs + 'ms ease,background ' + MOTION.suggestCloseMs + 'ms ease,border-color ' + MOTION.suggestCloseMs + 'ms ease}',
  '.dsws-sugg-close:hover{opacity:1;background:' + SUGGEST_APPEARANCE.closeHoverBg + '}',
  '.dsws-sugg-close:focus-visible{opacity:1;outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#58a6ff));outline-offset:2px}',
  // 小泡：绝对定位于整组之内，落在选项行下面一层（z-index 1），由引擎逐颗安排出发与落点。
  '.dsws-sugg-bub{position:absolute;z-index:1;left:0;top:0;border-radius:50%;pointer-events:none;background:' + SUGGEST_APPEARANCE.bubbleBg + ';border:1px solid ' + SUGGEST_APPEARANCE.bubbleBorder + ';box-shadow:' + SUGGEST_APPEARANCE.bubbleGlow + ';opacity:0;will-change:transform,opacity}',
  // 关闭与第二组覆盖的退场：整组淡出；选中一条的退场不再走整组 CSS 动画，
  // 改由引擎按每颗胶囊的位置生成小泡向上飘走（见 suggestEngine 的 playOut('pick')）。
  '@keyframes dsws-sugg-fade{to{opacity:0}}',
  '.dsws-sugg-layer.dsws-sugg-fading{animation:dsws-sugg-fade ' + MOTION.suggestFadeMs + 'ms ease-in forwards}',
  // 读屏专用播报节点：视觉上不占位，只让读屏软件念出「有几条建议」。
  '.dsws-sugg-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}',
  // 亮色主题：玻璃质感换成浅底半透明，去掉深色文字投影（深色主题保持 C 版原样）。
  'body:not([data-ds-dark-theme]) .dsws-sugg-card{background:' + SUGGEST_APPEARANCE.lightPillBg + ';border-color:' + SUGGEST_APPEARANCE.lightPillBorder + ';box-shadow:' + SUGGEST_APPEARANCE.lightPillShadow + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-pill{background:' + SUGGEST_APPEARANCE.lightPillBg + ';border-color:' + SUGGEST_APPEARANCE.lightPillBorder + ';box-shadow:' + SUGGEST_APPEARANCE.lightPillShadow + ';text-shadow:none}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-pill:hover{border-color:' + SUGGEST_APPEARANCE.lightPillHoverBorder + ';box-shadow:' + SUGGEST_APPEARANCE.lightPillHoverShadow + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-pop{background:' + SUGGEST_APPEARANCE.lightPopBg + ';border-color:' + SUGGEST_APPEARANCE.lightPillBorder + ';box-shadow:' + SUGGEST_APPEARANCE.lightPillShadow + '}',
  // 亮色主题的详情区文字：基础规则里的 popText / popLabelText 现在是深色主题用的浅色，亮色主题必须自己再给一对深色，
  // 否则浅色字落在近白底上看不见。选择器带 [role="tooltip"] 与 body:not(...) 前缀，特异性高过宿主的 body [role="tooltip"] 规则（#1834）。
  'body:not([data-ds-dark-theme]) .dsws-sugg-pop[role="tooltip"]{color:' + SUGGEST_APPEARANCE.lightPopText + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-pop-label{color:' + SUGGEST_APPEARANCE.lightPopLabelText + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-pop-value{color:' + SUGGEST_APPEARANCE.lightPopText + '}',
  // #1787 现象⑥：亮色主题的关闭按钮换成深芯片配浅「×」，与深色主题的浅芯片互为反色。
  'body:not([data-ds-dark-theme]) .dsws-sugg-close{background:' + SUGGEST_APPEARANCE.lightCloseBg + ';color:' + SUGGEST_APPEARANCE.lightCloseText + ';border-color:' + SUGGEST_APPEARANCE.lightCloseBorder + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-close:hover{background:' + SUGGEST_APPEARANCE.lightCloseHoverBg + '}',
  'body:not([data-ds-dark-theme]) .dsws-sugg-bub{background:' + SUGGEST_APPEARANCE.lightBubbleBg + ';border-color:' + SUGGEST_APPEARANCE.lightBubbleBorder + ';box-shadow:' + SUGGEST_APPEARANCE.lightBubbleGlow + '}',
  // 系统要求减少动效：去掉过渡与淡出动画（小泡由引擎直接跳过）。
  '@media (prefers-reduced-motion: reduce){.dsws-sugg-pill,.dsws-sugg-close,.dsws-sugg-pop{transition:none}.dsws-sugg-layer.dsws-sugg-fading{animation-duration:' + MOTION.motionOffMs + 'ms}}',
].join('\n')
