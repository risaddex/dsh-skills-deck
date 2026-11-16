/**
 * src/host/platform/httpChannel.ts —— HTTP 通道的宿主实现（契约形状见 src/tracker/contract/contexts.ts 的 `HttpChannel`）
 *
 * ── 这个文件解决什么 ─────────────────────────────────────────────────────────
 * 房间不许直接用全局 `fetch`，而 Linear 没有命令行工具 —— 一等后端里出现了「想发一个请求，
 * 没有任何合法通道」的空档（#24 的决定）。这里把空档补上，而不是给那一间房开例外。
 *
 * ── 通道自己管出站，房间不管 ─────────────────────────────────────────────────
 * 每一次请求都先向 `ctx.outbound` 拿名额、跑完上报结局：
 *   · 拿到任何 HTTP 响应（含 4xx/5xx）＝通路是通的 → `reportSuccess` 清冷却；
 *   · 连接失败、超时、被掐断 ＝ 通路不通 → `reportTransportFailure` 设冷却；
 *   · 写请求成功 → `noteWrite`（写过东西之后来的探测不搭旧车）；
 *   · 调用方取消 → 按取消返回，不记成通路失败。
 * 若让房间各自拿名额，不同房间迟早用不同方式拿，名额闸就退化成建议 —— 那正是
 * `src/tracker/contract/outbound.ts` 末尾一节说「不许静默直通」的意思。
 *
 * ── 失败怎么回：起不来是异常，有回话就是成功 ─────────────────────────────────
 * 传输层失败**抛错**，不返回假状态码；拿到响应就正常返回，由房间按自己的协议解读
 * （Linear 的 GraphQL 会在 HTTP 200 里带 `errors[]`，那是房间的事，不是通道的事）。
 * 这条分界与 `exec` 一致：进程起不来是异常，跑完有退出码就是回话。
 *
 * ── 这里不新增日志事件（有意为之） ───────────────────────────────────────────
 * 一次传输失败已经由 `outbound.reportTransportFailure` 记进常驻事件 `gh.transport`（冷却设上、
 * 被挡回、清零三档），再在这里加一条只会重复同一件事；成功请求每次一行又会变成心跳噪声，
 * 而 `docs` 的日志纪律明确不许加。所以本文件一行日志都不发：要查「这次为什么没发出去」看
 * `gh.transport`，要查「这次发了什么」看调用它的房间自己的结局。
 *
 * ── 注入点 ───────────────────────────────────────────────────────────────────
 * 与 `createOutboundControl` 同一条路，三处都要挂：
 *   · `src/host/platformChannel.ts` 的 `backendCtxForRooms`
 *   · `src/refresh/registry/deck-tool-bridge.ts` 的 backendObj
 *   · `src/refresh/rooms/host/refresh-runtime.ts` 的 backendObj
 * 缺一处，那条路上的房间会按环境失败（有意为之：宁可大声报错，也不静默绕过名额闸）。
 */

import type { HttpChannel, HttpRequest, HttpResponse } from '../../tracker/contract/contexts.js'
// #24：单次请求的时间预算不在这里写数字 —— 它按桶取中央时间参数里那一档（值与 gh 的出站档同一份）。
import { timeoutForTier } from '../../tracker/kernel/outbound-tiers.js'
import type { OutboundService } from '../../tracker/contract/outbound.js'
import type { OutboundControl } from '../../tracker/contract/outbound.js'

/** fetch 的最小形状：只声明本通道用到的几格，测试替换时不必造一个完整的 Response。 */
export interface HttpFetchLike {
  (url: string, init: Record<string, unknown>): Promise<{
    status: number
    headers: { forEach(cb: (value: string, key: string) => void): void }
    text(): Promise<string>
  }>
}

export interface CreateHttpChannelOptions {
  /** 房间的出站控制面（同一份实例，不是再造一个）。 */
  outbound: OutboundControl
  /** 缺省通路口径：请求没给 `service` 时用它。 */
  service?: OutboundService
  /** 测试替换用；生产就是当前运行时的全局 fetch。 */
  fetchImpl?: HttpFetchLike | null
}

/**
 * 造一份 HTTP 通道。每次调用返回新对象，但名额与冷却在 `outbound` 背后是进程级单例，
 * 所以多处注入不会造成两套上限。
 */
export function createHttpChannel(options: CreateHttpChannelOptions): HttpChannel {
  const outbound = options.outbound
  const defaultService: OutboundService = options.service || 'linear'

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const bucket = req.bucket || 'read'
      const service = req.service || defaultService
      const method = req.method || 'GET'
      const fetchImpl = options.fetchImpl || (globalThis as unknown as { fetch?: HttpFetchLike }).fetch
      // 运行时没有 fetch 属于环境缺件，不是某一次请求的失败：直接抛，让调用方按环境失败报出来。
      if (typeof fetchImpl !== 'function') {
        throw new Error('this runtime has no fetch implementation, so the room cannot reach the network')
      }

      // 名额：排满就在这里等；等待期间被取消要能认出来（交给 outbound.isCancelled 认）。
      const release = await outbound.acquire({ bucket, service, signal: req.signal })

      // 调用方给了预算就用它的；没给按这一次的桶取中央档位（读 / 写 / 探活各一档，值与 gh 同源）。
      const timeoutMs = (typeof req.timeoutMs === 'number' && req.timeoutMs > 0) ? req.timeoutMs : timeoutForTier(bucket)
      const controller = new AbortController()
      let timedOut = false
      const onCallerAbort = (): void => { try { controller.abort() } catch { /* 已经中止过 */ } }
      if (req.signal) {
        if (req.signal.aborted) onCallerAbort()
        else req.signal.addEventListener('abort', onCallerAbort, { once: true })
      }
      const timer = setTimeout(() => { timedOut = true; try { controller.abort() } catch { /* 已经中止过 */ } }, timeoutMs)

      try {
        const response = await fetchImpl(req.url, {
          method,
          headers: req.headers || {},
          body: req.body,
          signal: controller.signal,
        })
        const body = await response.text()
        const headers: Record<string, string> = {}
        try { response.headers.forEach((value, key) => { headers[String(key).toLowerCase()] = value }) } catch { /* 头读不出来就当没有 */ }

        // 拿到响应就是通路通了 —— 4xx/5xx 也算，那是有回话。
        outbound.reportSuccess({ bucket, service })
        if (bucket === 'write') outbound.noteWrite()
        return { status: response.status, headers, body }
      } catch (error) {
        // 调用方取消（含排队期间被取消）：不算通路失败，原样抛给调用方按取消处理。
        if (outbound.isCancelled(error) || (req.signal && req.signal.aborted && !timedOut)) throw error
        // 超时与被掐断都是传输层失败：设冷却，让同一只桶的后续调用别再各自赔满一次超时。
        outbound.reportTransportFailure({ bucket, service, reason: timedOut ? 'timeout' : 'spawn-failed' })
        throw error
      } finally {
        clearTimeout(timer)
        if (req.signal) { try { req.signal.removeEventListener('abort', onCallerAbort) } catch { /* 没有监听器 */ } }
        // 名额必须放回：漏放会永久占掉一个（见 outbound.ts 的 acquire 注释）。
        try { release() } catch { /* 放回失败不覆盖本次结果 */ }
      }
    },
  }
}
