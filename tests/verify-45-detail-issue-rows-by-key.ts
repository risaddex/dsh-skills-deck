// tests/verify-45-detail-issue-rows-by-key.ts: the ticket detail page hands the text key to its parent map ribbon, sub-issue rows and blocked-by rows (#45).
//
// Why this gate exists: a Linear ticket key is text (OMB-903). The host fills a row's numeric `number` only when the key is all digits
// (GitHub "42", Markdown "01"), so a Linear row has a `key` and no usable `number` (a thin row can even carry a made-up 0). The ticket
// detail page (IssueDetail) drew its parent map ribbon, its sub-issue rows and its blocked-by rows from `number`, so a Linear ticket
// showed "#undefined" and a click pushed an empty value that the navigation refuses. This gate renders the REAL IssueDetail per shape
// and clicks what the user clicks. The sibling gates of the same family are verify-45-detail-routes-by-key, verify-45-detail-map-page-by-key
// and verify-45-detail-capsule-by-key; they share the stubs in tests/lib/verify-45-detail-env.ts.
// Rule under test: a row whose key is not all digits hands its text key; GitHub 42 and Markdown 01 hand their number exactly as before;
// the local container number 0 stays 0; a blocked-by node that carries its text key in `number` still hands that text.
// 门禁归属: src/client/views/IssueDetail.ts
// 门禁归属: src/client/views/subIssueRouting.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-detail-issue-rows-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'
import { g, show, urlOf, navCalls, copied, makeChecker, realConsoleError } from './lib/verify-45-detail-env.ts'

const { check, stats } = makeChecker()

console.log('B) IssueDetail: the parent map ribbon, the sub-issue rows and the blocked-by rows')
{
  g.effortNamesOf = () => []; g.repoStr = () => ''; g.useIssueDetailFold = () => null
  g.fetchIssueDetail = () => {}; g.peekNav = () => null
  g.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
  g.issueErrorViewOf = (await import('../src/client/views/issueDetailErrorView.ts')).issueErrorViewOf
  const proj = await import('../src/client/views/shared/detailProjection.ts')
  g.knownBlockedNodes = proj.knownBlockedNodes
  // The detail from a snapshot row has no sub-issue nodes; the test adds them the way a fetched detail carries them.
  g.detailViewFor = (st2: any, n: any, e: any) => { const p: any = proj.detailViewFor(st2, n, e); if (p && st2.subs) p.issue = Object.assign({}, p.issue || proj.detailFromRow(st2.snapshot.issues[0]), { subIssues: { totalCount: st2.subs.length, nodes: st2.subs } }); return p }
  g.detailTopGate = (await import('../src/client/kernel/detail-top-gate.ts')).detailTopGate
  g.prStateKind = (await import('../src/client/views/shared/stateKind.ts')).prStateKind
  const { DswsCtx, createCx } = await import('../src/client/kernel/ctx.ts')
  g.DswsCtx = DswsCtx
  g.renderIssueDetailComments = (await import('../src/client/views/IssueDetailComments.ts')).renderIssueDetailComments
  g.MOTION = (await import('../src/client/kernel/motion.ts')).MOTION
  const label = await import('../src/client/kernel/ticket-label.ts')
  g.ticketLabelOf = label.ticketLabelOf; g.ticketLabelNodesOf = label.ticketLabelNodesOf; g.TICKET_LABEL_MAX_WIDTH = label.TICKET_LABEL_MAX_WIDTH
  g.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.ts')).ticketBadgeOf
  const { IssueDetail } = await import('../src/client/views/IssueDetail.ts')

  const created: any[] = []
  const hRec = (type: any, props: any, ...kids: any[]) => { const el: any = React.createElement(type, props, ...kids); created.push(el); return el }
  const services: any = { slots: { register: () => () => {}, inject: (_n: any, fn: any) => { try { fn() } catch (e) {} } }, locale: { register: () => () => {}, bind: () => g.tr }, timer: { timeout: (fn: any, ms: any) => setTimeout(fn, ms) } }
  const fakeStore: any = { snapshot: null, sessionId: 'test', tab: 'list', cwd: 'D:\\ws', issuePath: { current: null, nodes: [] }, noRepoCard: { expanded: false } }
  const fakeCx: any = createCx({
    ctx: { get: (k: any) => services[k], effect: (fn: any) => { const r = fn(); return typeof r === 'function' ? r : () => {} }, inject: (_d: any, cb: any) => { cb({ get: (k: any) => services[k] }) } },
    h: hRec, rdom: {},
    storeSvc: { shared: fakeStore, stores: {}, makeStore: () => fakeStore, storeOf: () => fakeStore, emit: () => {}, sub: () => () => {}, useStore: () => fakeStore },
    localeSvc: services.locale, timer: services.timer,
    api: { call: async () => ({ ok: true }), inject: () => {}, copyText: async () => {} }, router: { open: () => {}, toggle: () => {} },
  } as any)
  const render = (st: any): string => { created.length = 0; return renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: fakeCx }, React.createElement(IssueDetail, { st }))) }
  const elOf = (log: string): any => created.find((e) => e && e.props && e.props['data-log'] === log)

  // B1: the parent map ribbon. `open` is what the navigation stack holds; the snapshot has the ticket row and a map listing it.
  type Ribbon = { name: string, open: any, row: any, mapTicket: any, map: any, wantLog: string, wantN: any, wantText: string }
  const RIBBONS: Ribbon[] = [
    { name: 'GitHub 42 under map 5', open: '42', row: { number: 42, key: '42', title: 'T-gh', state: 'OPEN', labels: [], url: urlOf('42') }, mapTicket: { number: 42, key: '42' }, map: { number: 5, key: '5', title: 'M5' }, wantLog: 'issue.parent.5', wantN: 5, wantText: '#5 M5' },
    { name: 'Markdown 01 under map 05', open: '1', row: { number: 1, key: '01', title: 'T-md', state: 'OPEN', labels: [], url: urlOf('01') }, mapTicket: { number: 1, key: '01' }, map: { number: 5, key: '05', title: 'M05' }, wantLog: 'issue.parent.5', wantN: 5, wantText: '#5 M05' },
    { name: 'Markdown 01 under the container 00', open: '1', row: { number: 1, key: '01', title: 'T-md', state: 'OPEN', labels: [], url: urlOf('01') }, mapTicket: { number: 1, key: '01' }, map: { number: 0, key: '00', title: 'M00' }, wantLog: 'issue.parent.0', wantN: 0, wantText: '#0 M00' },
    { name: 'Linear ENG-12 under map OMB-100 (map row has a key and no number)', open: 'ENG-12', row: { key: 'ENG-12', title: 'T-lin', state: 'OPEN', labels: [], url: urlOf('ENG-12') }, mapTicket: { key: 'ENG-12' }, map: { key: 'OMB-100', title: 'M100' }, wantLog: 'issue.parent.OMB-100', wantN: 'OMB-100', wantText: '#OMB-100 M100' },
    { name: 'Linear ENG-12 under map OMB-100 (number null)', open: 'ENG-12', row: { key: 'ENG-12', title: 'T-lin', state: 'OPEN', labels: [], url: urlOf('ENG-12') }, mapTicket: { key: 'ENG-12' }, map: { number: null, key: 'OMB-100', title: 'M100' }, wantLog: 'issue.parent.OMB-100', wantN: 'OMB-100', wantText: '#OMB-100 M100' },
    { name: 'Linear ENG-12 under map OMB-100 (number 0, as a thin row carries it)', open: 'ENG-12', row: { key: 'ENG-12', title: 'T-lin', state: 'OPEN', labels: [], url: urlOf('ENG-12') }, mapTicket: { key: 'ENG-12' }, map: { number: 0, key: 'OMB-100', title: 'M100' }, wantLog: 'issue.parent.OMB-100', wantN: 'OMB-100', wantText: '#OMB-100 M100' },
  ]
  for (const s of RIBBONS) {
    const st: any = { cwd: 'D:\\ws', activeIssue: s.open, activeEffortId: '', issueMode: 'idle', snapshot: { issues: [s.row], maps: [Object.assign({ tickets: [s.mapTicket], labels: [{ name: 'wayfinder:map' }] }, s.map)] } }
    const html = render(st)
    const ribbon = elOf(s.wantLog)
    check(!!ribbon, s.name + ': the ribbon anchor is drawn with the log name ' + s.wantLog)
    check(html.includes(s.wantText), s.name + ': the ribbon text reads "' + s.wantText + '"')
    navCalls.length = 0
    if (ribbon) ribbon.props.onClick({ preventDefault: () => {} })
    check(navCalls.length === 1 && navCalls[0].kind === 'map' && navCalls[0].n === s.wantN, s.name + ': clicking the ribbon pushes the map ' + show(s.wantN) + ' (it pushed ' + show(navCalls.map((x) => x.n)) + ')')
  }

  // B2: the sub-issue rows and the blocked-by rows.
  type Row = { name: string, node: any, wantLog: string, wantText: string, wantN: any }
  const SUBS: Row[] = [
    { name: 'sub GitHub 43', node: { number: 43, key: '43', title: 'S43', state: 'OPEN' }, wantLog: 'issue.sub.43', wantText: '#43', wantN: 43 },
    { name: 'sub Markdown 02 (number 2, key "02")', node: { number: 2, key: '02', title: 'S02', state: 'OPEN' }, wantLog: 'issue.sub.2', wantText: '#2', wantN: 2 },
    { name: 'sub Linear OMB-904 (key only)', node: { key: 'OMB-904', title: 'S904', state: 'OPEN' }, wantLog: 'issue.sub.OMB-904', wantText: '#OMB-904', wantN: 'OMB-904' },
    { name: 'sub Linear OMB-905 (number null)', node: { number: null, key: 'OMB-905', title: 'S905', state: 'OPEN' }, wantLog: 'issue.sub.OMB-905', wantText: '#OMB-905', wantN: 'OMB-905' },
  ]
  const BLOCKED: Row[] = [
    { name: 'blocked GitHub 7', node: { number: 7, title: 'B7', state: 'OPEN' }, wantLog: 'issue.blocked.7', wantText: '#7', wantN: 7 },
    { name: 'blocked node {number: "OMB-12"} (text key in number, no key)', node: { number: 'OMB-12', title: 'B12', state: 'OPEN' }, wantLog: 'issue.blocked.OMB-12', wantText: '#OMB-12', wantN: 'OMB-12' },
    { name: 'blocked Linear OMB-13 (key only)', node: { key: 'OMB-13', title: 'B13', state: 'OPEN' }, wantLog: 'issue.blocked.OMB-13', wantText: '#OMB-13', wantN: 'OMB-13' },
  ]
  const hostRow: any = { key: 'ENG-12', title: 'T-lin', state: 'OPEN', labels: [], url: urlOf('ENG-12'), blockedBy: BLOCKED.map((b) => b.node) }
  const stRows: any = { cwd: 'D:\\ws', activeIssue: 'ENG-12', activeEffortId: '', issueMode: 'idle', subs: SUBS.map((s) => s.node), snapshot: { issues: [hostRow], maps: [] } }
  const htmlRows = render(stRows)
  check(!htmlRows.includes('#undefined') && !htmlRows.includes('undefined'), 'the rows never draw "undefined" (a text key reads #OMB-904, not #undefined)')
  for (const r of SUBS.concat(BLOCKED)) {
    const rowEl = elOf(r.wantLog)
    check(!!rowEl, r.name + ': the row is drawn with the log name ' + r.wantLog)
    check(!!rowEl && rowEl.props['aria-label'] === r.wantText + ' ' + r.node.title, r.name + ': aria-label reads "' + r.wantText + ' ' + r.node.title + '" (got ' + show(rowEl && rowEl.props['aria-label']) + ')')
    check(htmlRows.includes('>' + r.wantText + '<'), r.name + ': the id badge shows ' + r.wantText)
    navCalls.length = 0
    if (rowEl) rowEl.props.onClick()
    check(navCalls.length === 1 && navCalls[0].n === r.wantN, r.name + ': clicking the row opens ' + show(r.wantN) + ' (it handed ' + show(navCalls.map((x) => x.n)) + ')')
  }
  // The copy button of the top bar already gets the text key from the stack
  copied.length = 0
  const copyEl = elOf('issue.top.copy')
  if (copyEl) copyEl.props.onClick({ stopPropagation: () => {} })
  check(copied.length === 1 && copied[0] === urlOf('ENG-12'), 'Linear ENG-12: the top bar copy button writes the ticket address (' + show(copied) + ')')
}

console.error = realConsoleError
printGateResult('verify-45-detail-issue-rows-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
