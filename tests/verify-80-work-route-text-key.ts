/**
 * verify-80-work-route-text-key.ts —— 写工具成功后，在办表要认文本票号（#80）
 *
 * 症状（真机，2026-11-23，Linear 工作区 OMB）：deck_issue_report 的回执是好的，deck_work_route 却一直是空的。
 * 原因在工具壳收口处的「记一笔」那一步：它用只认 1 到 10 位数字的 chainTicketKey 收票号，OMB-923 被收成空串，
 * 票号清单为空，函数就悄悄返回——不记，也不在回执里说一句。在办表本身（<家目录>/.dsh/mattskillsdeck/work-path/<根散列>.json）
 * 不分后端、不检查票号形状，缺的只是这一步的识别。
 *
 * 本门禁用真实的存储与读出口（临时家目录 + 固定时钟）走完整的来回：
 *   一、Linear 的文本票号：五个写工具各记各的，读出口列得出来，盘上记的后端是 linear；
 *   二、数字票号照旧：42、#42、0042 都记成 42；
 *   三、认不出的票号：回执里留一句实话，不记；回执里本来就没票号的调用仍然不吭声；失败与 partial 仍然不记不加备注；
 *   四、上报带 release=true 时文本票号也能释放（只撤销纯上报的那条）；
 *   五、胶囊那条链用的 chainTicketKey 一个字没变（仍只认数字）。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-80-work-route-text-key.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkRouteBindings } from '../src/deck/shell/work-path-bindings.ts'
import { recordWorkRoute } from '../src/deck/shell/work-path-record.ts'
import { chainRootHash, chainTicketKey } from '../src/refresh/kernel/refresh-chain.ts'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-80-work-route-text-key'

let assertions = 0
let failed = 0

function check(ok: boolean, message: string): void {
  assertions += 1
  if (ok) {
    console.log('  PASS ' + message)
    return
  }
  failed += 1
  console.log('  FAIL ' + message)
}

const T0 = 1700000000000
const ROOT_KEY = 'ws-80'
const SESSION = { sessionId: 's-80', workspaceKey: ROOT_KEY, cwd: 'x' }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wproute-80-'))
let clock = T0
const store = createWorkRouteBindings({
  homeDir: home,
  now: () => clock,
  readFile: async (p: string) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  writeFile: async (p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8') },
  mkdir: async (dir: string) => { fs.mkdirSync(dir, { recursive: true }) },
  rename: async (from: string, to: string) => { fs.renameSync(from, to) },
})
const deps = {
  workRouteNote: (i: unknown) => store.note(i),
  workRouteRead: (i: unknown) => store.read(i),
  workRouteRelease: (i: unknown) => store.release(i),
  now: () => clock,
}

/** 每调一次把钟拨前一秒，再把回执交给记一笔那一步；回执原样还给调用方看备注。 */
async function record(tool: string, backend: string, value: any, session: typeof SESSION = SESSION): Promise<any> {
  clock += 1000
  await recordWorkRoute(deps, tool, session, backend, value)
  return value
}

/** 走存储直读（与 deck_work_route 读的是同一份），取本会话在办表里的条目。 */
async function entries(rootKey: string = ROOT_KEY): Promise<any[]> {
  const got: any = await store.read({ sessionId: SESSION.sessionId, rootKey: rootKey, at: clock, detail: 'standard' })
  return got && got.readout && Array.isArray(got.readout.entries) ? got.readout.entries : []
}

function diskLedger(rootKey: string = ROOT_KEY): any {
  const file = home + '/.dsh/mattskillsdeck/work-path/' + chainRootHash(rootKey) + '.json'
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

async function main(): Promise<void> {
  console.log('#80 Linear 的文本票号：写工具成功后要记进在办表，认不出就说实话')

  // ── 一、Linear：五个写工具各记各的 ──
  const vReport: any = { status: 'ok', data: { key: 'OMB-923', title: '上报的票', effortId: '' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vReport)
  check(vReport.notes.length === 0, '上报 OMB-923：回执备注为空（记上了就不多话）')
  const afterReport = (await entries()).filter((e: any) => e.ticketKey === 'OMB-923')
  check(afterReport.length === 1 && afterReport[0].action === 'report' && afterReport[0].source === 'reported'
    && afterReport[0].title === '上报的票' && afterReport[0].currentSession === true,
    '上报 OMB-923：在办表直读列得出来，动作 report、来源 reported、标题带上、算本会话')
  const disk1 = diskLedger()
  check(disk1 && disk1.v === 3 && disk1.backend === 'linear' && disk1.workers.length === 1
    && disk1.workers[0].entries.some((e: any) => e.ticketKey === 'OMB-923'),
    '盘上用的是既有的按工作区一份的在办表文件，后端写的是 linear，没有另起存储')

  const vCreate: any = { status: 'ok', data: { ticket: { key: 'OMB-930', title: '新票', effortId: 'eff-1' }, kind: 'issue' }, touched: ['OMB-930'], notes: [] }
  await record('deck_issue_create', 'linear', vCreate)
  const created = (await entries()).filter((e: any) => e.ticketKey === 'OMB-930')
  check(created.length === 1 && created[0].action === 'create' && created[0].source === 'auto' && vCreate.notes.length === 0,
    '建票 OMB-930：记一条，动作 create、来源 auto')
  check(diskLedger().workers[0].entries.filter((e: any) => e.ticketKey === 'OMB-930')[0].title === '新票',
    '建票 OMB-930：标题从 data.ticket 取到（key 对得上才算）')

  const vPatch: any = { status: 'ok', data: { requested: { title: true }, ticket: { key: 'OMB-930', title: '新票改名', effortId: 'eff-1' } }, touched: ['OMB-930'], notes: [] }
  await record('deck_issue_patch', 'linear', vPatch)
  const patched = (await entries()).filter((e: any) => e.ticketKey === 'OMB-930')
  check(patched.length === 1 && patched[0].action === 'edit' && patched[0].title === '新票改名',
    '改票 OMB-930：同一票只留一条，后来居上')

  const vPlan: any = {
    status: 'ok',
    data: { planId: 'plan-80', mapKey: 'OMB-940', durable: true },
    items: [
      { key: 'OMB-940', role: 'map', title: '地图', status: 'ok' },
      { key: 'OMB-941', role: 'child', title: '子票甲', status: 'ok' },
      { key: 'OMB-942', role: 'child', title: '上次已建', status: 'ok', skipped: true },
    ],
    touched: ['OMB-940', 'OMB-941', 'OMB-942'], notes: [],
  }
  await record('deck_map_plan_create', 'linear', vPlan)
  const planKeys = (await entries()).map((e: any) => e.ticketKey)
  check(planKeys.indexOf('OMB-941') >= 0 && planKeys.indexOf('OMB-940') < 0 && planKeys.indexOf('OMB-942') < 0 && vPlan.notes.length === 0,
    '建图：只记这次真建出来的子票 OMB-941，地图票与跳过的子票不记')

  const vLink: any = { status: 'ok', data: { requested: {}, done: [], jobs: [] }, touched: ['OMB-930'], notes: [] }
  await record('deck_map_link', 'linear', vLink)
  const linked = diskLedger().workers[0].entries.filter((e: any) => e.ticketKey === 'OMB-930')
  check(linked.length === 1 && linked[0].action === 'link' && linked[0].title === '新票改名',
    '连边：记一条，标题沿用上一次不被空串抹掉')

  // ── 二、数字票号照旧 ──
  const vNum: any = { status: 'ok', data: { ticket: { key: '0042', title: '数字票', effortId: '' } }, touched: ['#42', '0042', '42'], notes: [] }
  // 数字票号走 GitHub 工作区：另用一个工作区键，免得在同一份账上换后端、把上面 Linear 的账改名留档。
  const NUM_ROOT = 'ws-80-github'
  await record('deck_issue_patch', 'github', vNum, { sessionId: SESSION.sessionId, workspaceKey: NUM_ROOT, cwd: 'x' })
  const numericRows = (await entries(NUM_ROOT)).filter((e: any) => e.ticketKey === '42')
  check(numericRows.length === 1 && vNum.notes.length === 0, '数字票号：#42、0042、42 都记成同一条 42')
  check(diskLedger(NUM_ROOT).backend === 'github' && diskLedger(NUM_ROOT).workers[0].entries.every((e: any) => e.ticketKey !== '#42' && e.ticketKey !== '0042'),
    '数字票号：盘上键是归一后的 42，记在另一个工作区的账上')

  // ── 三、认不出的票号：说实话；没票号的调用不吭声；失败与 partial 不记 ──
  const beforeBad = (await entries()).length
  const vBad: any = { status: 'ok', data: { key: 'not a key', title: 'x' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vBad)
  check(vBad.notes.length === 1 && vBad.notes[0].indexOf('unrecognized-ticket-key') >= 0
    && vBad.notes[0].indexOf('OMB-923') >= 0 && vBad.notes[0].indexOf('deck_work_route') >= 0,
    '认不出的票号：回执留一句实话，点名原因并指向 deck_work_route')
  check((await entries()).length === beforeBad, '认不出的票号：在办表条数不变')

  const vBadTouched: any = { status: 'ok', data: {}, touched: ['bad key', 'OMB-950'], notes: [] }
  await record('deck_issue_patch', 'linear', vBadTouched)
  check(vBadTouched.notes.length === 0 && (await entries()).some((e: any) => e.ticketKey === 'OMB-950'),
    '一次写到两张票、一张认不出：认得出的照记，不为那一张加备注')

  const vNoKey: any = { status: 'ok', data: { planId: 'p' }, touched: [], notes: [] }
  await record('deck_map_plan_create', 'linear', vNoKey)
  check(vNoKey.notes.length === 0, '回执里本来就没票号（例如建图续跑没有新建的子票）：不吭声')

  const vPartial: any = { status: 'partial', data: { ticket: { key: 'OMB-960', title: '半成票' } }, touched: ['OMB-960'], notes: ['edge failed'] }
  await record('deck_issue_create', 'linear', vPartial)
  const vFailed: any = { status: 'unsupported', data: { key: 'bad key' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vFailed)
  check(vPartial.notes.length === 1 && vPartial.notes[0] === 'edge failed' && vFailed.notes.length === 0
    && !(await entries()).some((e: any) => e.ticketKey === 'OMB-960'),
    'partial 与失败：不记，备注一个字不动（认不出的票号也不加那句）')

  // ── 四、释放：文本票号也能撤销纯上报的那条 ──
  const vOnlyReport: any = { status: 'ok', data: { key: 'OMB-970', title: '只报过' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vOnlyReport)
  const vRelease: any = { status: 'ok', release: true, data: { key: 'OMB-970', title: '只报过' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vRelease)
  check(!(await entries()).some((e: any) => e.ticketKey === 'OMB-970') && vRelease.notes.length === 1 && vRelease.notes[0].indexOf('OMB-970 was released') >= 0,
    '释放 OMB-970：纯上报的条目被撤销，备注说清楚')
  const vReleaseWorked: any = { status: 'ok', release: true, data: { key: 'OMB-930', title: '新票改名' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vReleaseWorked)
  check((await entries()).some((e: any) => e.ticketKey === 'OMB-930') && vReleaseWorked.notes[0].indexOf('actually worked on') >= 0,
    '释放 OMB-930：建过改过的票不许释放，路径保留')
  const vReleaseBad: any = { status: 'ok', release: true, data: { key: 'bad key' }, touched: [], notes: [] }
  await record('deck_issue_report', 'linear', vReleaseBad)
  check(vReleaseBad.notes.length === 1 && vReleaseBad.notes[0].indexOf('did not release this time (unrecognized-ticket-key)') >= 0,
    '释放时票号认不出：回执说没释放的原因')

  // ── 五、胶囊那条链用的数字归一一个字没变 ──
  check(chainTicketKey('OMB-923') === '' && chainTicketKey('#0042') === '42' && chainTicketKey(7) === '7' && chainTicketKey('12345678901') === '',
    'chainTicketKey 仍只认数字（OMB-923 仍是空串；#0042 仍是 42），它归胶囊那条链管，本票不动')

  console.log('\n' + assertions + ' 条断言，' + (failed ? '失败' : '通过'))
  printGateResult(GATE, assertions, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.log('  FAIL gate threw: ' + (e && (e as Error).stack || e)); process.exit(1) })
