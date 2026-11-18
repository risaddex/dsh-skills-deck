// tests/verify-45-map-facts-by-key.ts: the map card model gives a Linear ticket (text key) the same identity and blocking as a numeric one (#45).
//
// Why this gate exists: Linear ticket keys are text ("OMB-12") and a Linear row has no numeric `number`. The map card model
// (ticketCardFactsOf, ticketFactsContextOf) indexed everything by the number parsed from the key, so a Linear row was skipped:
// its card had no "#OMB-12" label, no card id, and it never appeared as blocked or as a blocker. The board ordering tied every
// Linear card on the missing number and fell back to a plain string compare, which puts OMB-10 before OMB-2. No gate fed a
// text-key map to the real model functions. This one runs the real functions on three families of maps (GitHub numbers,
// Markdown "01" keys with a number, Linear text keys with no number) with the same blocking scenarios, and asserts that the
// three families produce the same status, blockedBy and blocks structure, apart from the label text.
// 门禁归属: src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts
// 门禁归属: src/client/views/mapDetailV2/model/tickets/ticketBoard.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-map-facts-by-key.ts
import { printGateResult } from './lib/gate-result.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }
const show = (v: unknown): string => JSON.stringify(v)

// ticketCardFacts is a leaf: in production detailTopGate and prStateKind come from the same closure, here they are put on globalThis.
const g: any = globalThis
g.prStateKind = (await import('../src/client/views/shared/stateKind.ts')).prStateKind
g.detailTopGate = (await import('../src/client/kernel/detail-top-gate.ts')).detailTopGate
const facts: any = await import('../src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts')
const board: any = await import('../src/client/views/mapDetailV2/model/tickets/ticketBoard.ts')

const ENV: any = { cardIdPrefix: 'p', colorOf: {}, actionOf: () => 'execute', textOf: (key: string) => key }

// A family says how one logical ticket n (1, 2, 7, 10) is written as a row and as a blocker reference.
type Family = { name: string, row: (n: number, extra?: any) => any, ref: (n: number) => number | string }
const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
const FAMILIES: Family[] = [
  { name: 'GitHub', row: (n, extra) => ({ key: String(n), number: n, title: 'T' + n, state: 'OPEN', blockedBy: [], ...extra }), ref: (n) => n },
  { name: 'Markdown', row: (n, extra) => ({ key: pad(n), number: n, title: 'T' + n, state: 'OPEN', blockedBy: [], ...extra }), ref: (n) => pad(n) },
  { name: 'Linear', row: (n, extra) => ({ key: 'OMB-' + n, title: 'T' + n, state: 'OPEN', blockedBy: [], ...extra }), ref: (n) => 'OMB-' + n },
]
const LINEAR = FAMILIES[2]

// The logical ticket number behind a label or a key, whatever the family wrote ('#OMB-2', '02', 2 all give 2).
const logicalOf = (raw: unknown): number => Number(String(raw).replace(/^#/, '').replace(/^OMB-/, ''))
const refOut = (ref: any): any => (ref ? { n: logicalOf(ref.no), title: ref.title } : null)

function runMap(rows: any[]): any[] { const ctx = facts.ticketFactsContextOf(rows, ENV); return rows.map((row) => facts.ticketCardFactsOf(row, ctx)) }
// The label-free structure of one card: this is what must be equal across the three families.
const structureOf = (all: any[]): any => {
  const out: any = {}
  for (const f of all) out[logicalOf(f.rowKey)] = { status: f.status, pick: f.pickCorner, foot: f.footText, blockedBy: refOut(f.blockedBy), blocks: refOut(f.blocks) }
  return out
}
const orderOf = (all: any[]): number[] => board.orderOpenTickets(all).map((f: any) => logicalOf(f.rowKey))

// A scenario builds the rows of one family; `want` is the structure all families must give, written once by hand.
type Scenario = { name: string, rows: (fam: Family) => any[], want: any, order?: number[] }
const SCENARIOS: Scenario[] = [
  {
    name: '2 blocked by an OPEN 1',
    rows: (fam) => [fam.row(1), fam.row(2, { blockedBy: [fam.ref(1)] })],
    want: {
      1: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: { n: 2, title: 'T2' } },
      2: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 1, title: 'T1' }, blocks: null },
    },
    order: [1, 2],
  },
  {
    name: '2 blocked by a CLOSED 1 is ready',
    rows: (fam) => [fam.row(1, { state: 'CLOSED' }), fam.row(2, { blockedBy: [fam.ref(1)] })],
    want: {
      1: { status: 'closed', pick: null, foot: 'card.closedState', blockedBy: null, blocks: null },
      2: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: null },
    },
    order: [2],
  },
  {
    name: 'blocker 7 outside the map, OPEN in blockedByRefs',
    rows: (fam) => [fam.row(2, { blockedBy: [fam.ref(7)], blockedByRefs: [{ key: fam.ref(7), title: 'Outside seven', state: 'OPEN' }] })],
    want: { 2: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 7, title: 'Outside seven' }, blocks: null } },
    order: [2],
  },
  {
    name: 'blocker 7 outside the map, CLOSED in blockedByRefs',
    rows: (fam) => [fam.row(2, { blockedBy: [fam.ref(7)], blockedByRefs: [{ key: fam.ref(7), title: 'Outside seven', state: 'CLOSED' }] })],
    want: { 2: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: null } },
    order: [2],
  },
  {
    name: 'blocker 7 outside the map with no state at all stays blocked (safe side)',
    rows: (fam) => [fam.row(2, { blockedBy: [fam.ref(7)] })],
    want: { 2: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 7, title: '' }, blocks: null } },
    order: [2],
  },
  {
    name: 'two cards (10 and 2) blocked by the same 1: the blocker points at the smaller one',
    rows: (fam) => [fam.row(10, { blockedBy: [fam.ref(1)] }), fam.row(2, { blockedBy: [fam.ref(1)] }), fam.row(1)],
    want: {
      1: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: { n: 2, title: 'T2' } },
      2: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 1, title: 'T1' }, blocks: null },
      10: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 1, title: 'T1' }, blocks: null },
    },
    order: [1, 2, 10],
  },
  {
    name: 'two blockers (10 and 2) both open: the primary blocker is the smaller one',
    rows: (fam) => [fam.row(10), fam.row(2), fam.row(3, { blockedBy: [fam.ref(10), fam.ref(2)] })],
    want: {
      2: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: { n: 3, title: 'T3' } },
      3: { status: 'blocked', pick: null, foot: 'card.blockedCount', blockedBy: { n: 2, title: 'T2' }, blocks: null },
      10: { status: 'ready', pick: 'ready', foot: 'card.pickReady', blockedBy: null, blocks: null },
    },
    order: [2, 10, 3],
  },
]

console.log('A) the same blocking scenario gives the same structure in all three families')
for (const sc of SCENARIOS) {
  const results = FAMILIES.map((fam) => ({ fam, all: runMap(sc.rows(fam)) }))
  for (const { fam, all } of results) {
    check(show(structureOf(all)) === show(sc.want), sc.name + ' / ' + fam.name + ': status, blockedBy, blocks and foot text are the expected ones (got ' + show(structureOf(all)) + ')')
  }
  const reference = show(structureOf(results[0].all))
  check(results.every((r) => show(structureOf(r.all)) === reference), sc.name + ': the three families give the identical structure')
  if (sc.order) {
    for (const { fam, all } of results) {
      const forward = orderOf(all)
      const backward = orderOf(all.slice().reverse())
      check(show(forward) === show(sc.order) && show(backward) === show(sc.order), sc.name + ' / ' + fam.name + ': the board order is ' + show(sc.order) + ' for either input order (got ' + show(forward) + ' and ' + show(backward) + ')')
    }
  }
}

console.log('B) labels and card ids: numeric strings are exactly what they were, Linear gets its text key')
{
  const [gh, md, lin] = FAMILIES.map((fam) => runMap([fam.row(1), fam.row(2), fam.row(10)]))
  check(show(gh.map((f) => f.noText)) === show(['#1', '#2', '#10']), 'GitHub noText stays #1, #2, #10 (got ' + show(gh.map((f) => f.noText)) + ')')
  check(show(md.map((f) => f.noText)) === show(['#1', '#2', '#10']), 'Markdown noText stays #1, #2, #10: key "01" shows as #1 (got ' + show(md.map((f) => f.noText)) + ')')
  check(show(lin.map((f) => f.noText)) === show(['#OMB-1', '#OMB-2', '#OMB-10']), 'Linear noText is #OMB-1, #OMB-2, #OMB-10 (got ' + show(lin.map((f) => f.noText)) + ')')
  check(show(gh.map((f) => f.cardId)) === show(['p-1', 'p-2', 'p-10']), 'GitHub cardId stays p-1, p-2, p-10 (got ' + show(gh.map((f) => f.cardId)) + ')')
  check(show(md.map((f) => f.cardId)) === show(['p-1-01', 'p-2-02', 'p-10']), 'Markdown cardId stays p-1-01, p-2-02, p-10: the row key is appended only when it differs from the number (got ' + show(md.map((f) => f.cardId)) + ')')
  check(show(lin.map((f) => f.cardId)) === show(['p-OMB-1', 'p-OMB-2', 'p-OMB-10']), 'Linear cardId is p-OMB-1, p-OMB-2, p-OMB-10 (got ' + show(lin.map((f) => f.cardId)) + ')')
  check(lin.every((f) => typeof f.cardId === 'string' && f.cardId.indexOf('p-') === 0) && new Set(lin.map((f) => f.cardId)).size === lin.length, 'Linear cardIds are non-null, carry the prefix and are unique')
  check(show(gh.map((f) => f.number)) === show([1, 2, 10]) && show(md.map((f) => f.number)) === show([1, 2, 10]), 'facts.number stays the number for GitHub and Markdown')
  check(lin.every((f) => f.number === null), 'facts.number stays null for Linear (cardNavKeyOf relies on it) (got ' + show(lin.map((f) => f.number)) + ')')
  check(show(lin.map((f) => f.rowKey)) === show(['OMB-1', 'OMB-2', 'OMB-10']), 'Linear rowKey is the text key')
  const container = runMap([{ key: '00', number: 0, title: 'Container', state: 'OPEN' }])[0]
  check(container.noText === '#0' && container.cardId === 'p-0-00' && container.number === 0, 'the Markdown container 00 keeps number 0, label #0 and card id p-0-00 (got ' + show([container.noText, container.cardId, container.number]) + ')')
  check(typeof facts.ticketIdentityOf === 'function' && facts.ticketIdentityOf({ key: '01', number: 1 }) === '1' && facts.ticketIdentityOf({ key: '00', number: 0 }) === '0' && facts.ticketIdentityOf({ key: 'OMB-12' }) === 'OMB-12' && facts.ticketIdentityOf({}) === '', 'ticketIdentityOf: "01" gives "1", container 00 gives "0", OMB-12 gives "OMB-12", an empty row gives ""')
}

console.log('C) the context indexes a Linear row like a numeric one')
{
  const rows = [LINEAR.row(1), LINEAR.row(2, { blockedBy: ['OMB-1'] }), LINEAR.row(3, { blockedBy: ['OMB-9'], blockedByRefs: [{ key: 'OMB-9', title: 'Far away', state: 'OPEN' }] })]
  const ctx = facts.ticketFactsContextOf(rows, ENV)
  check(ctx.openByNumber['OMB-1'] === true && ctx.rowStates['OMB-2'] === 'open' && ctx.titleByNumber['OMB-1'] === 'T1' && ctx.cardIdByNumber['OMB-1'] === 'p-OMB-1', 'a Linear row has entries in openByNumber, rowStates, titleByNumber and cardIdByNumber')
  check(ctx.firstBlockedByBlocker['OMB-1'] === 'OMB-2', 'the blocker OMB-1 points at the blocked OMB-2 (got ' + show(ctx.firstBlockedByBlocker) + ')')
  check(ctx.blockerStates['OMB-9'] === 'open' && ctx.titleByNumber['OMB-9'] === 'Far away', 'a blocker outside the map is known through blockedByRefs by its text key')
  check(facts.ticketCardStatusOf(rows[1], ctx.openByNumber, ctx.blockerStates) === 'blocked', 'ticketCardStatusOf: OMB-2 is blocked by the open OMB-1')
  const claimed = runMap([LINEAR.row(1), LINEAR.row(2, { blockedBy: ['OMB-1'], claimedBy: 'ana' })])
  check(claimed[1].status === 'doing' && claimed[0].blocks === null, 'a claimed Linear ticket is doing and is not pointed at by its blocker (same as numeric rows)')
  const closedOne = runMap([LINEAR.row(1, { state: 'CLOSED' }), LINEAR.row(2, { blockedBy: ['OMB-1'] })])
  check(closedOne[1].status === 'ready' && closedOne[1].blockedBy === null, 'OMB-2 becomes ready once OMB-1 is closed')
}

console.log('D) board order: OMB-2 before OMB-10, numeric order unchanged')
{
  const mixed = runMap([LINEAR.row(10), LINEAR.row(2), LINEAR.row(1), LINEAR.row(3, { state: 'CLOSED', closedAt: '2026-01-01T00:00:00Z' }), LINEAR.row(4, { state: 'CLOSED', closedAt: '2026-01-01T00:00:00Z' })])
  const full = board.orderTicketBoard(mixed)
  check(show(full.open.map((f: any) => f.rowKey)) === show(['OMB-1', 'OMB-2', 'OMB-10']), 'ready Linear cards are ordered OMB-1, OMB-2, OMB-10 (got ' + show(full.open.map((f: any) => f.rowKey)) + ')')
  check(show(full.closed.map((f: any) => f.rowKey)) === show(['OMB-3', 'OMB-4']), 'closed Linear cards that tie on the close time are ordered OMB-3, OMB-4 (got ' + show(full.closed.map((f: any) => f.rowKey)) + ')')
  const numeric = runMap([FAMILIES[0].row(10), FAMILIES[0].row(2), FAMILIES[0].row(1)])
  check(show(board.orderOpenTickets(numeric).map((f: any) => f.rowKey)) === show(['1', '2', '10']), 'numeric rows are still ordered by number: 1, 2, 10')
  const counts = board.boardCountsOf(mixed)
  check(show(counts) === show({ total: 5, closed: 2, ready: 3, doing: 0, blocked: 0 }), 'boardCountsOf counts a Linear map like a numeric one (got ' + show(counts) + ')')
}

console.log('\n' + (failed ? 'FAILED: ' + failed + ' of ' + assertions : 'OK: ' + assertions) + ' assertions')
printGateResult('verify-45-map-facts-by-key', assertions, failed)
if (failed) process.exit(1)
