// tests/verify-74-deck-read-channel-publish.ts —— #74 门禁（期限、发布与装配）：读通道的第二组判据。
//
// 与 verify-74-deck-read-channel.ts 分开写，是因为文件粒度上限 20KB，那一扇说「读通道对外的行为」，这一扇说三件事：
//   · 一次调用只有一个期限：加载与读合起来共用，不叠加；
//   · 发布成宿主上下文里的服务 deckPanelRead：服务名、只发布一次、宿主缺 provide 或 provide 抛错时不拖垮启动；
//   · 装配点（src/host/index.ts）：老的两个宿主方法注册行逐字不变（桌面与网页面板那条老路不动），
//     新读通道靠动态加载接上，加载失败后缓存会清掉能重试，入口仍在四百行上限内。
import { printGateResult } from './lib/gate-result.ts'

const mod = await import('../src/host/deckReadChannel.ts')
const { createDeckReadChannel } = mod

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

/** 造一个读通道：两个宿主方法默认都成功；各自的行为与期限可以被覆盖。 */
function make(over: { loadTree?: () => any; timeoutMs?: number } = {}) {
  const channel = createDeckReadChannel({
    loadTree: over.loadTree || (async () => ({ handleTree: async (a: any) => ({ ok: true, sessionId: a.sessionId, containers: [] }) })),
    loadTicket: async () => ({ handleTicket: async (a: any) => ({ ok: true, sessionId: a.sessionId, ticket: { key: String(a.key) } }) }),
    timeoutMs: over.timeoutMs,
  })
  return { channel }
}

// —— 一、一次调用只有一个期限：加载与读合起来不叠加 ——
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const stacked = make({
    loadTree: async () => { await sleep(70); return { handleTree: async (a: any) => { await sleep(70); return { ok: true, sessionId: a.sessionId, containers: [] } } } },
    timeoutMs: 100,
  })
  const r: any = await stacked.channel.call('tree', { sessionId: 's' })
  check(r && r.ok === false && r.error.kind === 'timeout', '加载 70ms + 读 70ms 超过同一个 100ms 期限时按超时失败（两段不各算一个期限）', JSON.stringify(r).slice(0, 120))
}

// —— 二、发布成服务：名字、只发布一次、缺 provide 时不抛 ——
{
  const { provideDeckReadChannel, DECK_READ_SERVICE } = mod
  const { channel } = make()
  const seen: any[] = []
  const logs: any[] = []
  const ctx = { provide: (name: string, value: unknown) => { seen.push([name, value]) } }
  const logCtx = { fire: (level: string, event: string, fields: any) => { logs.push({ level, event, fields }) } }
  check(DECK_READ_SERVICE === 'deckPanelRead', '服务名是 deckPanelRead')
  check(provideDeckReadChannel(ctx, channel, logCtx) === true && seen.length === 1 && seen[0][0] === 'deckPanelRead' && seen[0][1] === channel, '以两参数写法把同一个读通道对象发布成 deckPanelRead')
  check(logs.length === 1 && logs[0].event === 'host.call' && logs[0].fields.method === 'deck.panel.read.provide', '发布成功记一行既有事件')
  const noProvide: boolean = provideDeckReadChannel({}, channel, logCtx)
  check(noProvide === false && logs.some((l) => l.event === 'host.call.fail' && l.fields.method === 'deck.panel.read.provide'), '宿主没有 provide 时回 false 并记一行失败，不抛')
  const throwing = provideDeckReadChannel({ provide: () => { throw new Error('duplicate service') } }, channel, logCtx)
  check(throwing === false, 'provide 抛错（例如重复注册）时回 false，不拖垮启动')
}

// —— 三、装配点：老的两个宿主方法一个字没动，新读通道靠动态加载接上，且失败后能重试 ——
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8')
  check(src.includes("harness.handle('wf.deckTree', async function (args: WfArgs) { const h = await _deckTree(); return h.handleTree(args) })\n"), '宿主方法 wf.deckTree 的注册行与原来逐字相同（桌面与网页面板那条老路没动）')
  check(src.includes("harness.handle('wf.deckTicket', async function (args: WfArgs) { const h = await _deckTicket(); return h.handleTicket(args) })\n"), '宿主方法 wf.deckTicket 的注册行与原来逐字相同，行尾没有附加语句')
  check(/import\('\.\/deckReadChannel\.js'\)\.then/.test(src) && src.includes('provideDeckReadChannel(ctx as any'), '入口用动态加载把读通道发布出去（入口不许静态引用）')
  check(src.includes('_deckTreeP = null; throw e') && src.includes('_deckTicketP = null; throw e'), '两个加载器失败时清掉缓存，一次临时失败不会让功能直到重启都不可用')
  check(src.split('\n').length <= 400, '宿主入口仍在四百行上限内（' + src.split('\n').length + ' 行）')
}

printGateResult('verify-74-deck-read-channel-publish', total, failed)
