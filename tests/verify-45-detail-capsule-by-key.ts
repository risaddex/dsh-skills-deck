// tests/verify-45-detail-capsule-by-key.ts: the work route table row and the session chain capsule keep a text key as a ticket and open it by its text (#45).
//
// Why this gate exists: a Linear ticket key is text (OMB-903). The host fills a row's numeric `number` only when the key is all digits
// (GitHub "42", Markdown "01"), so a Linear row has a `key` and no usable `number`. The work route table row and the session chain
// capsule in the status bar turned the entry's ticket key into a number before opening it, so a Linear entry opened nothing, or was no
// longer recognised as a ticket. This gate runs the REAL table code and the REAL capsule per shape and clicks the capsule row. The sibling
// gates of the same family are verify-45-detail-routes-by-key, verify-45-detail-issue-rows-by-key and verify-45-detail-map-page-by-key;
// they share the stubs in tests/lib/verify-45-detail-env.ts.
// Rule under test: a row whose key is not all digits hands its text key; GitHub 42 and Markdown 01 hand their number exactly as before;
// a text key that names a map of the snapshot opens the map, any other text key opens the ticket.
// 门禁归属: src/client/views/shared/workRouteTable.ts
// 门禁归属: src/client/statusbar/SessionChainCapsule.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-detail-capsule-by-key.ts
import { printGateResult } from './lib/gate-result.ts'
import { g, show, navCalls, makeChecker, realConsoleError } from './lib/verify-45-detail-env.ts'

const { check, stats } = makeChecker()

console.log('F) work route table row: the text key of the entry survives to the navigation')
{
  const tableMod: any = await import('../src/client/views/shared/workRouteTable.ts')
  const row = (key: string, effortId: string): any => ({ ticketKey: key, effortId, title: 't', sessionLabel: 's', action: '', actionAt: '', active: true, currentSession: false })
  const maps: any[] = [{ key: 'OMB-100', type: 'map', labels: [{ name: 'wayfinder:map' }], tickets: [] }]
  const nGh = tableMod.workRouteNavOf({ snapshot: { maps } }, row('42', ''))
  check(!!nGh && nGh.kind === 'issue' && nGh.n === '42', 'GitHub 42: the row opens the ticket "42" (got ' + show(nGh) + ')')
  const nLin = tableMod.workRouteNavOf({ snapshot: { maps } }, row('OMB-903', ''))
  check(!!nLin && nLin.kind === 'issue' && nLin.n === 'OMB-903', 'Linear OMB-903: the row opens the ticket "OMB-903" (got ' + show(nLin) + ')')
  const nLinMap = tableMod.workRouteNavOf({ snapshot: { maps } }, row('OMB-100', ''))
  check(!!nLinMap && nLinMap.kind === 'map' && nLinMap.n === 'OMB-100', 'Linear map OMB-100: the row opens the map "OMB-100" (got ' + show(nLinMap) + ')')
}

// ---------------------------------------------------------------------------------------------------------------------------------
console.log('G) session chain capsule: a text key stays a ticket and opens by its text')
{
  const capMod: any = await import('../src/client/statusbar/SessionChainCapsule.ts')
  const tableMod: any = await import('../src/client/views/shared/workRouteTable.ts')
  const label = await import('../src/client/kernel/ticket-label.ts')
  g.ticketLabelOf = label.ticketLabelOf; g.ticketLabelNodesOf = label.ticketLabelNodesOf; g.TICKET_LABEL_MAX_WIDTH = label.TICKET_LABEL_MAX_WIDTH
  g.ticketLabelPartsOf = label.ticketLabelPartsOf; g.ticketLabelCapsuleFoldOf = label.ticketLabelCapsuleFoldOf
  g.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.ts')).ticketBadgeOf
  g.workRouteActionKeyOf = tableMod.workRouteActionKeyOf; g.workRouteTableClock = tableMod.workRouteTableClock; g.workRouteTableOf = tableMod.workRouteTableOf
  g.openPanel = () => {}; g.placeStatusOverlay = () => ({ left: 1, bottom: 2 }); g.clearStatusClose = () => {}; g.scheduleStatusClose = (_r: any, fn: any) => { fn() }
  g.PortalOverlay = (o: any, kids: any) => ({ overlay: true, props: o, children: kids })
  g.DswsCtx = null
  const h = function (t: any, p: any) { return { t: t, p: p, c: Array.prototype.slice.call(arguments, 2) } }
  g.React = { createElement: h, useContext: () => ({ h }), useRef: (v: any) => ({ current: v }), useState: () => [null, () => {}] }
  g.Tip = () => null
  const nowIso = new Date(Date.now() - 3600000).toISOString()
  const entry = (key: string, effortId: string) => ({ ticketKey: key, title: '', sessionLabel: 'sess-mine-aaa', action: 'edit', actionAt: nowIso, active: true, currentSession: true, effortId })
  type Case = { name: string, key: string, rows: any[], maps: any[], kind: string, want: any }
  const CASES: Case[] = [
    { name: 'GitHub 42', key: '42', rows: [{ number: 42, key: '42', title: 'T42', state: 'open' }], maps: [], kind: 'issue', want: 42 },
    { name: 'Markdown 01 (number 1, key "01")', key: '01', rows: [{ number: 1, key: '01', title: 'T01', state: 'open' }], maps: [], kind: 'issue', want: 1 },
    { name: 'Linear OMB-903 (no number)', key: 'OMB-903', rows: [{ key: 'OMB-903', title: 'T903', state: 'open' }], maps: [], kind: 'issue', want: 'OMB-903' },
    { name: 'Linear OMB-100 (a map, no number)', key: 'OMB-100', rows: [{ key: 'OMB-100', title: 'M100', state: 'open', type: 'map', labels: [{ name: 'wayfinder:map' }] }], maps: [{ key: 'OMB-100', tickets: [] }], kind: 'map', want: 'OMB-100' },
  ]
  for (const c of CASES) {
    const st: any = { snapshot: { issues: c.rows, maps: c.maps, workRouteTable: { ok: true, readout: { at: new Date().toISOString(), staleCount: 0, entries: [entry(c.key, '')] } } }, chainMenuOpen: true, chainMenuPos: { left: 1, bottom: 2 } }
    const judged: any = capMod.sessionChainCapsuleOf(st, 's1')
    check(judged.state === 'ok' && judged.list.length === 1 && judged.list[0].ticketKey === c.key, c.name + ': the capsule keeps the ticket row for key ' + c.key + ' (state ' + judged.state + ', ' + (judged.list || []).length + ' rows)')
    check(judged.state === 'ok' && judged.list[0] && judged.list[0].ticketTitle === c.rows[0].title, c.name + ': the title is found in the snapshot by the same key (got ' + show(judged.list && judged.list[0] && judged.list[0].ticketTitle) + ')')
    const tree: any = capMod.SessionChainCapsule({ st, sid: 's1' })
    const rowNodes: any[] = []
    ;(function walk(n: any) {
      if (n === null || n === undefined) return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n === 'object' && n.overlay) { (n.children || []).forEach(walk); return }
      if (typeof n === 'object') {
        if (n.p && typeof n.p.className === 'string' && n.p.className.indexOf('dsws-chainmenu-row') >= 0) { rowNodes.push(n); return }
        ;(n.c || []).forEach(walk)
      }
    })(tree)
    navCalls.length = 0
    if (rowNodes[0]) rowNodes[0].p.onClick({ stopPropagation: () => {} })
    check(rowNodes.length === 1 && navCalls.length === 1 && navCalls[0].n === c.want && navCalls[0].kind === c.kind, c.name + ': clicking the capsule row opens the ' + c.kind + ' ' + show(c.want) + ' (rows ' + rowNodes.length + ', handed ' + show(navCalls) + ')')
  }
}

console.error = realConsoleError
printGateResult('verify-45-detail-capsule-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
