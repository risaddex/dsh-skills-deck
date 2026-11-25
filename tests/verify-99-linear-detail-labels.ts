// tests/verify-99-linear-detail-labels.ts —— #99 门禁：票详情页上的标签颜色与顶栏按钮，两类后端同一颗
// https://github.com/risaddex/dsh-skills-deck/issues/99
// 门禁归属: src/client/views/IssueDetail.ts, src/client/views/PrTab.ts
//
// 判据（用户在详情页一眼看得见的）：
// 1. 标签带颜色时，详情页那颗药丸就是后端给的颜色（Linear 回 #EB5757，归一后 eb5757）。
// 2. 标签没有颜色时画中性灰 cccccc（维护者在票里定的规则），不是界面强调紫 #bc8cff ——
//    与列表行同一条规则，两处必须一样：列表里看到的颜色，点开详情不能换一个。
// 3. Linear 形状的票（键是 ENG-99 这种文字）与 GitHub 形状的票（数字）在同一个状态下，
//    详情页的标签药丸与顶栏按钮集合完全一样（无后端分支）。
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-99-linear-detail-labels.ts
// 做法：真组件（IssueDetail）静态渲染；取色走真实现 hexA / darken，详情投影、顶栏判据、编号徽标
//   都接真叶子 —— 门禁自己抄一份判据，就等于允许两边各判各的。
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let failures = 0
let total = 0
const check = (ok: any, msg: string) => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failures++ }

// ---- 同闭包全局量接桩：详情页单独加载时，这些名字在真机里由构建拼进同一个闭包 ----
const trFn = (key: any) => String(key)
globalThis.React = React
globalThis.tr = trFn
globalThis.emit = () => {}
globalThis.Ic = (props: any) => '[' + ((props && props.n) || '?') + ']'
const stateKindMod: any = await import('../src/client/views/shared/stateKind.js')
globalThis.prStateKind = stateKindMod.prStateKind
const gateMod: any = await import('../src/client/kernel/detail-top-gate.js')
globalThis.detailTopGate = gateMod.detailTopGate
const identityMod: any = await import('../src/tracker/kernel/identity-keys.js')
globalThis.effortOf = identityMod.effortOf
globalThis.idOfParts = identityMod.idOfParts
globalThis.idOf = identityMod.idOf
globalThis.effortNamesOf = () => []
globalThis.peekNav = () => null
globalThis.repoStr = () => ''
globalThis.useIssueDetailFold = () => null
globalThis.findMapByIdentity = () => null
globalThis.pushNav = () => {}
globalThis.popNav = () => {}
globalThis.fetchIssueDetail = () => {}
globalThis.inject = () => {}
globalThis.openInNewSession = () => {}
globalThis.copyText = async () => true
const linkMod: any = await import('../src/client/kernel/link.js')
globalThis.issueUrlFor = linkMod.issueUrlFor
globalThis.openIssueUrl = linkMod.openIssueUrl
globalThis.openTrackerTarget = linkMod.openTrackerTarget
globalThis.openModeFor = linkMod.openModeFor
const TipStub = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
globalThis.Tip = TipStub
globalThis.issueErrorViewOf = (await import('../src/client/views/issueDetailErrorView.js')).issueErrorViewOf
const projMod: any = await import('../src/client/views/shared/detailProjection.js')
globalThis.detailViewFor = projMod.detailViewFor
globalThis.knownBlockedNodes = projMod.knownBlockedNodes
const { DswsCtx, createCx } = await import('../src/client/kernel/ctx.js')
const { renderIssueDetailComments } = await import('../src/client/views/IssueDetailComments.js')
globalThis.renderIssueDetailComments = renderIssueDetailComments
globalThis.MOTION = (await import('../src/client/kernel/motion.js')).MOTION
const labelMod: any = await import('../src/client/kernel/ticket-label.js')
globalThis.ticketLabelOf = labelMod.ticketLabelOf
globalThis.ticketLabelNodesOf = labelMod.ticketLabelNodesOf
globalThis.TICKET_LABEL_MAX_WIDTH = labelMod.TICKET_LABEL_MAX_WIDTH
globalThis.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.js')).ticketBadgeOf

// ---- 取色与行级动作走真实现（详情顶栏那颗动作按钮与列表行共用同一份 row-actions）----
const colourMod: any = await import('../src/refresh/rooms/client/snapshot-sync-helpers.js')
globalThis.hexA = colourMod.hexA
globalThis.darken = colourMod.darken
globalThis.h = React.createElement
const actionsMod: any = await import('../src/client/kernel/row-actions.js')
globalThis.rowActionKind = actionsMod.rowActionKind
globalThis.actionColorOf = actionsMod.actionColorOf
globalThis.rowActionText = actionsMod.rowActionText
globalThis.mkRowAction = actionsMod.mkRowAction
const cv: any = await import('../src/client/kernel/container-view.js')
globalThis.CONTAINER_ACCENT = cv.CONTAINER_ACCENT
globalThis.containerKindOf = cv.containerKindOf
globalThis.containerStateOf = cv.containerStateOf
globalThis.containerTriState = cv.containerTriState
globalThis.containerPromptText = cv.containerPromptText
globalThis.promptText = () => '/implement'
globalThis.startText = () => '/start'
globalThis.renderTemplate = (name: any) => '/' + name
globalThis.isLightHex = (hex: any) => {
  const hh = String(hex || '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hh)) return false
  const lin = (p: any) => { const v = parseInt(p, 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const L = 0.2126 * lin(hh.slice(0, 2)) + 0.7152 * lin(hh.slice(2, 4)) + 0.0722 * lin(hh.slice(4, 6))
  return 1.05 / (L + 0.05) > 4.5
}

const { IssueDetail } = await import('../src/client/views/IssueDetail.js')
globalThis.DswsCtx = DswsCtx

const services = {
  slots: { register: () => () => {}, inject: (name: any, fn: any) => { try { fn() } catch (e) {} } },
  locale: { register: () => () => {}, bind: () => trFn },
  timer: { timeout: (fn: any, ms: any) => setTimeout(fn, ms) },
}
const fakeStore = { snapshot: null, sessionId: 'test', tab: 'list', cwd: '/ws', issuePath: { current: null, nodes: [] }, noRepoCard: { expanded: false } }
const fakeCx = createCx({
  ctx: { get: (k: any) => (services as any)[k], effect: (fn: any) => { const r = fn(); return typeof r === 'function' ? r : () => {} }, inject: (deps: any, cb: any) => { cb({ get: (k: any) => (services as any)[k] }); return { dispose: () => {} } } },
  h: React.createElement,
  rdom: {},
  storeSvc: { shared: fakeStore, stores: {}, makeStore: () => fakeStore, storeOf: () => fakeStore, emit: () => {}, sub: () => () => {}, useStore: () => fakeStore },
  localeSvc: services.locale,
  timer: services.timer,
  api: { call: async () => ({ ok: true }), inject: () => {}, copyText: async () => {} },
  router: { open: () => {}, toggle: () => {} },
} as any)

// React 静态渲染时会为「子元素数组缺 key」与「服务端跑 useLayoutEffect」打警告。这两类是现有标记的
// 既有噪音（真机浏览器里也一样），不是本门禁的判据；只静音这两类，其余警告照常打印。
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
function renderDetail(st: any): string {
  return quiet(() => renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: fakeCx }, React.createElement(IssueDetail, { st }))))
}
function stWithActive(activeIssue: any, row: any) {
  return { cwd: '/ws', activeIssue: activeIssue, activeEffortId: '', snapshot: { issues: [row], maps: [] }, issueMode: 'idle' } as any
}
/** 某颗标签药丸的行内 style 串：按标签名定位（名字原样出现在 span 的正文里）。 */
function chipStyleOf(html: string, name: string): string {
  const re = new RegExp('<span class="dsws-chip"[^>]*style="([^"]*)"[^>]*>' + name + '<', 'g')
  const m = re.exec(html)
  return m ? m[1] : ''
}
/** 顶栏那些按钮：按点击定位串收集，用来比「两类后端的按钮集合」是否一样。 */
function topButtonLogsOf(html: string): string[] {
  const out: string[] = []
  const re = /data-log="(issue\.top\.[a-z]+)"/g
  let m: any
  while (m = re.exec(html)) if (out.indexOf(m[1]) < 0) out.push(m[1])
  return out.sort()
}

const LABELS = [{ name: 'bug', color: 'eb5757' }, { name: 'sem-cor', color: '' }]
// 同一批标签、同一个状态，只有身份不同：Linear 的票号是 ENG-99 这种文字，GitHub 的是数字。
const LINEAR_ROW = { key: 'ENG-99', title: 'Linear 票', state: 'OPEN', labels: LABELS, url: 'https://linear.app/acme/issue/ENG-99' }
const GITHUB_ROW = { key: '99', number: 99, title: 'GitHub 票', state: 'OPEN', labels: LABELS, url: 'https://github.com/risaddex/dsh-skills-deck/issues/99' }

// ---- 判据 1：带颜色的标签就是后端那个颜色 ----
const linearHtml = renderDetail(stWithActive('ENG-99', LINEAR_ROW))
const bugStyle = chipStyleOf(linearHtml, 'bug')
check(bugStyle.indexOf('color:#eb5757') >= 0, '详情页带颜色的标签画的是后端给的颜色（eb5757），实得 ' + JSON.stringify(bugStyle))

// ---- 判据 2：没有颜色的标签是中性灰，不是强调紫 ----
const noColourStyle = chipStyleOf(linearHtml, 'sem-cor')
check(noColourStyle.indexOf('color:#cccccc') >= 0, '详情页没有颜色的标签画中性灰 cccccc，实得 ' + JSON.stringify(noColourStyle))
check(noColourStyle.indexOf('rgba(204,204,204,.18)') >= 0, '详情页没有颜色的标签底色也是中性灰，实得 ' + JSON.stringify(noColourStyle))
check(noColourStyle.indexOf('bc8cff') < 0 && noColourStyle.indexOf('188,140,255') < 0, '详情页没有颜色的标签上不再出现强调紫 #bc8cff，实得 ' + JSON.stringify(noColourStyle))

// ---- 判据 3：两类后端画同一颗药丸、同一组顶栏按钮 ----
const githubHtml = renderDetail(stWithActive(99, GITHUB_ROW))
check(chipStyleOf(githubHtml, 'bug') === bugStyle, 'GitHub 形状的票：详情页画出同一颗带颜色的药丸（无后端分支）')
check(chipStyleOf(githubHtml, 'sem-cor') === noColourStyle, 'GitHub 形状的票：详情页画出同一颗无颜色的药丸')
const linearTop = topButtonLogsOf(linearHtml)
const githubTop = topButtonLogsOf(githubHtml)
check(linearTop.length > 0 && JSON.stringify(linearTop) === JSON.stringify(githubTop), '两类后端的顶栏按钮集合一样（Linear ' + JSON.stringify(linearTop) + ' / GitHub ' + JSON.stringify(githubTop) + '）')

console.log(failures === 0 ? '全部通过（' + total + ' 条）' : failures + '/' + total + ' 条失败')
process.exit(failures === 0 ? 0 : 1)
