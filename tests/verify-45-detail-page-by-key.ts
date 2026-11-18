// tests/verify-45-detail-page-by-key.ts: the detail page finds the open ticket by its text key for every backend (#45).
//
// Why this gate exists: step 1 of #45 made the navigation stack hold the key as text ("42", "01", "ENG-12"). The detail page
// compared that key strictly with a row's numeric `number`, so for GitHub and Markdown the row of the open ticket and the parent
// map ribbon stopped matching, and for Linear (no `number`, key not a number) the whole page returned nothing. The chain was green
// because no gate rendered the page with a text key. This one renders the real component, once per backend shape, and looks at what
// it drew: whether the page exists at all, whether the snapshot row was found (its title is drawn), and whether the parent map ribbon appears.
// 门禁归属: src/client/views/IssueDetail.ts
// 门禁归属: src/client/views/shared/detailProjection.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-detail-page-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const g: any = globalThis
g.React = React
g.tr = (key: any, params?: any): string => { let s = String(key); if (params) s = s.replace(/\{(\w+)\}/g, (m: string, n: string) => (n in params ? String(params[n]) : m)); return s }
g.emit = () => {}
g.Ic = (props: any) => '[' + ((props && props.n) || '?') + ']'
const identity = await import('../src/tracker/kernel/identity-keys.ts')
g.effortOf = identity.effortOf; g.idOfParts = identity.idOfParts; g.idOf = identity.idOf
g.effortNamesOf = () => []; g.repoStr = () => ''; g.useIssueDetailFold = () => null; g.findMapByIdentity = () => null
g.pushNav = () => {}; g.popNav = () => {}; g.fetchIssueDetail = () => {}; g.inject = () => {}; g.openInNewSession = () => {}; g.copyText = async () => true
g.peekNav = () => null
const link = await import('../src/client/kernel/link.ts')
g.issueUrlFor = link.issueUrlFor; g.openIssueUrl = link.openIssueUrl; g.openTrackerTarget = link.openTrackerTarget; g.openModeFor = link.openModeFor
g.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
g.issueErrorViewOf = (await import('../src/client/views/issueDetailErrorView.ts')).issueErrorViewOf
const proj = await import('../src/client/views/shared/detailProjection.ts')
g.detailViewFor = proj.detailViewFor; g.knownBlockedNodes = proj.knownBlockedNodes
const gateMod = await import('../src/client/kernel/detail-top-gate.ts'); g.detailTopGate = gateMod.detailTopGate
const stateKind = await import('../src/client/views/shared/stateKind.ts'); g.prStateKind = stateKind.prStateKind
const { DswsCtx, createCx } = await import('../src/client/kernel/ctx.ts')
const { renderIssueDetailComments } = await import('../src/client/views/IssueDetailComments.ts'); g.renderIssueDetailComments = renderIssueDetailComments
g.MOTION = (await import('../src/client/kernel/motion.ts')).MOTION
const label = await import('../src/client/kernel/ticket-label.ts')
g.ticketLabelOf = label.ticketLabelOf; g.ticketLabelNodesOf = label.ticketLabelNodesOf; g.TICKET_LABEL_MAX_WIDTH = label.TICKET_LABEL_MAX_WIDTH
g.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.ts')).ticketBadgeOf
const { IssueDetail } = await import('../src/client/views/IssueDetail.ts'); g.DswsCtx = DswsCtx

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
function render(st: any): string { created.length = 0; return renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: fakeCx }, React.createElement(IssueDetail, { st }))) }

// One state per backend. `open` is what the navigation stack now holds (a text key). The snapshot holds the row and a map that lists the ticket.
type Shape = { name: string, open: any, row: any, mapTickets: any[], mapNumber: any }
const SHAPES: Shape[] = [
  { name: 'GitHub 42', open: '42', row: { number: 42, key: '42', title: 'T-github', state: 'OPEN', labels: [] }, mapTickets: [{ number: 42, key: '42' }], mapNumber: 5 },
  { name: 'Markdown 01 (row key 01, stack 1)', open: '1', row: { number: 1, key: '01', title: 'T-markdown', state: 'OPEN', labels: [] }, mapTickets: [{ number: 1, key: '01' }], mapNumber: 5 },
  { name: 'Markdown container 00', open: '0', row: { number: 0, key: '00', title: 'T-container', state: 'OPEN', labels: [] }, mapTickets: [{ number: 0, key: '00' }], mapNumber: 5 },
  { name: 'Linear ENG-12', open: 'ENG-12', row: { key: 'ENG-12', title: 'T-linear', state: 'OPEN', labels: [] }, mapTickets: [{ key: 'ENG-12' }], mapNumber: 5 },
]
for (const s of SHAPES) {
  const st: any = { cwd: 'D:\\ws', activeIssue: s.open, activeEffortId: '', issueMode: 'idle', snapshot: { issues: [s.row], maps: [{ number: s.mapNumber, key: String(s.mapNumber), title: 'M', tickets: s.mapTickets, labels: [{ name: 'wayfinder:map' }] }] } }
  const html = render(st)
  const title = s.row.title
  check(html.length > 0, s.name + ': the page is drawn (it does not return nothing)')
  check(html.includes(title), s.name + ': the snapshot row of the open ticket is found (its title ' + title + ' is drawn)')
  check(created.some((el) => el && el.props && typeof el.props['data-log'] === 'string' && el.props['data-log'].indexOf('issue.parent.') === 0), s.name + ': the parent map ribbon is drawn')
}
// Two tickets of different teams with the same number must not be taken for each other
{
  const st: any = { cwd: 'D:\\ws', activeIssue: 'ENG-12', activeEffortId: '', issueMode: 'idle', snapshot: { issues: [{ key: 'OPS-12', title: 'T-ops', state: 'OPEN', labels: [] }, { key: 'ENG-12', title: 'T-eng', state: 'OPEN', labels: [] }], maps: [] } }
  const html = render(st)
  check(html.includes('T-eng') && !html.includes('T-ops'), 'Linear: ENG-12 and OPS-12 are two tickets; opening ENG-12 draws only ENG-12')
}
// Things that are not a key draw nothing, as before
for (const bad of [null, undefined, '', '  ', NaN]) {
  const st: any = { cwd: 'D:\\ws', activeIssue: bad, activeEffortId: '', issueMode: 'idle', snapshot: { issues: [], maps: [] } }
  check(render(st) === '', 'nothing is drawn when the open ticket is ' + (typeof bad === 'number' && Number.isNaN(bad) ? 'NaN' : JSON.stringify(bad)))
}
// The detail built from a snapshot row keeps what it kept for numeric keys and no longer writes NaN for a text key
for (const c of [
  { name: 'GitHub 42', row: { number: 42, key: '42', title: 'x' }, number: 42, key: '42' },
  { name: 'Markdown 01', row: { number: 1, key: '01', title: 'x' }, number: 1, key: '01' },
  { name: 'Markdown container 00', row: { number: 0, key: '00', title: 'x' }, number: 0, key: '00' },
  { name: 'Linear OMB-903', row: { key: 'OMB-903', title: 'x' }, number: 'OMB-903', key: 'OMB-903' },
  { name: 'Linear OMB-903 with a null number', row: { number: null, key: 'OMB-903', title: 'x' }, number: 'OMB-903', key: 'OMB-903' },
]) {
  const d: any = proj.detailFromRow(c.row)
  check(d.number === c.number && d.key === c.key, c.name + ': detailFromRow gives number ' + JSON.stringify(c.number) + ' and key ' + JSON.stringify(c.key) + ' (got ' + JSON.stringify(d.number) + ', ' + JSON.stringify(d.key) + ')')
}
printGateResult('verify-45-detail-page-by-key', assertions, failed)
if (failed) process.exit(1)
