// tests/verify-72-deck-ticket-read-failures.ts —— #72 门禁（失败）：缺票、读失败、回包不成形、没有会话或票号
//
// 为什么单立一扇：面板要靠这些差别决定说「这张票没了」还是「等一下再试」，混成一个 ok=false
// 就没法决定。这里把四种结果各自的形状钉住，并钉住「会话找不到时绝不回落到别的 workspace」。
// 投影见 verify-72-deck-ticket-read.ts，真实解析器与管线见 -seams.ts。
import { printGateResult } from './lib/gate-result.ts'
import { REPO, okCwd } from './lib/deck-ticket-fixture.ts'

const { createDeckTicketRead } = await import('../src/host/deckTicket.ts')

let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

/** 只带一个 get 的假只读会话：回包由调用方给（用来逐字控制失败形状）。 */
function openedWithGet(result: any) {
  return async (cwd: string) => ({
    ok: true,
    backendId: 'github',
    repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => result }, { cwd }),
  })
}

// —— 缺票：契约说 not-found（对应 GitHub 404），原样上送，带上后端原话 ——
{
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithGet({ ok: false, error: { kind: 'not-found', message: 'Could not resolve to an issue with the number of 999.' } }),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-missing', key: '999' })
  check(r && r.ok === false, '缺票时回 ok=false')
  check(r && r.error && r.error.kind === 'not-found', '缺票的机器可读原因是 not-found', JSON.stringify(r.error))
  check(r && r.error && r.error.message === 'Could not resolve to an issue with the number of 999.', '缺票时把后端原话带上，不换一句自己编的')
  check(!('ticket' in (r || {})), '缺票时没有 ticket 这一格（不交半张空票）')
}

// —— 读失败：后端自己的原因原样带出，不能与缺票混为一谈 ——
{
  const phone = createDeckTicketRead({
    handleCwd: okCwd,
    openSession: openedWithGet({ ok: false, error: { kind: 'network', message: 'connection reset by peer' } }),
  })
  const r: any = await phone.handleTicket({ sessionId: 's-net', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'network', '读失败的失败原因原样带出（network），与缺票分开', JSON.stringify(r.error))
  check(r && r.error && r.error.kind !== 'not-found', '读失败不会被说成缺票')
}

// —— 执行层抛错：折成 fetch-failed，并保留抛出来的那句话 ——
{
  const throwing = async (cwd: string) => ({
    ok: true,
    backendId: 'github',
    repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => { throw new Error('the backend implementation threw') } }, { cwd }),
  })
  const r: any = await createDeckTicketRead({ handleCwd: okCwd, openSession: throwing }).handleTicket({ sessionId: 's-throw', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'fetch-failed', '后端实现抛错时折成 fetch-failed，不是悄悄回一张空票', JSON.stringify(r.error))
  check(r && r.error && r.error.message.indexOf('the backend implementation threw') >= 0, '抛错时保留抛出来的那句话')
}

// —— 回包不成形：说读成了却没有票行；以及「有对象但没有任何身份」的空行 ——
{
  const r: any = await createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithGet({ ok: true }) }).handleTicket({ sessionId: 's-norow', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'parse', '后端说读成了却没给票行时归 parse，不拿空对象装成一张票', JSON.stringify(r.error))
}

{
  // 读成功了、回来的却是一张没有任何身份的空行：不能拿请求的票号把它装成一张票（空结果不等于一张票）。
  const r: any = await createDeckTicketRead({ handleCwd: okCwd, openSession: openedWithGet({ ok: true, data: {} }) }).handleTicket({ sessionId: 's-emptyrow', key: '999' })
  check(r && r.ok === false && r.error && r.error.kind === 'parse', '回来的是一张没有身份的空行时归 parse，不装成一张 999 号的票', JSON.stringify(r).slice(0, 200))
  check(!('ticket' in (r || {})), '空行判失败时没有 ticket 这一格')
}

// —— 缺会话号 / 缺票号：各自直接失败，连后端都不碰 ——
{
  let getCalled = false
  const mustNotGet = async (cwd: string) => ({
    ok: true, backendId: 'github', repoRef: REPO,
    call: async (fn: any) => fn({ get: async () => { getCalled = true; return { ok: true, data: {} } } }, { cwd }),
  })
  const noSid = createDeckTicketRead({ handleCwd: async () => { throw new Error('must not be called without a session id') }, openSession: mustNotGet })
  const r: any = await noSid.handleTicket({ key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'no-sid', '缺 sessionId 时直接失败，reason=no-sid')
  check(getCalled === false, '缺 sessionId 时连那张票都不读')

  const noKey = createDeckTicketRead({ handleCwd: okCwd, openSession: mustNotGet })
  const rk: any = await noKey.handleTicket({ sessionId: 's-full' })
  check(rk && rk.ok === false && rk.error && rk.error.kind === 'no-key', '缺票号时直接失败，reason=no-key')
  check(getCalled === false, '缺票号时不去读一张不知道是谁的票')
}

// —— 会话找不到：如实失败，且绝不回落到别的 workspace 去读别的仓库的票 ——
{
  let openCalled = false
  let getCalled = false
  const phone = createDeckTicketRead({
    handleCwd: async () => ({ ok: false, error: 'This session could not be found', kind: 'not-found' }),
    openSession: async () => { openCalled = true; return { ok: true, backendId: 'github', repoRef: REPO, call: async (fn: any) => { getCalled = true; return fn({ get: async () => ({ ok: true, data: {} }) }, {}) } } },
  })
  const r: any = await phone.handleTicket({ sessionId: 'missing', key: '72' })
  check(r && r.ok === false && r.error && r.error.kind === 'not-found', '找不到会话时如实失败')
  check(openCalled === false && getCalled === false, '找不到会话时绝不回落到 Tracker 或别的 workspace')
}

printGateResult('verify-72-deck-ticket-read-failures', total, failed)
