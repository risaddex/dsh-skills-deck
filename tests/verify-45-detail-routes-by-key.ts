// tests/verify-45-detail-routes-by-key.ts: the sub-issue routing and the row actions hand the text key to the navigation, the links and the prompts (#45).
//
// Why this gate exists: a Linear ticket key is text (OMB-903). The host fills a row's numeric `number` only when the key is all digits
// (GitHub "42", Markdown "01"), so a Linear row has a `key` and no usable `number` (a thin row can even carry a made-up 0). Besides the
// list row (verify-45-list-row-opens-by-key), several other places passed `row.number` into the navigation and link seams. This gate
// covers two of them: the sub-issue and blocked-by routing of the ticket detail (enterSubDetail) and the row actions (link, prompt, log
// name). The navigation refuses an empty value, so a click did nothing and links came out empty. This gate runs the REAL code per shape
// and looks at what is handed over. The other places of the same family are in verify-45-detail-issue-rows-by-key (ticket detail page),
// verify-45-detail-map-page-by-key (map detail card buttons, archive link, breadcrumb) and verify-45-detail-capsule-by-key (work route
// table, session chain capsule); they share the stubs in tests/lib/verify-45-detail-env.ts.
// Rule under test: a row whose key is not all digits hands its text key; GitHub 42 and Markdown 01 hand their number exactly as before;
// the local container number 0 stays 0; a blocked-by node that carries its text key in `number` still hands that text.
// 门禁归属: src/client/views/subIssueRouting.ts
// 门禁归属: src/client/kernel/row-actions.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-detail-routes-by-key.ts
import { printGateResult } from './lib/gate-result.ts'
import { g, show, urlOf, navCalls, injected, subMod, makeChecker, realConsoleError } from './lib/verify-45-detail-env.ts'

const { check, stats } = makeChecker()

console.log('A) enterSubDetail: the sub-issue and blocked-by rows of the ticket detail')
{
  const MAP_TAG = [{ name: 'wayfinder:map' }]
  type Case = { name: string, node: any, maps: any[], kind: string, want: any }
  const CASES: Case[] = [
    { name: 'GitHub 42 (number 42, key "42")', node: { number: 42, key: '42', title: 'T', state: 'OPEN', labels: [] }, maps: [], kind: 'issue', want: 42 },
    { name: 'Markdown 01 (number 1, key "01")', node: { number: 1, key: '01', title: 'T', state: 'OPEN', labels: [] }, maps: [], kind: 'issue', want: 1 },
    { name: 'Markdown container 00 (number 0, key "00")', node: { number: 0, key: '00', title: 'T', state: 'OPEN', labels: MAP_TAG, type: 'map' }, maps: [{ number: 0, key: '00', tickets: [] }], kind: 'map', want: 0 },
    { name: 'Linear OMB-903 (no number)', node: { key: 'OMB-903', title: 'T', state: 'OPEN', labels: [] }, maps: [], kind: 'issue', want: 'OMB-903' },
    { name: 'Linear OMB-903 (number null)', node: { number: null, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [] }, maps: [], kind: 'issue', want: 'OMB-903' },
    { name: 'Linear OMB-903 (number 0, as a thin row carries it)', node: { number: 0, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [] }, maps: [], kind: 'issue', want: 'OMB-903' },
    { name: 'blocked-by node {number: "OMB-12", title} (the host puts the text key in number, there is no key)', node: { number: 'OMB-12', title: 'B' }, maps: [], kind: 'issue', want: 'OMB-12' },
    { name: 'blocked-by node whose text key matches a Linear map of the snapshot', node: { number: 'OMB-100', title: 'M' }, maps: [{ key: 'OMB-100', tickets: [] }], kind: 'map', want: 'OMB-100' },
    { name: 'Linear map OMB-100 (key only, map label, found in the snapshot)', node: { key: 'OMB-100', title: 'M', state: 'OPEN', labels: MAP_TAG, type: 'map' }, maps: [{ key: 'OMB-100', tickets: [] }], kind: 'map', want: 'OMB-100' },
  ]
  for (const c of CASES) {
    navCalls.length = 0
    subMod.enterSubDetail({ snapshot: { maps: c.maps } }, c.node, '')
    check(navCalls.length === 1 && navCalls[0].n === c.want, c.name + ': enterSubDetail hands ' + show(c.want) + ' to the navigation (it handed ' + show(navCalls.map((x) => x.n)) + ')')
    check(navCalls.length === 1 && navCalls[0].kind === c.kind, c.name + ': the stack gets the kind "' + c.kind + '" (it got ' + show(navCalls.map((x) => x.kind)) + ')')
  }
  // A node with nothing to open still does nothing
  navCalls.length = 0
  subMod.enterSubDetail({ snapshot: { maps: [] } }, { title: 'no key at all' }, '')
  subMod.enterSubDetail({ snapshot: { maps: [] } }, null, '')
  check(navCalls.length === 0, 'a node with neither number nor key, and a null node, open nothing')
  // A file loaded alone (no rowNavKeyOf in the closure) keeps the old behaviour for numeric nodes
  const keep = g.rowNavKeyOf
  delete g.rowNavKeyOf
  navCalls.length = 0
  subMod.enterSubDetail({ snapshot: { maps: [] } }, { number: 42, key: '42', title: 'T', labels: [] }, '')
  check(navCalls.length === 1 && navCalls[0].n === 42, 'without rowNavKeyOf in scope a numeric node still hands its number (got ' + show(navCalls.map((x) => x.n)) + ')')
  g.rowNavKeyOf = keep
}

// ---------------------------------------------------------------------------------------------------------------------------------
console.log('C) row-actions: the link, the prompt and the log name of a row')
{
  const ra: any = await import('../src/client/kernel/row-actions.ts')
  g.h = (type: any, props: any, ...kids: any[]) => ({ type, props, kids })
  g.renderTemplate = (name: string, params: any) => name + '|' + params.url
  g.startText = () => 'start'
  g.promptText = () => 'prompt'
  g.containerPromptText = (_st: any, _c: any, kind: any, _state: any, url: any) => 'CONT|' + kind + '|' + url
  g.isLightHex = () => false
  type Row = { name: string, row: any, wantUrl: string, wantLog: string }
  const ROWS: Row[] = [
    { name: 'GitHub 42', row: { number: 42, key: '42', title: 'T', state: 'OPEN', labels: [], url: urlOf('42') }, wantUrl: urlOf('42'), wantLog: 'issue.action.42' },
    { name: 'Markdown 01 (number 1, key "01")', row: { number: 1, key: '01', title: 'T', state: 'OPEN', labels: [], url: urlOf('01') }, wantUrl: urlOf('01'), wantLog: 'issue.action.1' },
    { name: 'Markdown container 00', row: { number: 0, key: '00', title: 'T', state: 'OPEN', labels: [], url: urlOf('00') }, wantUrl: urlOf('00'), wantLog: 'issue.action.0' },
    { name: 'Linear OMB-903 (no number)', row: { key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, wantUrl: urlOf('OMB-903'), wantLog: 'issue.action.OMB-903' },
    { name: 'Linear OMB-903 (number null)', row: { number: null, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, wantUrl: urlOf('OMB-903'), wantLog: 'issue.action.OMB-903' },
    { name: 'Linear OMB-903 (number 0, as a thin row carries it)', row: { number: 0, key: 'OMB-903', title: 'T', state: 'OPEN', labels: [], url: urlOf('OMB-903') }, wantUrl: urlOf('OMB-903'), wantLog: 'issue.action.OMB-903' },
  ]
  for (const r of ROWS) {
    const st: any = { snapshot: { issues: [r.row], maps: [] } }
    const text: string = ra.rowActionText(st, r.row)
    check(text === 'diagnose|' + r.wantUrl, r.name + ': the prompt carries the ticket address ' + r.wantUrl + ' (got ' + show(text) + ')')
    const btn: any = ra.mkRowAction(st, r.row, false, {})
    const button: any = btn && btn.kids && btn.kids[0]
    check(!!button && button.props['data-log'] === r.wantLog, r.name + ': the action button is named ' + r.wantLog + ' (got ' + show(button && button.props['data-log']) + ')')
    injected.length = 0
    if (button) button.props.onClick({ stopPropagation: () => {} })
    check(injected.length === 1 && injected[0] === 'diagnose|' + r.wantUrl, r.name + ': pressing the button injects the prompt with the same address (got ' + show(injected) + ')')
  }
  // A Linear container (exploration map) takes the container prompt with the real address
  const mapRow: any = { key: 'OMB-100', title: 'M', state: 'OPEN', type: 'map', labels: [{ name: 'wayfinder:map' }], url: urlOf('OMB-100'), tickets: [], stats: { total: 0, closed: 0 } }
  const textMap: string = ra.rowActionText({ snapshot: { issues: [mapRow], maps: [mapRow] } }, mapRow)
  check(textMap === 'CONT|map|' + urlOf('OMB-100'), 'Linear map OMB-100: the container prompt carries the address (got ' + show(textMap) + ')')
}

console.error = realConsoleError
printGateResult('verify-45-detail-routes-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)
