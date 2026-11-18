// tests/verify-45-ticket-row-by-key.ts: the ticket row inside a map detail hands its text key to the tooltips and links, and the views still draw without the shared helper (#45).
//
// Why this gate exists: Linear ticket keys are text (`OMB-903`). The host fills a row's numeric `number` only when the key is all digits,
// so a Linear row has no usable `number`. The ticket row passed `row.number` to its new-session tooltip, its open-in-tracker link and the
// closed row's "view" link, so a Linear row showed "#undefined" and had no address. This gate renders the REAL ticket row per row shape
// and per address kind. It also checks the fallback: a view loaded alone (no shared rowNavKeyOf in the closure) keeps pushing
// `row.number`, so the card of a GitHub row still opens. The map detail page itself is in verify-45-map-cards-by-key.ts; both share the
// stubs in tests/lib/verify-45-map-cards-env.ts.
// Rule under test: a row whose key is all digits passes exactly what it passed before (GitHub 42, Markdown 1, container 0);
// a row whose key is text passes that text key (Linear OMB-903), whatever its `number` is (absent, null or a made-up 0).
// 门禁归属: src/client/views/TicketRow.ts, src/client/views/MapDetail.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-ticket-row-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'
import { G, rec, cx, DswsCtx, TicketRow, urlOf, reset, elOf, tipsOf, ev, SHAPES, keyLog, drawMap, makeChecker, realConsoleError } from './lib/verify-45-map-cards-env.ts'

const { check, stats } = makeChecker()

// --- the ticket row (a row inside a map detail): new-session tooltip, open-in-tracker link and the closed row's "view" link ---
for (const s of SHAPES) {
  for (const urlKind of ['http', 'file']) {
    for (const open of [true, false]) {
      const tag = 'TicketRow ' + s.name + ' [' + urlKind + ', ' + (open ? 'open' : 'closed') + ']'
      reset()
      const t: any = Object.assign({ title: 'T', state: open ? 'OPEN' : 'CLOSED', labels: [], blockedBy: [], type: 'task', url: urlOf(s.child.key, urlKind) }, s.child)
      const g: any = { m: { tickets: [t] } }
      const st: any = { snapshot: { issues: [], maps: [{ key: 'M', tickets: [t] }] }, cwd: '/ws', backendId: 'x' }
      const html = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: cx }, React.createElement(TicketRow, { st, g, t, indent: false, colorOf: () => '#7aa2f7' })))
      const url = urlOf(s.child.key, urlKind)
      check(html.includes('#' + String(s.child.key)) && !html.includes('#undefined'), tag + ': the row shows #' + String(s.child.key) + ' and no #undefined')
      const logOpen = open ? 'ticket.link.' + keyLog(t) : (urlKind === 'http' ? 'ticket.view.' + keyLog(t) : 'ticket.view.local.' + keyLog(t))
      const el = elOf(logOpen)
      if (open) {
        const tips = tipsOf()
        check(tips.includes('tip.newSession@n=' + String(s.childWant)), tag + ': the new-session tooltip names ' + String(s.childWant))
        check(tips.includes('tip.openInTracker@n=' + String(s.childWant)), tag + ': the open-in-tracker tooltip names ' + String(s.childWant))
      }
      if (urlKind === 'http') check(!!el && el.props.href === url, tag + ': the ' + (open ? 'link' : 'view') + ' button points at the ticket address (' + String(el && el.props.href) + ')')
      else {
        rec.host.length = 0
        if (el) el.props.onClick(ev)
        check(rec.host.length === 1 && (rec.host[0].args.path || rec.host[0].args.file) === url, tag + ': the ' + (open ? 'link' : 'view') + ' button opens the ticket file (' + JSON.stringify(rec.host[0]) + ')')
      }
    }
  }
}

// --- the views still draw when the shared helper is not in the closure (a gate loading one view alone): they fall back to row.number ---
{
  delete G.rowNavKeyOf
  const s = SHAPES[0]
  const p = drawMap(s, 'http')
  rec.push.length = 0
  const card = elOf('map.card.' + keyLog(p.issueRow))
  if (card) card.props.onClick(ev)
  check(rec.push.length === 1 && rec.push[0].n === 42, 'without the shared helper in the closure the GitHub card still pushes its number 42')
  check(p.html.includes('panel.tabList / #' + String(s.mapWant)), 'without the shared helper in the closure the breadcrumb still shows the number')
}
console.error = realConsoleError
printGateResult('verify-45-ticket-row-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
