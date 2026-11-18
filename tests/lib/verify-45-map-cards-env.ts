// tests/lib/verify-45-map-cards-env.ts: the shared environment of the verify-45-map-cards-by-key and verify-45-ticket-row-by-key gates (#45).
//
// Why this file exists: the two gates used to be one 21 KB file. They were split by what they exercise (the map detail page and its
// buttons; the ticket row and the fallback without the shared helper), and everything they both need moved here: the global stubs
// the built client closure normally provides, the dynamic imports of the REAL views, the fake client context, the recorders (`rec`)
// that capture what the page hands to the navigation, the clipboard, the host and the input box, and `drawMap`, which renders the
// real map detail page for one row shape.
//
// Importing this file has side effects on purpose: it installs the globals on `globalThis`. Each gate file runs in its own process,
// so nothing leaks between gates. A section that must delete a global (the fallback without rowNavKeyOf) does it inside its own gate.
//
// How a gate uses it:
//   import { G, rec, SHAPES, drawMap, elOf, makeChecker, realConsoleError } from './lib/verify-45-map-cards-env.ts'
//   const { check, stats } = makeChecker()
//   ...sections...
//   console.error = realConsoleError
//   printGateResult('verify-45-xxx', stats.assertions, stats.failed)
//   if (stats.failed) process.exit(1)
// `check` counts per gate file (each call to makeChecker keeps its own counter), so each gate's own GATE-RESULT line is correct.
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Creates one assertion counter. `stats` is live: read it after the last check, when the gate prints its GATE-RESULT line. */
export function makeChecker(): { check: (ok: boolean, msg: string) => void, stats: { assertions: number, failed: number } } {
  const stats = { assertions: 0, failed: 0 }
  const check = (ok: boolean, msg: string): void => { stats.assertions += 1; if (!ok) stats.failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }
  return { check, stats }
}

export const G: any = globalThis
G.React = React
// The stub translator keeps the parameters in its output (`key@n=OMB-903`), so a tooltip that was handed `undefined` reads `n=undefined`.
G.tr = (key: any, params?: any): string => String(key) + (params ? '@' + Object.keys(params).map((k) => k + '=' + String(params[k])).join(',') : '')
G.emit = () => {}
G.Ic = (props: any) => '[icon:' + ((props && props.n) || '?') + ']'
G.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
G.COPY_FLASH_MS = 1300
export const identityMod = await import('../../src/tracker/kernel/identity-keys.ts')
export const linkMod = await import('../../src/client/kernel/link.ts')
export const { DswsCtx, createCx } = await import('../../src/client/kernel/ctx.ts')
G.DswsCtx = DswsCtx
G.idOf = identityMod.idOf; G.effortOf = identityMod.effortOf; G.idOfParts = identityMod.idOfParts
G.issueUrlFor = linkMod.issueUrlFor; G.openModeFor = linkMod.openModeFor; G.openTrackerTarget = linkMod.openTrackerTarget
const cv: any = await import('../../src/client/kernel/container-view.ts')
for (const n of ['containerKindOf', 'containerStateOf', 'containerTriState', 'containerNumberColor', 'containerTitleKey', 'containerPromptText', 'containerCountKey', 'CONTAINER_ACCENT', 'CONTAINER_TINT', 'CONTAINER_EMPTY_COLOR', 'CONTAINER_DONE_COLOR', 'CONTAINER_CHIP_CLASS', 'CONTAINER_CHIP_LABEL_KEY', 'CONTAINER_CHIP_MARKER_CLASS']) G[n] = cv[n]
G.findMapByIdentity = (await import('../../src/client/kernel/store-derived.ts')).findMapByIdentity
const label = await import('../../src/client/kernel/ticket-label.ts')
G.ticketLabelOf = label.ticketLabelOf; G.ticketLabelNodesOf = label.ticketLabelNodesOf; G.TICKET_LABEL_MAX_WIDTH = label.TICKET_LABEL_MAX_WIDTH
G.ticketBadgeOf = (await import('../../src/client/views/shared/ticketBadge.ts')).ticketBadgeOf
// The shared helper is loaded the way the built closure has it (a free name); verify-45-ticket-row-by-key also checks the views survive without it.
G.rowNavKeyOf = (await import('../../src/client/kernel/link.ts')).rowNavKeyOf
G.effortNamesOf = () => ['default']
G.mkRowAction = () => null; G.actionColorOf = () => '#7aa2f7'; G.isLightHex = () => false; G.buildColorOf = () => () => '#7aa2f7'
G.TypeChip = () => null; G.tProgressBar = () => null; G.tStatusBadge = () => null; G.blockerNames = () => ''
G.hexA = () => 'rgba(1,1,1,.1)'; G.openInNewSession = () => {}; G.mdToHtml = (s: any) => String(s == null ? '' : s)
G.popNav = () => {}

// What the page hands over is recorded, then compared.
export const rec: any = { push: [] as any[], copied: [] as any[], toast: [] as any[], injected: [] as string[], host: [] as any[], fold: [] as any[] }
G.pushNav = (_st: any, kind: any, n: any) => { rec.push.push({ kind, n }) }
G.copyText = async (_st: any, url: any, toast: any) => { rec.copied.push(url); rec.toast.push(toast); return true }
G.inject = (_st: any, text: any) => { rec.injected.push(String(text)) }
G.host = { call: (method: any, args: any) => { rec.host.push({ method, args }); return Promise.resolve({ ok: true }) } }
G.useIssueDetailFold = (_st: any, n: any) => { rec.fold.push(n); return null }
// Prompt builders: the marker shows which ticket the prompt names, and which template was chosen.
G.inspectPrompt = (_st: any, n: any) => 'INSPECT:' + String(n)
G.completePrompt = (_st: any, n: any) => 'COMPLETE:' + String(n)
G.startText = (_st: any, t: any) => 'START:' + String(t && t.number)
G.promptTextFor = (_st: any, id: any, v: any) => 'FOR:' + String(id) + ':' + String(v && v.url)

export const { MapDetail } = await import('../../src/client/views/MapDetail.ts')
export const { TicketRow } = await import('../../src/client/views/TicketRow.ts')
G.MapDetailHead = (await import('../../src/client/views/MapDetailHead.ts')).MapDetailHead
G.MapDetailTop = (await import('../../src/client/views/MapDetailTop.ts')).MapDetailTop
G.DetailActionBar = (await import('../../src/client/views/DetailActionBar.ts')).DetailActionBar

const created: any[] = []
const hRec = (type: any, props: any, ...kids: any[]) => { const el: any = React.createElement(type, props, ...kids); created.push(el); return el }
export const realConsoleError = console.error
console.error = (...args: any[]) => { const m = String((args && args[0]) || ''); if (m.indexOf('unique "key" prop') >= 0 || m.indexOf('useLayoutEffect does nothing on the server') >= 0) return; realConsoleError.apply(console, args) }
const services: any = {
  slots: { register: () => () => {}, inject: () => {} },
  locale: { register: () => () => {}, bind: () => G.tr },
  timer: { timeout: (fn: any, ms: number) => setTimeout(fn, ms) },
}
const fakeStore: any = { snapshot: null, sessionId: 'test', tab: 'list', cwd: '/ws', issuePath: { current: null, nodes: [] }, noRepoCard: { expanded: false } }
export const cx = createCx({
  ctx: { get: (k: string) => services[k], effect: (fn: any) => { const r = fn(); return typeof r === 'function' ? r : () => {} }, inject: (_d: any, cb: any) => { cb({ get: (k: string) => services[k] }); return { dispose: () => {} } } },
  h: hRec,
  rdom: {},
  storeSvc: { shared: fakeStore, stores: {}, makeStore: () => fakeStore, storeOf: () => fakeStore, emit: () => {}, sub: () => () => {}, useStore: () => fakeStore },
  localeSvc: services.locale,
  timer: services.timer,
  api: { call: async () => ({ ok: true }), inject: () => {}, copyText: async () => {} },
  router: { open: () => {}, toggle: () => {} },
})
export const tick = () => new Promise((r) => setTimeout(r, 0))
export const urlOf = (key: string, urlKind: string) => urlKind === 'http' ? 'https://tracker.example/issue/' + key : '/ws/tickets/' + key + '.md'
export const reset = () => { created.length = 0; rec.push.length = 0; rec.copied.length = 0; rec.toast.length = 0; rec.injected.length = 0; rec.host.length = 0; rec.fold.length = 0 }
export const elOf = (log: string) => created.find((e) => e && e.props && e.props['data-log'] === log)
export const tipsOf = () => created.filter((e) => e && e.type === G.Tip).map((e) => String(e.props.content))
export const ev = { stopPropagation: () => {} }

// A shape is three rows (the ticket under test, a sub-map card next to it, and the map page that holds them) plus what each must hand over.
export type Shape = { name: string, child: any, sub: any, map: any, childWant: any, subWant: any, mapWant: any }
export const SHAPES: Shape[] = [
  { name: 'GitHub 42 / 43 / 50 (number, key "42" / "43" / "50")', child: { number: 42, key: '42' }, sub: { number: 43, key: '43' }, map: { number: 50, key: '50' }, childWant: 42, subWant: 43, mapWant: 50 },
  { name: 'Markdown 01 / 07 / 02 (number 1 / 7 / 2, key "01" / "07" / "02")', child: { number: 1, key: '01' }, sub: { number: 7, key: '07' }, map: { number: 2, key: '02' }, childWant: 1, subWant: 7, mapWant: 2 },
  { name: 'Markdown container 00 as the ticket (number 0, key "00")', child: { number: 0, key: '00' }, sub: { number: 8, key: '08' }, map: { number: 3, key: '03' }, childWant: 0, subWant: 8, mapWant: 3 },
  { name: 'Markdown container 00 as the map page (number 0, key "00")', child: { number: 5, key: '05' }, sub: { number: 9, key: '09' }, map: { number: 0, key: '00' }, childWant: 5, subWant: 9, mapWant: 0 },
  { name: 'Linear OMB-903 under OMB-100 (no number)', child: { key: 'OMB-903' }, sub: { key: 'OMB-904' }, map: { key: 'OMB-100' }, childWant: 'OMB-903', subWant: 'OMB-904', mapWant: 'OMB-100' },
  { name: 'Linear OMB-903 under OMB-100 (number null, as the host sends it)', child: { number: null, key: 'OMB-903' }, sub: { number: null, key: 'OMB-904' }, map: { number: null, key: 'OMB-100' }, childWant: 'OMB-903', subWant: 'OMB-904', mapWant: 'OMB-100' },
  { name: 'Linear OMB-903 under OMB-100 (number 0, as a thin row carries it)', child: { number: 0, key: 'OMB-903' }, sub: { number: 0, key: 'OMB-904' }, map: { number: 0, key: 'OMB-100' }, childWant: 'OMB-903', subWant: 'OMB-904', mapWant: 'OMB-100' },
]

type Page = { html: string, st: any, m: any, issueRow: any, mapRow: any }
// Renders the real map detail page: one open ticket card and one sub-map card, the page's own header, top bar and bottom action bar.
export function drawMap(s: Shape, urlKind: string, opts: { stats?: any, spec?: boolean } = {}): Page {
  reset()
  const base = (r: any, i: number, extra: any) => Object.assign({ title: 'T' + i, state: 'OPEN', labels: [], blockedBy: [], level: 0, type: 'task', url: urlOf(r.key, urlKind) }, r, extra)
  const issueRow = base(s.child, 1, {})
  const subMap = base(s.sub, 2, { type: 'map', labels: [{ name: 'wayfinder:map' }], tickets: [], stats: { total: 0, closed: 0 } })
  const stats = opts.stats || { total: 2, closed: 0, levels: [{ open: 2, closed: 0, total: 2 }] }
  const m: any = Object.assign({ title: 'Map', state: 'OPEN', type: opts.spec ? 'spec' : 'map', labels: opts.spec ? [] : [{ name: 'wayfinder:map' }], url: urlOf(s.map.key, urlKind), tickets: [issueRow, subMap], stats, decisions: [], fog: [], outOfScope: [] }, s.map)
  const st: any = { snapshot: { issues: [], maps: [m, subMap], generatedMs: '2026-11-18T00:00:00Z' }, mapTickets: {}, reveal: {}, copyFlash: null, cwd: '/ws', backendId: 'x' }
  // A failed on-demand ticket fetch makes the header draw its "open in tracker" button; the cards still come from the snapshot rows.
  st.mapTickets[identityMod.idOf(m)] = { mode: 'err', error: { kind: 'boom', message: 'x' } }
  const html = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: cx }, React.createElement(MapDetail, { st, g: { m }, drill: true })))
  return { html, st, m, issueRow, mapRow: subMap }
}
export const keyLog = (r: any) => String(r.key)
