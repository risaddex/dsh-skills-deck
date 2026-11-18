// tests/verify-45-map-order-by-key.ts: the map detail page and the ticket row recognise a blocker and sort the cards by the row's text key too (#45).
//
// Why this gate exists: Linear ticket keys are text (`OMB-12`), and a Linear row has a `key` but no numeric `number`. The host writes each
// ticket's `blockedBy` as numbers for all-digit keys and as the TEXT key otherwise, so for Linear `blockedBy` is ['OMB-1']. Three places
// still compared numbers: the map detail page's fog test (`x.number === b`), its card sort (`a.number - b.number`, NaN for Linear) and the
// ticket row's `openBlocker` (`String(x.number) === String(b)`). So a Linear ticket with an open blocker was not drawn as blocked, the
// Linear cards kept the order the host sent them in, and a Linear ticket whose blocker is in the same map was always drawn as blocked.
// This gate renders the REAL map detail page and the REAL ticket row for a Linear map and for the same map with numbers, and asserts that
// the two agree and that each matches the value written here. The map cards by key are in verify-45-map-cards-by-key.ts and the ticket row
// links in verify-45-ticket-row-by-key.ts; all three share the stubs in tests/lib/verify-45-map-cards-env.ts.
// Rule under test: a blocker `b` is matched to a ticket by the ticket's navigation key (`rowNavKeyOf`): `number` for an all-digit key
// (GitHub 42, Markdown "01"), the text key for any other key (Linear OMB-2), whatever `number` is (absent, null or a made-up 0). Two
// numeric keys sort by subtraction as before; a text key sorts with a natural-order text comparison, so OMB-2 comes before OMB-10.
// 门禁归属: src/client/views/MapDetail.ts, src/client/views/TicketRow.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-map-order-by-key.ts
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'
import { G, cx, DswsCtx, MapDetail, TicketRow, identityMod, urlOf, reset, elOf, makeChecker, realConsoleError } from './lib/verify-45-map-cards-env.ts'

const { check, stats } = makeChecker()

// One ticket of a scenario: its number n (OMB-n for Linear), whether it is open, and which tickets block it.
type Spec = { n: number, open: boolean, by: number[] }
// A flavour is how one tracker writes a row and the ids inside `blockedBy`.
type Flavour = { name: string, row: (n: number) => any, ref: (n: number) => any, map: any }
const pad2 = (n: number) => (n < 10 ? '0' : '') + String(n)
const FLAVOURS: Flavour[] = [
  { name: 'GitHub (number, key "n")', row: (n) => ({ number: n, key: String(n) }), ref: (n) => n, map: { number: 50, key: '50' } },
  { name: 'Markdown (number n, key "0n")', row: (n) => ({ number: n, key: pad2(n) }), ref: (n) => n, map: { number: 2, key: '02' } },
  { name: 'Linear (no number)', row: (n) => ({ key: 'OMB-' + n }), ref: (n) => 'OMB-' + n, map: { key: 'OMB-100' } },
  { name: 'Linear (number null, as the host sends it)', row: (n) => ({ number: null, key: 'OMB-' + n }), ref: (n) => 'OMB-' + n, map: { number: null, key: 'OMB-100' } },
  { name: 'Linear (number 0, as a thin row carries it)', row: (n) => ({ number: 0, key: 'OMB-' + n }), ref: (n) => 'OMB-' + n, map: { number: 0, key: 'OMB-100' } },
]
// The number a card stands for, read back from its key: "OMB-10" -> 10, "01" -> 1.
const nOfKey = (key: string) => Number(/(\d+)$/.exec(key)![1])

const rowsOf = (f: Flavour, specs: Spec[]) => specs.map((s) => Object.assign({ title: 'T' + s.n, state: s.open ? 'OPEN' : 'CLOSED', labels: [], blockedBy: s.by.map(f.ref), level: 0, type: 'task' }, f.row(s.n), { url: urlOf(f.row(s.n).key, 'http') }))

// Renders the real map detail page for these tickets (in the given order) and reads back the card order and which cards are fogged.
function drawPage(f: Flavour, specs: Spec[]): { order: number[], fog: number[], html: string } {
  reset()
  const tickets = rowsOf(f, specs)
  const open = specs.filter((s) => s.open).length
  const levelStats = { open, closed: specs.length - open, total: specs.length }
  const m: any = Object.assign({ title: 'Map', state: 'OPEN', type: 'map', labels: [{ name: 'wayfinder:map' }], url: urlOf(f.map.key, 'http'), tickets, stats: { total: specs.length, closed: levelStats.closed, levels: [levelStats] }, decisions: [], fog: [], outOfScope: [] }, f.map)
  const st: any = { snapshot: { issues: [], maps: [m], generatedMs: '2026-11-18T00:00:00Z' }, mapTickets: {}, reveal: {}, copyFlash: null, cwd: '/ws', backendId: 'x' }
  st.mapTickets[identityMod.idOf(m)] = { mode: 'err', error: { kind: 'boom', message: 'x' } }
  const html = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: cx }, React.createElement(MapDetail, { st, g: { m }, drill: true })))
  const keys = [...html.matchAll(/data-log="map\.card\.([^".]+)"/g)].map((x) => x[1])
  const fog = keys.filter((k) => String(elOf('map.card.' + k)?.props.className).split(' ').includes('fog')).map(nOfKey)
  return { order: keys.map(nOfKey), fog, html }
}

// Renders the real ticket row of ticket `n` inside a map that holds `specs`, and tells whether it shows the blocked state.
function rowBlocked(f: Flavour, specs: Spec[], n: number): boolean {
  reset()
  const tickets = rowsOf(f, specs)
  const t = tickets[specs.findIndex((s) => s.n === n)]
  const st: any = { snapshot: { issues: [], maps: [{ key: 'M', tickets }] }, cwd: '/ws', backendId: 'x' }
  const html = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: cx }, React.createElement(TicketRow, { st, g: { m: { tickets } }, t, indent: false, colorOf: () => '#7aa2f7' })))
  return html.includes('map.subBlocked') && html.includes('[icon:lock]')
}

const j = (v: any) => JSON.stringify(v)
// The three scenarios: ticket 2 is blocked by ticket 1 which is open; the same with ticket 1 closed; and no blockers at all (the order alone).
// The tickets are sent in an order that is NOT the expected one, so a page that keeps the host's order fails.
const OPEN_BLOCKER: Spec[] = [{ n: 10, open: true, by: [] }, { n: 2, open: true, by: [1] }, { n: 1, open: true, by: [] }]
const CLOSED_BLOCKER: Spec[] = [{ n: 10, open: true, by: [] }, { n: 2, open: true, by: [1] }, { n: 1, open: false, by: [] }]
const NO_BLOCKERS: Spec[] = [{ n: 10, open: true, by: [] }, { n: 2, open: true, by: [] }, { n: 1, open: true, by: [] }, { n: 3, open: true, by: [] }]

// The reference result of each scenario, read from the numeric GitHub page; every other flavour must give exactly this.
const ref = FLAVOURS[0]
const refOpen = drawPage(ref, OPEN_BLOCKER)
const refClosed = drawPage(ref, CLOSED_BLOCKER)
const refPlain = drawPage(ref, NO_BLOCKERS)
check(j(refOpen.order) === '[1,10,2]' && j(refOpen.fog) === '[2]', 'reference GitHub, open blocker: cards 1, 10, 2 and only card 2 is fogged (got ' + j(refOpen.order) + ' fog ' + j(refOpen.fog) + ')')
check(j(refClosed.order) === '[2,10,1]' && j(refClosed.fog) === '[]', 'reference GitHub, closed blocker: cards 2, 10, 1 and none is fogged (got ' + j(refClosed.order) + ' fog ' + j(refClosed.fog) + ')')
check(j(refPlain.order) === '[1,2,3,10]' && j(refPlain.fog) === '[]', 'reference GitHub, no blockers: cards 1, 2, 3, 10 (got ' + j(refPlain.order) + ')')

for (const f of FLAVOURS) {
  const tag = f.name
  // (a) an open blocker in the same map makes the ticket fog, exactly as in the numeric case
  const o = drawPage(f, OPEN_BLOCKER)
  check(j(o.fog) === '[2]', tag + ' / open blocker: only ticket 2 is fogged (got ' + j(o.fog) + ')')
  check(j(o.order) === j(refOpen.order) && j(o.fog) === j(refOpen.fog), tag + ' / open blocker: order and fog agree with the numeric page (got ' + j(o.order) + ')')
  // (b) a closed blocker does not
  const c = drawPage(f, CLOSED_BLOCKER)
  check(j(c.fog) === '[]', tag + ' / closed blocker: no ticket is fogged (got ' + j(c.fog) + ')')
  check(j(c.order) === j(refClosed.order), tag + ' / closed blocker: order agrees with the numeric page and ticket 2 comes before ticket 10 (got ' + j(c.order) + ')')
  // (c) the order is stable and natural: 2 before 10, whatever order the host sent
  const p = drawPage(f, NO_BLOCKERS)
  check(j(p.order) === j(refPlain.order), tag + ' / no blockers: cards in natural order 1, 2, 3, 10 (got ' + j(p.order) + ')')
  const again = drawPage(f, NO_BLOCKERS.slice().reverse())
  check(j(again.order) === j(p.order), tag + ' / no blockers: the reversed input gives the same order (got ' + j(again.order) + ')')
  check(!p.html.includes('NaN'), tag + ' / no blockers: the page has no NaN')
  // (d) the ticket row shows the blocked state for an open blocker and not for a closed one
  check(rowBlocked(f, OPEN_BLOCKER, 2) === true, tag + ' / ticket row of 2 with an open blocker shows the blocked state')
  check(rowBlocked(f, CLOSED_BLOCKER, 2) === false, tag + ' / ticket row of 2 with a closed blocker is not blocked')
  check(rowBlocked(f, OPEN_BLOCKER, 1) === false, tag + ' / ticket row of 1 (no blockers) is not blocked')
}

// A blocker that is NOT in this map is judged by the row's blockedByRefs, as before: CLOSED lets the row go, a missing state keeps it blocked.
for (const f of [FLAVOURS[0], FLAVOURS[2]]) {
  reset()
  const t: any = Object.assign({ title: 'T', state: 'OPEN', labels: [], blockedBy: [f.ref(7)], type: 'task' }, f.row(2))
  const draw = (refs: any[]) => { const tt = Object.assign({}, t, { blockedByRefs: refs }); const st: any = { snapshot: { issues: [], maps: [{ key: 'M', tickets: [tt] }] }, cwd: '/ws', backendId: 'x' }; return renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: cx }, React.createElement(TicketRow, { st, g: { m: { tickets: [tt] } }, t: tt, indent: false, colorOf: () => '#7aa2f7' }))).includes('map.subBlocked') }
  check(draw([{ key: String(f.ref(7)), state: 'CLOSED' }]) === false, f.name + ' / blocker outside the map with state CLOSED: the row is not blocked')
  check(draw([]) === true, f.name + ' / blocker outside the map with no state: the row stays blocked')
}

delete G.rowNavKeyOf
// Without the shared helper in the closure (a view loaded alone) the numeric page behaves as before; a Linear map is not a case there.
{
  const o = drawPage(ref, OPEN_BLOCKER)
  check(j(o.order) === '[1,10,2]' && j(o.fog) === '[2]', 'without the shared helper in the closure the numeric page still fogs ticket 2 and sorts 1, 10, 2 (got ' + j(o.order) + ' fog ' + j(o.fog) + ')')
  check(rowBlocked(ref, OPEN_BLOCKER, 2) === true && rowBlocked(ref, CLOSED_BLOCKER, 2) === false, 'without the shared helper in the closure the numeric ticket row still reads its blocker by number')
}
console.error = realConsoleError
printGateResult('verify-45-map-order-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
