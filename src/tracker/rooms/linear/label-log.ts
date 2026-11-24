/**
 * src/tracker/rooms/linear/label-log.ts —— 标签那一步的两条结论线（#92）
 *
 * 为什么要有这个文件：把标签名换成标签 id 是 Linear 房里唯一「先读一次、缺的再建、最后才写票」的一段，
 * 而它此前一条日志都不落。于是 #85 报的那个现场（工作区里的标签拼作 `Bug`，请求写的是 `bug`，
 * 建 `bug` 又被 Linear 拒绝）事后只能从回执反推：日志里既没有「这一次确实靠忽略大小写对上了」，
 * 也没有「建标签这一步被拒了」。这两件事正是这一族要能回答的问题，所以各开一条线：
 *
 *   · `label.resolve.match`（信息级，常驻）：请求里的某个名字，是被一个**拼写不同**的已有标签满足的
 *     （例：要 `bug`、对上了 `Bug`）。这一条记的是「修好之后正常运行」的样子 —— 只记被拒的那一条，
 *     就永远看不出忽略大小写的匹配到底有没有生效。
 *   · `label.resolve.fail`（告警级，常驻）：要为缺的名字新建标签时被后端拒绝，票没建也没改。
 *
 * 为什么两条都定常驻（信息那条也在常驻名单里）：两条都由人/AI 的一次显式动作触发，一次调用至多各一行，
 * 不会刷屏；而查「这张票的标签为什么没贴上」的人正是出事之后才来翻日志，不会先去打开调试开关。
 *
 * 为什么两条分开、不合成一条两级别：本仓日志的规矩是一个事件名一个级别（附录第 1 章的行按事件名登记、
 * 计数门禁按名字数条数、级别写在行里），同一名字发两个级别会让「这一条到底该不该始终落盘」说不清。
 *
 * 字段与隐私：只记数字、短枚举与散列。**标签名原文一个字都不记**（与既有 `labelColors.listed` 同一口径）——
 * 名单要给人看的时候写在回执的 message 里，那是给人读的一次性回答；日志要长期留在盘上，只留
 * 「这一趟有几个名字、折了几个、和上次是不是同一批」这三个问题的答案，所以名字只以短散列出现。
 *
 * 守卫：两条都不判调试开关（常驻），但都走内核的 `guardEmit` 壳 —— 拿不到 `logEvent` 的瘦上下文、
 * 或者日志本身写坏，都不许让这一趟改标签失败（同 `src/tracker/kernel/log-emit.ts` 的承诺）。
 *
 * 为什么事件名在调用点写成字面量、不抽成常量：全仓的字段白名单门禁
 * （`tests/verify-log-fields.ts`）是照着源码认形状的 —— 它只认 `logEvent('info', 'label.resolve.match', { … })`
 * 这种「事件名与字段字面量就摆在调用点旁边」的写法。抽成常量以后门禁在源码里找不到这两个名字，
 * 会把它们判成「全仓未找到」。同样的理由写在 `src/tracker/kernel/log-emit.ts` 的文件头。
 */
import type { OpContext } from '../../contract/contexts.js'
import { guardEmit, ms } from '../../kernel/log-emit.js'

/**
 * 一小段文本的短散列（32 位 DJB2，写成 8 位十六进制）。只用来看「两次是不是同一批名字」，
 * 原文不落盘；转不过去时给一个固定值，宁可少一个信号，也不让日志抛错。
 */
function shortHash(text: unknown): string {
  try {
    const s = String(text == null ? '' : text)
    let h = 5381
    for (let i = 0; i < s.length; i += 1) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0)
    return ('0000000' + h.toString(16)).slice(-8)
  } catch {
    return '00000000'
  }
}

/** 名字对的散列原料：`请求的名字→对上的名字`，一行一对，只用于算散列。 */
function pairsText(pairs: Array<{ wanted: string; found: string }>): string {
  return pairs.map((one) => one.wanted + '→' + one.found).join('\n')
}

/** 一次解析里「谁靠忽略大小写对上」那一格的事实。 */
export interface LabelMatchFacts {
  /** 这一次请求了几个名字（去重之后）。 */
  requested: number
  /** 靠忽略大小写对上的那些对（请求的写法 → 后端已有的写法）。 */
  folded: Array<{ wanted: string; found: string }>
  /** 这一趟从进 `resolveLabelIds` 起算的时刻，用来记消耗时长（毫秒）。 */
  startedAt: number
}

/**
 * 记一行「这一次靠忽略大小写对上了几个名字」。
 *
 * 一条解析最多落一行（不按名字各记一行）：要回答的是「这一趟有没有走过这条路」，不是「逐名字的流水」。
 * 一个都没折的时候也记：`folded: 0` 与「这一条根本没发」在日志里是两件不同的事 —— 前者说这一趟
 * 查过、一个都没对上折写，后者说这一趟连这里都没走到。
 */
export function emitLabelMatch(ctx: OpContext | null | undefined, facts: LabelMatchFacts): void {
  guardEmit(ctx, (c) => {
    c.logEvent('info', 'label.resolve.match', {
      requested: facts.requested,
      folded: facts.folded.length,
      namesHash: shortHash(pairsText(facts.folded)),
      latencyMs: ms(Date.now() - facts.startedAt),
      opId: String(c.opId || ''),
    })
  })
}

/** 一次「建标签被拒」的事实。 */
export interface LabelCreateFailFacts {
  /** 这一次请求了几个名字（去重之后）。 */
  requested: number
  /** 还没建成的全部名字：被拒的那一个加上后面还没试的（与回执 message 里列的名单同一份）。 */
  missing: string[]
  /** 后端给的错误档位（权限被拒是 auth），与回执里的 `errorKind` 同一档。 */
  kind: string
  /** 这一趟从进 `resolveLabelIds` 起算的时刻。 */
  startedAt: number
}

/**
 * 记一行「建标签这一步被拒了，票没建也没改」。
 *
 * 为什么带 `kind`：这一条此前最容易被读成「后端做不到」，而权限被拒（auth）与名字不合规（conflict）
 * 是两种完全不同的下一步 —— 前者要去 Linear 里把标签建好，后者要改名字。档位记下来，
 * 事后不必再去回执里找。
 */
export function emitLabelCreateFail(ctx: OpContext | null | undefined, facts: LabelCreateFailFacts): void {
  guardEmit(ctx, (c) => {
    c.logEvent('warn', 'label.resolve.fail', {
      kind: String(facts.kind || ''),
      missing: facts.missing.length,
      requested: facts.requested,
      namesHash: shortHash(facts.missing.join('\n')),
      latencyMs: ms(Date.now() - facts.startedAt),
      opId: String(c.opId || ''),
    })
  })
}
