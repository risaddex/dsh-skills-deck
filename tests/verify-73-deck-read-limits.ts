// tests/verify-73-deck-read-limits.ts —— #73 门禁（上限与失败）：树投影的两个条数上限、截断信号、
// 字节护栏与「坏数据不许变成一棵空树」。
//
// 判据来自票面（规格 #70 钉的两个数在 tests/verify-73 这组门禁里只从 DECK_READ_LIMITS 取值，不另抄字面量）：
//   · 树最多带 DECK_READ_LIMITS 钉的那几个容器与那几张票，任何一个上限切掉了东西都要在回包里看得见；
//   · 截断不许是「悄悄少一半」：少了几个容器、几张票都要报出来，且被切掉的容器整块消失（不留半截子票单，
//     否则面板会把「地图里有 10 张票、只画了 3 张」读成这张地图只有 3 张票）；
//   · 回包超过字节护栏就如实失败，绝不回半份；后端回来的行整批读不懂时同样失败，不折成一棵空树。
//
// 测试在宿主电话的公开出口（createDeckTreeRead / createDeckTicketRead）上驱动，只把 Tracker 会话换成
// 可控夹具；真实四后端的读法另见 verify-73-deck-tree-read-backends.ts 与 verify-73-deck-ticket-read-backends.ts。
import { printGateResult } from './lib/gate-result.ts'
import { FULL_TICKET, okCwd, openedWithTicket } from './lib/deck-ticket-fixture.ts'
import { DECK_READ_LIMITS } from '../src/tracker/contract/deck-read.ts'

const { createDeckTreeRead } = await import('../src/host/deckTree.ts')
const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

const REPO = { backend: 'github', refId: 'acme/demo', name: 'acme/demo', url: 'https://example.test/acme/demo' }

/** 假只读会话：list 回调用方给的整批行；resultExtra 带 Tracker 自己的 truncated / fallback。 */
function treeSession(rows: any[], resultExtra: any = {}) {
  return async (cwd: string, opts: any) => ({
    ok: true,
    backendId: 'github',
    repoRef: REPO,
    call: async (fn: any) => fn({
      list: async () => Object.assign({ ok: true, data: rows }, resultExtra),
    }, { cwd }),
  })
}

/** 造 containers 个开放地图，每个带 ticketsPer 张开放子票（键按顺序编号，顺序就是后端回来的顺序）。 */
function treeRows(containers: number, ticketsPer: number): any[] {
  const rows: any[] = []
  for (let c = 1; c <= containers; c += 1) {
    rows.push({ key: 'c' + c, number: c, type: 'map', title: 'Map ' + c, state: 'open', url: 'https://example.test/c' + c, isPullRequest: false })
    for (let t = 1; t <= ticketsPer; t += 1) {
      rows.push({ key: 'c' + c + '-' + t, type: 'issue', parentKey: 'c' + c, title: 'Ticket ' + t, state: 'open', url: 'https://example.test/t', isPullRequest: false })
    }
  }
  return rows
}

async function readTree(rows: any[], resultExtra: any = {}): Promise<any> {
  const phone = createDeckTreeRead({ handleCwd: okCwd, openSession: treeSession(rows, resultExtra) })
  return phone.handleTree({ sessionId: 's-limits' })
}

// —— 一、容器上限：第 51 个容器不画，回包说清楚切了几个 ——
{
  const r: any = await readTree(treeRows(DECK_READ_LIMITS.maxContainers + 1, 1))
  check(r && r.ok === true, '容器数超上限时整条读仍成功（截断不是失败）', JSON.stringify(r).slice(0, 200))
  check(r && Array.isArray(r.containers) && r.containers.length === DECK_READ_LIMITS.maxContainers, '容器数停在上限：带满 ' + DECK_READ_LIMITS.maxContainers + ' 个就停')
  check(r && r.truncated === true, '任一上限切掉东西时 truncated=true，面板不会把截断当完整树')
  check(r && r.containersTruncated === true && r.backendTruncated === false, '截断来源分得清：是容器上限切的，不是后端名册本身不全')
  check(r && r.omittedContainers === 1, '被切掉的容器数如实报出（1 个）', r && String(r.omittedContainers))
  check(r && r.containers && r.containers[0] && r.containers[0].key === 'c1' && r.containers[r.containers.length - 1].key === 'c' + DECK_READ_LIMITS.maxContainers, '保留的是后端回来的前 N 个容器，顺序不乱')
}

// —— 二、票上限：跨容器合计到 DECK_READ_LIMITS.maxTickets 就停；停在哪就整块停，不留半截子票单 ——
{
  const per = 10
  const count = Math.floor(DECK_READ_LIMITS.maxTickets / per) + 10
  const r: any = await readTree(treeRows(count, per))
  check(r && r.ok === true, '票数超上限时整条读仍成功', JSON.stringify(r).slice(0, 200))
  check(r && Array.isArray(r.containers) && r.containers.length === DECK_READ_LIMITS.maxTickets / per, '容器数停在「票额度用尽」那一刻（' + (DECK_READ_LIMITS.maxTickets / per) + ' 个）', r && r.containers && r.containers.length)
  check(r && r.ticketsTruncated === true && r.containersTruncated === false, '截断来源分得清：是票上限切的，不是容器上限')
  check(r && r.truncated === true, '票上限切掉东西时 truncated=true')
  check(r && r.omittedTickets === count * per - DECK_READ_LIMITS.maxTickets, '被切掉的票数如实报出（' + (count * per - DECK_READ_LIMITS.maxTickets) + ' 张）', r && String(r.omittedTickets))
  const allComplete = !!(r && Array.isArray(r.containers) && r.containers.every((c: any) => Array.isArray(c.tickets) && c.tickets.length === per))
  check(allComplete, '留下来的每个容器都带齐自己的票（不留半截票单，否则会被读成「这张地图只有几张票」）')
  // 下一个容器装不下、但额度还剩几张时，也不能把它画成半个：整块跳过，票数照实记账。
  const partial = await readTree(treeRows(19, 10).concat([
    { key: 'c20', number: 20, type: 'map', title: 'Big map', state: 'open', url: '', isPullRequest: false },
    ...Array.from({ length: 20 }, (_, i) => ({ key: 'c20-' + (i + 1), type: 'issue', parentKey: 'c20', title: 'Big ' + (i + 1), state: 'open', url: '', isPullRequest: false })),
  ]))
  check(partial && partial.ok === true && Array.isArray(partial.containers) && partial.containers.length === 19, '额度只剩 10 张而下个容器有 20 张：整块不带，容器数停在 19', partial && partial.containers && partial.containers.length)
  check(partial && partial.omittedContainers === 1 && partial.omittedTickets === 20, '整块跳过的那一个容器与它的 20 张票都记在省略数里', partial && JSON.stringify({ c: partial.omittedContainers, t: partial.omittedTickets }))
  check(partial && partial.ticketsTruncated === true, '整块跳过仍算「票上限切的」，信号不丢')
}

// Standalone issues spend only the capacity left by complete container groups.
{
  const open = { key: '101', type: 'issue', title: 'Standalone', state: 'OPEN', blockedBy: [] }
  const rows = [open, { ...open, key: '102', blockedBy: undefined }, { ...open, key: '103', state: 'CLOSED' },
    { ...open, key: '104', isPullRequest: true }]
  const complete = await readTree(rows)
  check(complete.standaloneIssues?.map((t: any) => t.key).join(',') === '101,102' && !complete.truncated, 'Standalone-only workspaces retain open issues in tracker order, without closed tickets or PRs')
  check(Array.isArray(complete.standaloneIssues?.[0]?.blockedBy) && !('blockedBy' in complete.standaloneIssues[1]), 'Standalone rows preserve confirmed-empty and unknown blockers')
  const limited = await readTree([...treeRows(1, DECK_READ_LIMITS.maxTickets - 1), ...rows])
  check(limited.containers?.[0]?.tickets.length === DECK_READ_LIMITS.maxTickets - 1 && limited.standaloneIssues?.length === 1, 'Children and standalone issues share one ticket allowance')
  check(limited.truncated && limited.ticketsTruncated && limited.omittedTickets === 1, 'The standalone omission is reported by the ticket limit')
  const exhausted = await readTree([...treeRows(1, DECK_READ_LIMITS.maxTickets), open])
  check(exhausted.standaloneIssues?.length === 0 && exhausted.truncated, 'An empty standalone list with a spent allowance is reported as truncated')
  const empty = await readTree([])
  check(empty.standaloneIssues?.length === 0 && !empty.truncated, 'A confirmed empty list stays present on a complete result')
  const huge = await readTree([{ ...open, title: 'é'.repeat(DECK_READ_LIMITS.maxProjectionBytes) }])
  check(huge.ok === false && huge.error?.kind === 'oversized', 'Standalone rows count toward the reply byte limit')
}

// —— 三、后端自己说名单不全与「本层切了」是两件事，各自都要看得见 ——
{
  const r: any = await readTree(treeRows(1, 1), { truncated: true, fallback: 'rest', fallbackReason: 'quota' })
  check(r && r.truncated === true && r.backendTruncated === true, '后端名册自己说 truncated 时回包也报 truncated，并标明来源是后端', JSON.stringify(r && { t: r.truncated, b: r.backendTruncated }))
  check(r && r.containersTruncated === false && r.ticketsTruncated === false && r.omittedContainers === 0 && r.omittedTickets === 0, '后端截断不算本层切了东西：两个来源各自的计数是 0')
  check(r && r.fallback === 'rest' && r.fallbackReason === 'quota', '后端降级的说明照旧带出去')
  const clean: any = await readTree(treeRows(1, 1))
  check(clean && clean.truncated === false && clean.backendTruncated === false && clean.containersTruncated === false && clean.ticketsTruncated === false, '完整结果每一格截断信号都是 false')
  check(clean && clean.omittedContainers === 0 && clean.omittedTickets === 0, '完整结果省略数是 0（不是缺格）')
}

// —— 四、字节护栏：超过就如实失败，不回半份 ——
{
  const giant = 'x'.repeat(DECK_READ_LIMITS.maxProjectionBytes + 1024)
  const r: any = await readTree([
    { key: 'c1', number: 1, type: 'map', title: giant, state: 'open', url: '', isPullRequest: false },
  ])
  check(r && r.ok === false, '投影超过字节护栏时整条读如实失败', JSON.stringify(r).slice(0, 200))
  check(r && r.error && r.error.kind === 'oversized', '失败原因是 oversized（面板据此说「这次回包太大」，而不是「等一下再试」）', r && r.error && r.error.kind)
  check(r && !('containers' in r), '失败回包里没有任何容器：不回半份树')
}

// —— 五、坏数据不许折成一棵空树 ——
{
  const r: any = await readTree([{ title: 'no key here' }, { title: 'nor here', state: 'open' }])
  check(r && r.ok === false, '后端回来的行整批读不懂（没有一个带键）时如实失败', JSON.stringify(r).slice(0, 200))
  check(r && r.error && r.error.kind === 'parse', '失败原因是 parse（行读不成形状）', r && r.error && r.error.kind)
  const empty: any = await readTree([])
  check(empty && empty.ok === true && Array.isArray(empty.containers) && empty.containers.length === 0, '真正没有行时照旧回空树（空是答案，不是坏数据）')
}

// —— 六、票读的字节护栏：正文大到撑破通道时同样如实失败 ——
{
  const huge = Object.assign({}, FULL_TICKET, { key: '99', number: 99, body: 'y'.repeat(DECK_READ_LIMITS.maxProjectionBytes + 1024) })
  const phone = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(huge, []) })
  const r: any = await phone.handleTicket({ sessionId: 's-huge', key: '99' })
  check(r && r.ok === false, '单票详情超过字节护栏时如实失败', JSON.stringify(r).slice(0, 200))
  check(r && r.error && r.error.kind === 'oversized', '票读的失败原因也是 oversized', r && r.error && r.error.kind)
  const normal = createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithTicket(FULL_TICKET, []) })
  const ok: any = await normal.handleTicket({ sessionId: 's-normal', key: '72' })
  check(ok && ok.ok === true, '正常大小的票照样读得出来（护栏不误伤）')
}

printGateResult('verify-73-deck-read-limits', total, failed)
