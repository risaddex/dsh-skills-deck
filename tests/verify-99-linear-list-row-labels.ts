// tests/verify-99-linear-list-row-labels.ts —— #99 门禁：列表行上的标签颜色与动作按钮，两类后端同一颗
// https://github.com/risaddex/dsh-skills-deck/issues/99
// 门禁归属: src/client/views/ListTabRow.ts, src/client/views/ListTab.ts, src/client/views/listFilterRow.ts
//
// 判据（都是用户在一行上看得见的东西）：
// 1. 标签带颜色时，行内那颗药丸就是后端给的那个颜色（Linear 回 #EB5757，归一后 eb5757）。
// 2. 标签没有颜色时画中性灰 cccccc（维护者在票里定的规则），不是界面强调紫 #bc8cff。
//    为什么这条对 Linear 才是问题：GitHub 的标签永远带色，这条兜底在 GitHub 工作区从不出场，
//    所以旧代码里的紫色只有 Linear 工作区看得见。
// 3. 同一个标签、同一个状态，Linear 形状的行（键是 ENG-99 这种文字）与 GitHub 形状的行（数字）
//    画出来的标签药丸与动作按钮完全一样 —— 这才是「与 GitHub 平权」这句话说得出口的依据。
// 4. 按钮的启用规则不随后端变：开着才有主动作按钮，关掉就两边都没有。
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-99-linear-list-row-labels.ts
// 做法：真组件静态渲染（react-dom/server），hexA / darken / 行级动作（row-actions）全走真实现；
//   只把渲染之外的宿主自由量接成最小假实现 —— 门禁自己抄一份取色或判定，就等于允许两边各判各的。
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let failures = 0
let total = 0
const check = (ok: any, msg: string) => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failures++ }

const G: any = globalThis
G.React = React
// row-actions.ts 是拼接进客户端闭包的叶子：它用的 h 来自同一个闭包，真机上是真的 hyperscript 造元素。
// 门禁单独加载它时这个名字得补上，否则按钮那一段根本画不出来（本门禁要比的正是按钮）。
G.h = React.createElement
G.tr = (key: any) => String(key)
G.emit = () => {}
G.Ic = (props: any) => '[icon:' + ((props && props.n) || '?') + ']'
G.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
G.chipProps = (props: any) => props
G.COPY_FLASH_MS = 1300

// ---- 颜色两个小函数与行级动作全部走真实现 ----
const colourMod: any = await import('../src/refresh/rooms/client/snapshot-sync-helpers.js')
G.hexA = colourMod.hexA
G.darken = colourMod.darken
const actionsMod: any = await import('../src/client/kernel/row-actions.js')
G.rowActionKind = actionsMod.rowActionKind
G.actionColorOf = actionsMod.actionColorOf
G.rowActionText = actionsMod.rowActionText

const identityMod: any = await import('../src/tracker/kernel/identity-keys.js')
G.idOf = identityMod.idOf
G.effortOf = identityMod.effortOf
G.idOfParts = identityMod.idOfParts
const linkMod: any = await import('../src/client/kernel/link.js')
G.issueUrlFor = linkMod.issueUrlFor
G.openModeFor = linkMod.openModeFor
G.openTrackerTarget = linkMod.openTrackerTarget
G.openIssueUrl = linkMod.openIssueUrl
G.rowNavKeyOf = (x: any) => (x && (x.key != null ? x.key : x.number))
const cv: any = await import('../src/client/kernel/container-view.js')
G.CONTAINER_ACCENT = cv.CONTAINER_ACCENT
G.containerKindOf = cv.containerKindOf
G.containerStateOf = cv.containerStateOf
G.containerTriState = cv.containerTriState
G.containerPromptText = cv.containerPromptText
G.findMapByIdentity = () => null
// 字色择优只决定按钮上的字是深还是白，不影响本门禁的三条判据；这里仍按同一条对比度口径算，
// 免得「按钮长得一样」靠的是一份随手写的假实现。
G.isLightHex = (hex: any) => {
  const hh = String(hex || '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hh)) return false
  const lin = (p: any) => { const v = parseInt(p, 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const L = 0.2126 * lin(hh.slice(0, 2)) + 0.7152 * lin(hh.slice(2, 4)) + 0.0722 * lin(hh.slice(4, 6))
  return 1.05 / (L + 0.05) > 4.5
}
G.mkRowAction = actionsMod.mkRowAction
G.inject = () => {}
G.openInNewSession = () => {}
G.setActiveIssue = () => {}
G.setActiveMap = () => {}
G.copyText = async () => true
G.showPop = () => {}
G.chipKeyDown = () => {}
G.fitAllTags = () => {}
G._tagsFpOf = new Map()
G.isEnabled = () => false
G.panelNow = () => 0
G.panelClock = {}
G.truthWriteWindowOpen = () => false
G.authorColor = () => '#7aa2f7'
G.promptText = () => '/implement'
G.startText = () => '/start'
G.renderTemplate = (name: any) => '/' + name

const labelMod: any = await import('../src/client/kernel/ticket-label.js')
G.ticketLabelOf = labelMod.ticketLabelOf
G.ticketLabelNodesOf = labelMod.ticketLabelNodesOf
G.TICKET_LABEL_MAX_WIDTH = labelMod.TICKET_LABEL_MAX_WIDTH
G.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.js')).ticketBadgeOf
const rowMod: any = await import('../src/client/views/ListTabRow.js')

const realConsoleError = console.error
function quiet<T>(fn: () => T): T {
  console.error = (...args: any[]) => {
    const msg = String((args && args[0]) || '')
    if (msg.indexOf('unique "key" prop') >= 0) return
    if (msg.indexOf('useLayoutEffect does nothing on the server') >= 0) return
    realConsoleError.apply(console, args)
  }
  try { return fn() } finally { console.error = realConsoleError }
}
function makeSt(issues: any[]) {
  return { snapshot: { issues: issues, maps: [], generatedMs: '2026-11-25T00:00:00Z' }, tab: 'list', stateFilter: 'open', lblFilters: [], effFilters: [], sortKey: 'updatedAt', sortDir: 'desc', rowFlash: {}, writeAt: {}, cwd: '/ws' } as any
}
// isOpen 是行的入参（列表页按状态池子决定画哪一段），不是从票面状态自己推的：
// 判据 4 要验的是「关掉的票不给动作按钮」，所以这里必须显式传 false 才叫真验了那一条。
function renderRow(x: any, isOpen: boolean = true) {
  const st = makeSt([x])
  return quiet(() => renderToStaticMarkup(rowMod.listIssueRow(React.createElement, st, x, isOpen, false, {}, {}, false)))
}

// 两个形状的行：同一批标签、同一个状态，只有身份不同 —— 这正是「换后端」在这张票里唯一改变的东西。
const LABELS = [{ name: 'bug', color: 'eb5757' }, { name: 'sem-cor', color: '' }]
const linearRow = { key: 'ENG-99', effortId: '', title: 'Linear 票', state: 'OPEN', labels: LABELS, type: 'issue', updatedAt: '2026-11-24T00:00:00Z', url: 'https://linear.app/acme/issue/ENG-99' }
const githubRow = { key: '99', number: 99, effortId: '', title: 'GitHub 票', state: 'OPEN', labels: LABELS, type: 'issue', updatedAt: '2026-11-24T00:00:00Z', url: 'https://github.com/risaddex/dsh-skills-deck/issues/99' }
const linearClosed = Object.assign({}, linearRow, { state: 'CLOSED' })
const githubClosed = Object.assign({}, githubRow, { state: 'CLOSED' })

/** 从渲染结果里取出某一段（行内标签那一段 / 按钮那一段）。 */
function partOf(html: string, part: string): string {
  const m = new RegExp('data-dsws-row-part="' + part + '"').exec(html)
  return m ? html.slice(m.index) : ''
}
/** 某颗标签药丸的行内 style 串：按名字定位，名字原样出现在 span 的正文里。 */
function chipStyleOf(html: string, name: string): string {
  const re = new RegExp('<span class="dsws-chip"[^>]*style="([^"]*)"[^>]*>' + name + '<', 'g')
  const m = re.exec(html)
  return m ? m[1] : ''
}
/** 渲染结果里的每一颗按钮，按「实心 / 幽灵 + 文字」记下来；只比用户看得见的部分。 */
function buttonTextsOf(html: string): string[] {
  const out: string[] = []
  const re = /<button class="([^"]*)"[\s\S]*?>([\s\S]*?)<\/button>/g
  let m: any
  while (m = re.exec(html)) {
    const text = String(m[2]).replace(/<[^>]+>/g, '').replace(/^\[icon:[^\]]*\]/, '').trim()
    out.push((m[1].indexOf('ghost') >= 0 ? 'ghost:' : 'primary:') + text)
  }
  return out
}

// ---- 判据 1：带颜色的标签就是后端那个颜色 ----
const linearHtml = renderRow(linearRow)
const bugStyle = chipStyleOf(linearHtml, 'bug')
check(bugStyle.indexOf('color:#eb5757') >= 0, '带颜色的标签画的是后端给的颜色（Linear 的 #EB5757 归一成 eb5757），实得 ' + JSON.stringify(bugStyle))
check(bugStyle.indexOf('rgba(235,87,87,0.18)') >= 0, '同一颗药丸的底色由同一个色值算出来（rgba(235,87,87,0.18)），实得 ' + JSON.stringify(bugStyle))

// ---- 判据 2：没有颜色的标签是中性灰 cccccc，不是强调紫 ----
const noColourStyle = chipStyleOf(linearHtml, 'sem-cor')
check(noColourStyle.indexOf('color:#cccccc') >= 0, '没有颜色的标签画中性灰 cccccc，实得 ' + JSON.stringify(noColourStyle))
check(noColourStyle.indexOf('rgba(204,204,204,.18)') >= 0, '没有颜色的标签底色也是中性灰，实得 ' + JSON.stringify(noColourStyle))
check(noColourStyle.indexOf('bc8cff') < 0 && noColourStyle.indexOf('188,140,255') < 0, '没有颜色的标签上不再出现界面强调紫 #bc8cff，实得 ' + JSON.stringify(noColourStyle))

// ---- 判据 3：两类后端画同一颗药丸、同一组按钮 ----
const githubHtml = renderRow(githubRow)
const linearTags = partOf(linearHtml, 'tags')
const githubTags = partOf(githubHtml, 'tags')
check(chipStyleOf(githubHtml, 'bug') === bugStyle, 'GitHub 形状的行画出同一颗带颜色的药丸（无后端分支）')
check(chipStyleOf(githubHtml, 'sem-cor') === noColourStyle, 'GitHub 形状的行画出同一颗无颜色的药丸')
check(linearTags.length > 0 && githubTags.length > 0, '两行都真的画了标签那一段（判据 3 不是空对空）')
const linearBtns = buttonTextsOf(partOf(linearHtml, 'buttons'))
const githubBtns = buttonTextsOf(partOf(githubHtml, 'buttons'))
check(JSON.stringify(linearBtns) === JSON.stringify(githubBtns), '同一个状态与同一批标签，两类后端的按钮集合与文字一样（Linear ' + JSON.stringify(linearBtns) + ' / GitHub ' + JSON.stringify(githubBtns) + '）')
check(actionsMod.rowActionKind(linearRow) === actionsMod.rowActionKind(githubRow), '按钮的判定阶梯不随后端变（两类都判成 ' + actionsMod.rowActionKind(linearRow) + '）')
check(actionsMod.actionColorOf(linearRow, { bug: 'eb5757' }) === actionsMod.actionColorOf(githubRow, { bug: 'eb5757' }), '按钮主色取的是同一个标签色（两类都 ' + actionsMod.actionColorOf(linearRow, { bug: 'eb5757' }) + '）')

// ---- 判据 4：启用规则一样 —— 关掉的票两类后端都不给主动作按钮 ----
const linearClosedBtns = buttonTextsOf(partOf(renderRow(linearClosed, false), 'buttons'))
const githubClosedBtns = buttonTextsOf(partOf(renderRow(githubClosed, false), 'buttons'))
check(JSON.stringify(linearClosedBtns) === JSON.stringify(githubClosedBtns), '关掉的票：两类后端的按钮集合一样（Linear ' + JSON.stringify(linearClosedBtns) + ' / GitHub ' + JSON.stringify(githubClosedBtns) + '）')
check(linearClosedBtns.filter((t) => t.indexOf('primary:') === 0).length === 0, '关掉的票：两类后端都不画主动作按钮')

console.log(failures === 0 ? '全部通过（' + total + ' 条）' : failures + '/' + total + ' 条失败')
process.exit(failures === 0 ? 0 : 1)
