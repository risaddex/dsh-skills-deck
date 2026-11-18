// tests/verify-45-list-row-opens-by-key.ts: a list row hands its text key to the navigation, the copy and the link actions (#45).
//
// Why this gate exists: the Linear list drew (the badge reads `row.key`) but clicking a row did nothing, because the row click
// called setActiveIssue(st, x.number, ...) and a Linear row has no numeric `number`: the host sets `number` from the key only when
// parseInt gives a number. The navigation stack refuses an absent value, so nothing opened and nothing was said. Steps 1 to 4 of #45
// fixed the readers of the stack, and no gate called the code that feeds it. This one renders the real list row per backend shape and
// calls what the user clicks: the row, the copy button and the link button.
// Rule under test: a row with a numeric `number` passes exactly what it passed before (GitHub 42, Markdown 1); a row without one
// passes its text `key` (Linear OMB-903).
// 门禁归属: src/client/views/ListTabRow.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-list-row-opens-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const G: any = globalThis
G.React = React
G.tr = (key: any, params?: any): string => { let s = String(key); if (params) s = s.replace(/\{(\w+)\}/g, (m: string, n: string) => (n in params ? String(params[n]) : m)); return s }
G.emit = () => {}
G.Ic = (props: any) => '[icon:' + ((props && props.n) || '?') + ']'
G.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
G.chipProps = (props: any) => props
G.COPY_FLASH_MS = 1300
const identityMod = await import('../src/tracker/kernel/identity-keys.ts')
const linkMod = await import('../src/client/kernel/link.ts')
const { DswsCtx } = await import('../src/client/kernel/ctx.ts')
G.DswsCtx = DswsCtx
G.idOf = identityMod.idOf; G.effortOf = identityMod.effortOf
// link.ts reads idOfParts as a free name inside a try/catch: without it the lookup throws, is swallowed and the address comes back empty.
G.idOfParts = identityMod.idOfParts
G.issueUrlFor = linkMod.issueUrlFor; G.openModeFor = linkMod.openModeFor; G.openTrackerTarget = linkMod.openTrackerTarget
const cv: any = await import('../src/client/kernel/container-view.ts')
for (const n of ['containerKindOf', 'containerStateOf', 'containerTriState', 'containerNumberColor', 'containerTitleKey', 'containerPromptText', 'CONTAINER_ACCENT', 'CONTAINER_TINT', 'CONTAINER_EMPTY_COLOR', 'CONTAINER_DONE_COLOR', 'CONTAINER_CHIP_CLASS', 'CONTAINER_CHIP_LABEL_KEY', 'CONTAINER_CHIP_MARKER_CLASS']) G[n] = cv[n]
const { findMapByIdentity } = await import('../src/client/kernel/store-derived.ts')
G.findMapByIdentity = findMapByIdentity
G.inspectPrompt = () => '/wayfinder inspect'; G.completePrompt = () => '/wayfinder done'; G.startText = () => '/wayfinder start'; G.renderTemplate = () => '/x'
G.actionColorOf = () => '#c084fc'; G.isLightHex = () => false
G.mkRowAction = () => null; G.authorColor = () => '#7aa2f7'; G.darken = () => 'rgba(188,140,255,.6)'; G.hexA = () => 'rgba(188,140,255,.16)'
G.effortNamesOf = () => ['default']; G.effortOptionNamesOf = () => ['default']
G.chipKeyDown = () => {}; G.inject = () => {}; G.openInNewSession = () => {}; G.openHealthCheck = () => {}; G.promptTextFor = () => '/wayfinder'
G.showPop = () => {}; G.truthWriteWindowOpen = () => false; G.fitAllTags = () => {}; G._tagsFpOf = new Map(); G.isEnabled = () => false
G.panelNow = () => 0; G.panelClock = {}; G.chainSteps = () => []; G.compute = () => ([{ blocked: [], claimed: [] }])
G.openIssuesOf = (st: any) => ((st && st.snapshot && st.snapshot.issues) || []); G.isOccupied = () => false; G.mapBlockOf = () => ({})
G.labelClicks = {}; G.listPrefs = {}; G.saveLabelClicks = () => {}; G.saveListPrefs = () => {}
const label = await import('../src/client/kernel/ticket-label.ts')
G.ticketLabelOf = label.ticketLabelOf; G.ticketLabelNodesOf = label.ticketLabelNodesOf; G.TICKET_LABEL_MAX_WIDTH = label.TICKET_LABEL_MAX_WIDTH
G.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.ts')).ticketBadgeOf
// The row reads the shared rule from link.ts (rowNavKeyOf); a file loaded alone has no such name, so the gate wires the real one.
const prefs: any = await import('../src/client/kernel/link.ts')
G.rowNavKeyOf = prefs.rowNavKeyOf
const rowMod: any = await import('../src/client/views/ListTabRow.ts')

// What the row hands over is recorded, then compared. The copy button writes the clipboard text it was given.
const calls: any = { issue: [] as any[], map: [] as any[], copied: [] as any[], opened: [] as any[] }
G.setActiveIssue = (_st: any, n: any) => { calls.issue.push(n) }
G.setActiveMap = (_st: any, n: any) => { calls.map.push(n) }
G.copyText = async (_st: any, url: any) => { calls.copied.push(url); return true }

const created: any[] = []
const hRec = (type: any, props: any, ...kids: any[]) => { const el: any = React.createElement(type, props, ...kids); created.push(el); return el }
const realConsoleError = console.error
console.error = (...args: any[]) => { const m = String((args && args[0]) || ''); if (m.indexOf('unique "key" prop') >= 0 || m.indexOf('useLayoutEffect does nothing on the server') >= 0) return; realConsoleError.apply(console, args) }
const urlOf = (key: string) => 'https://tracker.example/issue/' + key
function draw(row: any, maps: any[]): { st: any, el: (log: string) => any } {
  const st: any = { snapshot: { issues: [row], maps, generatedMs: '2026-11-18T00:00:00Z' }, tab: 'list', stateFilter: 'open', lblFilters: [], effFilters: [], rowFlash: {}, writeAt: {}, cwd: '/ws', backendId: 'x' }
  created.length = 0
  renderToStaticMarkup(rowMod.listIssueRow(hRec, st, row, true, false, {}, {}, false))
  return { st, el: (log: string) => created.find((e) => e && e.props && e.props['data-log'] === log) }
}

// `want` is what the row click must hand over; `wantLog` names the row and the copy button (they already read the key);
// `wantLinkLog` names the link button, which today reads the number: its name must stay the same for a numeric row.
type Shape = { name: string, row: any, want: any, wantLog: string, wantLinkLog: string }
const SHAPES: Shape[] = [
  { name: 'GitHub 42 (number 42, key "42")', row: { number: 42, key: '42', title: 'T', state: 'OPEN', labels: [], url: urlOf('42') }, want: 42, wantLog: '42', wantLinkLog: '42' },
  { name: 'Markdown 01 (number 1, key "01")', row: { number: 1, key: '01', title: 'T', state: 'OPEN', labels: [], url: urlOf('01') }, want: 1, wantLog: '01', wantLinkLog: '1' },
  { name: 'Markdown container 00 (number 0, key "00")', row: { number: 0, key: '00', title: 'T', state: 'OPEN', labels: [], url: urlOf('00') }, want: 0, wantLog: '00', wantLinkLog: '0' },
  { name: 'Linear OMB-903 (no number)', row: { key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, want: 'OMB-903', wantLog: 'OMB-903', wantLinkLog: 'OMB-903' },
  { name: 'Linear OMB-903 (number null, as the host sends it)', row: { number: null, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, want: 'OMB-903', wantLog: 'OMB-903', wantLinkLog: 'OMB-903' },
  { name: 'Linear OMB-903 (number 0, as a thin row carries it)', row: { number: 0, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, want: 'OMB-903', wantLog: 'OMB-903', wantLinkLog: 'OMB-903' },
]
for (const s of SHAPES) {
  calls.issue.length = 0; calls.copied.length = 0
  const d = draw(s.row, [])
  const rowEl = d.el('list.row.' + s.wantLog)
  check(!!rowEl && typeof rowEl.props.onClick === 'function', s.name + ': the row is drawn with a click handler')
  if (rowEl) rowEl.props.onClick()
  check(calls.issue.length === 1 && calls.issue[0] === s.want, s.name + ': clicking the row opens the detail with ' + JSON.stringify(s.want) + ' (it handed over ' + JSON.stringify(calls.issue[0]) + ')')
  const copyEl = d.el('list.row.copy.' + s.wantLog)
  if (copyEl) copyEl.props.onClick({ stopPropagation: () => {} })
  await new Promise((r) => setTimeout(r, 0))
  check(calls.copied.length === 1 && calls.copied[0] === urlOf(s.wantLog), s.name + ': the copy button writes the ticket address (' + String(calls.copied[0]) + ')')
  const linkEl = d.el('list.row.link.' + s.wantLinkLog)
  check(!!linkEl && linkEl.props.href === urlOf(s.wantLog), s.name + ': the link button is drawn as list.row.link.' + s.wantLinkLog + ' and points at the ticket address')
}
// A Linear container (an exploration map) opens the map detail with its text key
{
  calls.map.length = 0; calls.issue.length = 0
  const row: any = { key: 'OMB-100', title: 'M', state: 'OPEN', type: 'map', labels: [{ name: 'wayfinder:map' }], url: urlOf('OMB-100'), tickets: [], stats: { total: 0, closed: 0 } }
  const d = draw(row, [row])
  const rowEl = d.el('list.row.OMB-100')
  if (rowEl) rowEl.props.onClick()
  check(calls.map.length === 1 && calls.map[0] === 'OMB-100' && calls.issue.length === 0, 'Linear map OMB-100: clicking the row opens the map detail with "OMB-100" (it handed over ' + JSON.stringify(calls.map[0]) + ')')
}
console.error = realConsoleError
// The shared rule itself (link.ts rowNavKeyOf), on the shapes every caller depends on
for (const c of [
  { name: 'GitHub row', r: { number: 42, key: '42' }, want: 42 },
  { name: 'Markdown row 01', r: { number: 1, key: '01' }, want: 1 },
  { name: 'Markdown container 00', r: { number: 0, key: '00' }, want: 0 },
  { name: 'number only', r: { number: 7 }, want: 7 },
  { name: 'key only, digits', r: { key: '7' }, want: '7' },
  { name: 'Linear without number', r: { key: 'OMB-903' }, want: 'OMB-903' },
  { name: 'Linear with number null', r: { number: null, key: 'OMB-903' }, want: 'OMB-903' },
  { name: 'Linear with the made-up number 0 of a thin row', r: { number: 0, key: 'OMB-903' }, want: 'OMB-903' },
  { name: 'blocked node carrying the text key in number', r: { number: 'OMB-12', title: 't' }, want: 'OMB-12' },
  { name: 'empty row', r: {}, want: undefined },
]) {
  const got = prefs.rowNavKeyOf(c.r)
  check(got === c.want, 'rowNavKeyOf: ' + c.name + ' gives ' + JSON.stringify(c.want) + ' (got ' + JSON.stringify(got) + ')')
}
check(prefs.rowNavKeyOf(null) === undefined && prefs.rowNavKeyOf(undefined) === undefined, 'rowNavKeyOf: a missing row gives undefined and does not throw')
printGateResult('verify-45-list-row-opens-by-key', assertions, failed)
if (failed) process.exit(1)
