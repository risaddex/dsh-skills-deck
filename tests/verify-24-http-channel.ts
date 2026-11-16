// tests/verify-24-http-channel.ts — the HTTP channel a room uses when its backend has no CLI (#24)
//
// Why this gate exists: the contract forbids a room from using the global fetch and Linear ships no
// command-line tool, so ticket 24 added an injected channel (BackendContext.http). The channel is the
// only place where a room's HTTPS traffic meets the outbound gate, so the things worth pinning are the
// ones that would silently stop happening:
//   H1  one request goes out as described: method, url, headers and body reach fetch unchanged, and the
//       status, the lower-cased headers and the body text come back.
//   H2  the outbound slot is taken and given back on every path, including the failing ones (a leaked
//       slot permanently eats one of the process-wide permits).
//   H3  a response of any status counts as the path being alive (reportSuccess), and a write request
//       also records the write (noteWrite); a read request records no write.
//   H4  a transport failure reports to outbound so the bucket cools down, and a timeout reports as
//       'timeout' rather than looking like a plain failure.
//   H5  a caller cancellation is reported as a cancellation, not as a path failure.
//   H6  a runtime without fetch fails loudly instead of pretending the request failed somewhere else.
//   H7  the channel writes no log event of its own: a transport failure is already recorded by the
//       outbound gate it reports to, and a per-request line would be the heartbeat noise the logging
//       rules forbid. Adding one means registering the event in research/489-appendix.md and
//       tests/verify-log-fields.ts first, so this gate refuses a logging call inside the channel.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-24-http-channel.ts
import { readFileSync } from 'node:fs'
import { createHttpChannel } from '../src/host/platform/httpChannel.ts'
import type { HttpFetchLike } from '../src/host/platform/httpChannel.ts'
import type { OutboundBucket, OutboundControl, OutboundService } from '../src/tracker/contract/outbound.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

/** A stand-in for the outbound control that records what the channel did to it. */
function fakeOutbound(): {
  control: OutboundControl
  log: { acquires: { bucket: OutboundBucket; service?: OutboundService }[]; releases: number; writes: number; transport: any[]; success: { bucket: OutboundBucket }[] }
} {
  const log = { acquires: [] as { bucket: OutboundBucket; service?: OutboundService }[], releases: 0, writes: 0, transport: [] as any[], success: [] as { bucket: OutboundBucket }[] }
  const control: OutboundControl = {
    acquire(req) {
      log.acquires.push({ bucket: req.bucket, service: req.service })
      return Promise.resolve(() => { log.releases += 1 })
    },
    isCancelled(err) { return !!(err && (err as any).__cancelled === true) },
    noteWrite() { log.writes += 1 },
    reportTransportFailure(failure) { log.transport.push(failure) },
    reportSuccess(req) { log.success.push({ bucket: req.bucket }) },
  }
  return { control, log }
}

/** A fetch that answers with a fixed response and records how it was called. */
function fakeFetch(answer: { status?: number; headers?: [string, string][]; body?: string }): {
  impl: HttpFetchLike
  calls: { url: string; init: Record<string, unknown> }[]
} {
  const calls: { url: string; init: Record<string, unknown> }[] = []
  const impl: HttpFetchLike = async (url, init) => {
    calls.push({ url, init })
    const pairs = answer.headers || []
    return {
      status: answer.status === undefined ? 200 : answer.status,
      headers: { forEach(cb) { for (const [k, v] of pairs) cb(v, k) } },
      text: async () => (answer.body === undefined ? '' : answer.body),
    }
  }
  return { impl, calls }
}

async function main(): Promise<void> {
  console.log('H1 one request goes out as described and the answer comes back')
  {
    const { control } = fakeOutbound()
    const { impl, calls } = fakeFetch({ status: 201, headers: [['X-RateLimit-Remaining', '42']], body: '{"ok":true}' })
    const channel = createHttpChannel({ outbound: control, fetchImpl: impl })
    const res = await channel.request({ method: 'POST', url: 'https://api.linear.app/graphql', headers: { Authorization: 'KEY', 'Content-Type': 'application/json' }, body: '{"query":"{}"}' })
    const call = calls[0]
    check(calls.length === 1, 'exactly one request reached fetch', String(calls.length))
    check(call && call.url === 'https://api.linear.app/graphql', 'the url is passed through', call ? call.url : '(none)')
    check(call && call.init.method === 'POST', 'the method is passed through', call ? String(call.init.method) : '(none)')
    check(call && (call.init.body as string) === '{"query":"{}"}', 'the body is passed through unchanged')
    check(call && JSON.stringify(call.init.headers) === JSON.stringify({ Authorization: 'KEY', 'Content-Type': 'application/json' }), 'the headers are passed through unchanged')
    check(res.status === 201, 'the status comes back', String(res.status))
    check(res.body === '{"ok":true}', 'the body text comes back', res.body)
    check(res.headers['x-ratelimit-remaining'] === '42', 'headers come back with lower-case names', JSON.stringify(res.headers))
  }

  console.log('H2 the outbound slot is always given back')
  {
    const ok = fakeOutbound()
    const ch1 = createHttpChannel({ outbound: ok.control, fetchImpl: fakeFetch({}).impl })
    await ch1.request({ url: 'https://example.test/' })
    check(ok.log.acquires.length === 1 && ok.log.releases === 1, 'taken and released once on success', JSON.stringify(ok.log))

    const bad = fakeOutbound()
    const ch2 = createHttpChannel({ outbound: bad.control, fetchImpl: (async () => { throw new Error('boom') }) as unknown as HttpFetchLike })
    await ch2.request({ url: 'https://example.test/' }).then(() => {}, () => {})
    check(bad.log.acquires.length === 1 && bad.log.releases === 1, 'taken and released once when the request fails', JSON.stringify(bad.log))
  }

  console.log('H3 any answer means the path is alive; only a write records a write')
  {
    const w = fakeOutbound()
    const ch = createHttpChannel({ outbound: w.control, fetchImpl: fakeFetch({ status: 500 }).impl })
    const res = await ch.request({ method: 'POST', url: 'https://example.test/', bucket: 'write' })
    check(res.status === 500, 'a 500 is returned to the caller, not turned into an error', String(res.status))
    check(w.log.success.length === 1, 'a 500 still reports the path as alive', JSON.stringify(w.log.success))
    check(w.log.writes === 1, 'a write request records the write', String(w.log.writes))
    check(w.log.transport.length === 0, 'and reports no transport failure', JSON.stringify(w.log.transport))

    const r = fakeOutbound()
    const ch2 = createHttpChannel({ outbound: r.control, fetchImpl: fakeFetch({}).impl })
    await ch2.request({ url: 'https://example.test/', bucket: 'read' })
    check(r.log.writes === 0, 'a read request records no write', String(r.log.writes))
    check(r.log.acquires[0] && r.log.acquires[0].bucket === 'read', 'the read bucket is the default', JSON.stringify(r.log.acquires[0]))
  }

  console.log('H4 a transport failure cools the bucket down, and a timeout says so')
  {
    const t = fakeOutbound()
    const ch = createHttpChannel({ outbound: t.control, fetchImpl: (async (_u, init) => new Promise((_res, rej) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => rej(new Error('aborted by timeout')))
    })) as unknown as HttpFetchLike })
    const started = Date.now()
    let threw = ''
    await ch.request({ url: 'https://example.test/', bucket: 'write', timeoutMs: 20 }).then(() => {}, (e) => { threw = String((e as Error).message || e) })
    check(threw !== '', 'a timeout throws rather than returning a fake status', threw)
    check(Date.now() - started < 2000, 'the timeout fires the request level budget, not a much longer one')
    check(t.log.transport.length === 1, 'the failure is reported to outbound', JSON.stringify(t.log.transport))
    check(t.log.transport[0] && t.log.transport[0].reason === 'timeout', "the reason is 'timeout'", JSON.stringify(t.log.transport[0]))
    check(t.log.transport[0] && t.log.transport[0].service === 'linear', "the service defaults to 'linear'", JSON.stringify(t.log.transport[0]))
    check(t.log.releases === 1, 'the slot is still released', String(t.log.releases))
  }

  console.log('H5 a caller cancellation is a cancellation, not a path failure')
  {
    const c = fakeOutbound()
    const controller = new AbortController()
    const ch = createHttpChannel({ outbound: c.control, fetchImpl: (async (_u, init) => new Promise((_res, rej) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => rej(new Error('aborted by caller')))
    })) as unknown as HttpFetchLike })
    const p = ch.request({ url: 'https://example.test/', signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await p.then(() => {}, () => {})
    check(c.log.transport.length === 0, 'a cancelled request reports no transport failure', JSON.stringify(c.log.transport))
    check(c.log.releases === 1, 'the slot is still released', String(c.log.releases))
  }

  console.log('H6 a runtime without fetch fails loudly')
  {
    const g = globalThis as unknown as { fetch?: unknown }
    const saved = g.fetch
    const n = fakeOutbound()
    // Simulate a runtime without fetch by injecting null and clearing the global for this check.
    const ch = createHttpChannel({ outbound: n.control, fetchImpl: null })
    g.fetch = undefined
    let msg = ''
    await ch.request({ url: 'https://example.test/' }).then(() => {}, (e) => { msg = String((e as Error).message || e) })
    g.fetch = saved
    check(/no fetch implementation/.test(msg), 'the failure names the missing capability', msg)
    check(n.log.acquires.length === 0, 'no slot is taken when the runtime cannot send at all', JSON.stringify(n.log.acquires))
  }

  console.log('H7 the channel writes no log event of its own')
  {
    // 注释里可以出现「日志」，真正的记账调用不行：logEvent( 或 .fire( 一出现，就说明有人在通道里加了一条，
    // 而那必须先去 research/489-appendix.md 登记事件、再改 tests/verify-log-fields.ts；这道断言把顺序钉住。
    const source = readFileSync(new URL('../src/host/platform/httpChannel.ts', import.meta.url), 'utf8')
    check(!/logEvent\s*\(/.test(source) && !/\.fire\s*\(/.test(source),
      'the channel contains no logging call')
    const n = fakeOutbound()
    const ch = createHttpChannel({ outbound: n.control, fetchImpl: (async () => { throw new Error('down') }) as unknown as HttpFetchLike })
    await ch.request({ url: 'https://api.linear.app/graphql' }).then(() => {}, () => {})
    check(n.log.transport.length === 1,
      'a failure stays locatable: it reaches the outbound gate, which records the cooldown line',
      JSON.stringify(n.log.transport))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('gate crashed:', e); process.exit(2) })
