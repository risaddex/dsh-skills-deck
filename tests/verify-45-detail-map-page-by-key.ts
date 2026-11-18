// tests/verify-45-detail-map-page-by-key.ts: the map detail card buttons, the archive link and the breadcrumb hand the text key to the navigation (#45).
//
// Why this gate exists: a Linear ticket key is text (OMB-903). The host fills a row's numeric `number` only when the key is all digits
// (GitHub "42", Markdown "01"), so a Linear row has a `key` and no usable `number` (a thin row can even carry a made-up 0). The map
// detail page passed `number` into the card buttons (copy, open, open the whole card) and into the archive link and the breadcrumb of the
// container, so for a Linear map the click did nothing and the breadcrumb read "#undefined". This gate runs the REAL handlers and the REAL
// page per shape and looks at what is handed over. The sibling gates of the same family are verify-45-detail-routes-by-key,
// verify-45-detail-issue-rows-by-key and verify-45-detail-capsule-by-key; they share the stubs in tests/lib/verify-45-detail-env.ts.
// Rule under test: a row whose key is not all digits hands its text key; GitHub 42 and Markdown 01 hand their number exactly as before;
// the local container number 0 stays 0; a negative number still opens nothing.
// 门禁归属: src/client/views/mapDetailV2/wiring/pageActionHandlers.ts
// 门禁归属: src/client/views/mapDetailV2/view/MapDetailV2Page.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-detail-map-page-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'
import { g, show, urlOf, navCalls, copied, opened, makeChecker, realConsoleError } from './lib/verify-45-detail-env.ts'

const { check, stats } = makeChecker()
// The map detail page reads the client context from this free name; the env helper does not install it (the page needs it, the other gates do not).
g.DswsCtx = (await import('../src/client/kernel/ctx.ts')).DswsCtx

console.log('D) map detail card buttons: copy, open and open-in-new-session by the row key')
{
  const handlerMod: any = await import('../src/client/views/mapDetailV2/wiring/pageActionHandlers.ts')
  const factsMod: any = await import('../src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts')
  g.rowActionText = () => 'prompt'
  g.openTrackerTarget = (_st: any, key: any) => { opened.push(key) }
  type Case = { name: string, row: any, want: any }
  const CASES: Case[] = [
    { name: 'GitHub 42', row: { number: 42, key: '42', title: 'T', url: urlOf('42') }, want: 42 },
    { name: 'Markdown 01 (number 1, key "01")', row: { number: 1, key: '01', title: 'T', url: urlOf('01') }, want: 1 },
    { name: 'Markdown container 00', row: { number: 0, key: '00', title: 'T', url: urlOf('00') }, want: 0 },
    { name: 'Linear OMB-903 (no number: the card facts have number null)', row: { key: 'OMB-903', title: 'T', url: urlOf('OMB-903') }, want: 'OMB-903' },
    { name: 'Linear OMB-903 (number 0, as a thin row carries it)', row: { number: 0, key: 'OMB-903', title: 'T', url: urlOf('OMB-903') }, want: 'OMB-903' },
  ]
  for (const c of CASES) {
    const st: any = { snapshot: { issues: [c.row], maps: [] } }
    const handlers: any = handlerMod.pageActionHandlersOf(st, [c.row])
    const number = factsMod.ticketNumberOf(c.row)
    const facts: any = { number, rowKey: String(c.row.key) }
    copied.length = 0; opened.length = 0; navCalls.length = 0
    handlers.onCopy(facts)
    check(copied.length === 1 && copied[0] === c.row.url, c.name + ': the copy button writes the ticket address (got ' + show(copied) + ')')
    handlers.onOpen(facts)
    check(opened.length === 1 && opened[0] === c.want, c.name + ': the open button hands ' + show(c.want) + ' to the tracker opener (got ' + show(opened) + ')')
    handlers.onCard(facts)
    check(navCalls.length === 1 && navCalls[0].n === c.want, c.name + ': the whole card opens the detail with ' + show(c.want) + ' (got ' + show(navCalls.map((x) => x.n)) + ')')
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
console.log('E) map detail page: the archive link and the breadcrumb of a container')
{
  const pageMod: any = await import('../src/client/views/mapDetailV2/view/MapDetailV2Page.ts')
  const seen: any = { top: null, profile: null }
  g.MapDetailTop = (props: any) => { seen.top = props; return null }
  g.MapProfileHeader = (props: any) => { seen.profile = props; return null }
  g.TicketCardFlow = () => null
  g.mapDetailPageModelOf = () => ({ profile: {}, feed: { empty: true }, cards: { sequence: [] } })
  g.pageActionHandlersOf = () => ({})
  g.buildColorOf = () => ({})
  g.rowActionKind = () => 'execute'
  g.mdImgOverlay = () => null
  let slice: any = null
  g.useDeckViewSlice = () => slice
  const draw = (m: any): void => { slice = { map: m, bucket: null, stats: null }; seen.top = null; seen.profile = null; renderToStaticMarkup(React.createElement(pageMod.MapDetailV2Page, { st: { snapshot: { maps: [m] }, navStack: [] }, g: { m } })) }
  type Case = { name: string, map: any, want: any }
  const CASES: Case[] = [
    { name: 'GitHub map 5', map: { number: 5, key: '5', title: 'M', labels: [], tickets: [] }, want: 5 },
    { name: 'Markdown map 05 (number 5, key "05")', map: { number: 5, key: '05', title: 'M', labels: [], tickets: [] }, want: 5 },
    { name: 'Markdown container 00', map: { number: 0, key: '00', title: 'M', labels: [], tickets: [] }, want: 0 },
    { name: 'Linear map OMB-100 (no number)', map: { key: 'OMB-100', title: 'M', labels: [], tickets: [] }, want: 'OMB-100' },
    { name: 'Linear map OMB-100 (number null)', map: { number: null, key: 'OMB-100', title: 'M', labels: [], tickets: [] }, want: 'OMB-100' },
  ]
  for (const c of CASES) {
    draw(c.map)
    navCalls.length = 0
    if (seen.profile && typeof seen.profile.onOpenArchive === 'function') seen.profile.onOpenArchive()
    check(navCalls.length === 1 && navCalls[0].kind === 'issue' && navCalls[0].n === c.want, c.name + ': clicking the title opens the archive page with ' + show(c.want) + ' (it handed ' + show(navCalls.map((x) => x.n)) + ')')
    check(!!seen.top && seen.top.navCrumb === 'panel.tabList / #' + c.want, c.name + ': the breadcrumb reads "panel.tabList / #' + c.want + '" (got ' + show(seen.top && seen.top.navCrumb) + ')')
  }
  // A negative number still opens nothing
  draw({ number: -1, key: '-1', title: 'M', labels: [], tickets: [] })
  navCalls.length = 0
  if (seen.profile && typeof seen.profile.onOpenArchive === 'function') seen.profile.onOpenArchive()
  check(navCalls.length === 0, 'a negative number still opens nothing')
}

console.error = realConsoleError
printGateResult('verify-45-detail-map-page-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
