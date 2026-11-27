/**
 * src/tracker/kernel/grouping.ts —— 票的分组与分层的判定本体（房间与宿主共用的纯判定件）
 *
 * 出处：#1768 把这段判定从 src/tracker/body-parse.ts 原样搬来。搬动的唯一原因是那个文件随「跨容器
 * 阻塞者按引用态收口」变长后顶过 350 有效行上限（有效行口径见 scripts/lib/effective-lines.mts）；
 * 分组与分层本来就是「票号 + 状态 + 认领 + 阻塞」这几格的纯判定，不是正文解析，住共享内核更合适。
 * 函数体、注释、对外形状一律原样保留；body-parse 继续把 computeLevels / groupTickets 与几个类型
 * 转出去，宿主装配（src/host/tracker/snapshotAssemble.ts）、deck 读工具与门禁的 import 路径不变。
 *
 * 为什么住内核：同目录 README.md 的口径是「房间与宿主都要用、又不是类型与数据」的判定件归口。
 * 这里正合适：frontier / claimed / blocked 三个身份由本文件一个人说了算，不再另造词。
 *
 * 两份副本：本文件与 src/host/ticketGrouping.ts 是同一套判定的两份副本（后者零依赖，供宿主动态
 * import）；改一处必须同步改另一处，tests/verify-map-first-frame.ts 的 I 组用例逐项交叉核对两份的
 * 计数与层级。客户端卡片（src/client/views/mapDetailV2/model/tickets/ticketCardFacts.ts）按同一口径
 * 判状态。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 分组与分层：判定本体（#1768 从 src/tracker/body-parse.ts 原样搬来，供房间与宿主共用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 分组与分层只读票上这几格。字段一律从后端回包或老快照来，所以除票号外都按未知收口：
 * 缺一格、或者某个格不是期望的类型，都由这里的运行时判断兜住（`t.state === 'CLOSED'` 这类比较）。
 */
export interface GroupingTicket {
  /** 票号。分层与分组都拿它当键（拼进对象键时会被 JS 转成字符串）。文字键的行（Linear 的 ENG-101）没有票号，这一格缺席，改用 `key` 当键。 */
  number?: number | null
  /** 文字键。只在没有票号时当身份用（见 computeLevels 里的 idOf）；有票号的行不读它。 */
  key?: string | null
  /** 状态。只有大写 `'CLOSED'` 算已关闭，其余（含缺席、别的写法）都算未关闭 —— 与老口径一致。 */
  state?: string
  /** 认领人。有值（非空串、非 null）算已认领；缺席或空串算「没人认领」。 */
  claimedBy?: unknown
  /**
   * 直接阻塞我的票号。声明成**必填**，因为本文件两处读它的口径本来就不一样，而且两处都逐字保留了老写法：
   *   · `computeLevels` 查阻塞者表时写的是 `(t.blockedBy || [])`——缺了这一格就按「没有阻塞者」；
   *   · 层内统计与 `groupTickets` 在读它之前先认是不是数组——缺了这一格（不是数组）按「阻塞者不知道」算挡着，不再当场抛（#50 评审，见 blockerBlocks 下面那段说明）。
   * 类型按更严的那一处收（必填）：真数据里要么这一格是数组，要么根本没有这张票。
   * 想把两处统一成「缺了就按空数组」，那是另一件事，别在类型迁移里顺手改（见本文件尾部说明）。
   */
  blockedBy: readonly (number | string)[]
  /**
   * 阻塞者引用态旁表（#1768）：`blockedBy` 里每个引用在本行带得动的信息——编号之外还可能有标题与状态。
   * 只有在阻塞者不属于本批票时才有用：那时 `blockedBy` 里只剩编号，本批查不到人，只能靠这一格判断
   * 「跨容器的那张票到底关没关」。读不到状态就表示未知。
   *
   * 为什么是旁表、不改 `blockedBy` 的编号语义：编号是三条取数来路（快照 / 按需取回 / deck 派生）共用的
   * 稳定键，状态是会变的信息；混进同一个数组会让每个消费方都得先认形状。
   */
  blockedByRefs?: readonly BlockingRef[]
}

/** 一条阻塞者引用：编号必能折出（折不出的引用在装配阶段就丢掉了），标题与状态有才带。 */
export interface BlockingRef {
  /** 阻塞者编号（数字或数字串，与 `blockedBy` 里那一格同值）。 */
  key?: number | string | null
  /** 阻塞者标题。有的话，跨容器的「被 #N 挡住」卡片能直接把标题写出来。 */
  title?: string | null
  /** 阻塞者状态（后端原文，比较时统一大写）。缺席表示读不到，按未知收口。 */
  state?: string | null
}

/** 同深度的一层票与状态细分。 */
export interface TicketLevel {
  /** 深度：没有阻塞者的票是 0，其余是「直接阻塞者深度的最大值 + 1」。 */
  level: number
  /** 这一层的票号；没有票号的行（Linear 的 ENG-101）放它的文字键。 */
  numbers: (number | string)[]
  /** 这一层的全部票数。 */
  total: number
  /** 这一层里未关闭的张数。 */
  open: number
  /** 这一层里已关闭的张数。 */
  closed: number
  /** 这一层里可接的张数（未关闭、没被认领、阻塞都关掉了）。 */
  frontier: number
  /** 这一层里已被认领的张数。 */
  claimed: number
  /** 这一层里被仍然开着的票阻塞的张数。 */
  blocked: number
}

/** 分层结果：逐票的深度 + 按深度归拢的层（层按深度升序、无空洞）。 */
export interface LevelsResult {
  /** 票号 → 深度。键是字符串（对象键的固有形态），值是 0 起的整数。 */
  byNumber: Record<string, number>
  /** 每层一条，按深度升序；中间没有票的深度不会出现。 */
  levels: TicketLevel[]
}

// ——— 阻塞判定的唯一口径（本文件与 src/host/ticketGrouping.ts 两份副本必须逐字同源，#1768） ———

/**
 * 编号规范键：补零、带前后空白的写法折成同一个键（' 01 ' / '01' / 1 都折成 '1'）。
 * 与客户端 `numberKeyOf` 同一套折法——跨容器引用比对时两边不能各认各的写法。
 */
function refKeyOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const ref = value as { key?: unknown; number?: unknown }
    const inner = ref.key !== null && ref.key !== undefined ? ref.key : ref.number
    return inner === null || inner === undefined ? '' : refKeyOf(inner)
  }
  const raw = String(value).trim()
  if (!raw) return ''
  const digits = /^0*(\d+)$/.exec(raw)
  return digits ? String(Number(digits[1])) : raw
}

/**
 * 这张票是不是被 `blocker` 挡住（#1768：跨容器的票不再一律算可接）。
 *
 * 两种情形分开判：
 *  · 阻塞者在本批票里：沿用老口径，只有明确 `'OPEN'` 才算挡（状态不明的本批票不算挡——本来就在手边，
 *    行状态由别处收口）；
 *  · 阻塞者不在本批：看本行的引用态旁表 `blockedByRefs`。明确 `'CLOSED'` 不算挡；明确 `'OPEN'`、
 *    读不到状态、连对应引用都找不到——一律按挡着收口。这是安全侧：与 deck 派生把 NOT-FOUND 算 blocked
 *    （src/tracker/deck-derive.ts:203-218）同侧，宁可少说一张可接，也不把还被挡着的票推给人做。
 *
 * 找不到旁表时按挡着算，是有意的：老快照、别的取数来路没有这一格，但它们给的都是编号，
 * 「编号在、人不在本批」本身就是「还可能在挡着」的证据，不能当成可接。
 *
 * 同一条逻辑往前一步：整张票的 `blockedBy` 缺席（不是数组）= 阻塞者不知道（后端没给全，例如 Linear 一行的关系多过一页），
 * 层内统计与 groupTickets 在问到 blockerBlocks 之前就按挡着收口（CODING_STANDARDS「Keep unknown relationships unknown」）；
 * 数组（含空数组 = 确认没人挡）才逐个问它。与 src/host/ticketGrouping.ts 同一口径，改一处必须同步改另一处。
 */
function blockerBlocks(ticket: GroupingTicket, blocker: number | string, byNum: Record<string, GroupingTicket>): boolean {
  const key = refKeyOf(blocker)
  const local = byNum[key]
  if (local !== undefined) return local.state === 'OPEN'
  const refs = Array.isArray(ticket.blockedByRefs) ? ticket.blockedByRefs : []
  let seen = false
  for (const ref of refs) {
    if (refKeyOf(ref) !== key) continue
    seen = true
    const state = ref && ref.state != null ? String(ref.state).trim().toUpperCase() : ''
    if (state !== 'CLOSED') return true
  }
  // 有旁表但全说 CLOSED → 不挡；一条对应引用都没找到 → 按未知挡着收口。
  if (!seen) return true
  return false
}

/**
 * 一张票在分层与分组里的身份：有票号就用票号（数字房间与从前一字不变，仍是 number 类型），没有票号的行
 * （Linear 的 ENG-101，键里解析不出数字）退回文字键（经 refKeyOf 折过空白与补零）。两样都没有给空串。
 *
 * 为什么导出：快照装配（src/host/tracker/snapshotAssemble.ts）与两条电话路（session-snapshot-cache.ts、
 * session-refresh-schedule.ts）要按「分层结果的键」回头查每一行的层级、并给阻塞者写「挡住谁」；
 * 它们若各自再写一遍「看 number」，文字键的行就又会被漏掉（#64）。所以这条规则只在这里写一次，
 * 它们 import 这一个函数；返回值拼进对象键时按 String(...) 用，与 computeLevels 的 byNumber / levelOf 的键同形。
 * 宿主副本 src/host/ticketGrouping.ts 不能 import（零依赖、动态加载），自带同一句，由 tests/verify-64-text-key-level-blocks.ts 核对。
 * 反例：不要拿 `t.number ?? t.key` 直接当键——文字键没过 refKeyOf，' ENG-1 ' 与 'ENG-1' 会成两个键，与分层结果对不上。
 */
export function ticketIdentityOf(t: { number?: number | null; key?: string | null }): number | string {
  return t.number !== undefined && t.number !== null ? t.number : refKeyOf(t.key)
}

// ——— computeLevels：blockedBy DAG 最长路径深度分层（level(root)=0；level(x)=1+max(level(直接阻塞者))） ———

/**
 * 按阻塞关系给每张票算深度。
 *
 * 图由 `blockedBy` 给出（「谁阻塞我」是唯一真源，反向的「我阻塞了谁」不在这里推）。
 * 指向票池之外的票号（破链）按叶子算：查不到就当没有阻塞者，深度 0 —— 与老口径一致。
 */
export function computeLevels(tickets: readonly GroupingTicket[]): LevelsResult {
  // 票号表：每张票都在里面，所以下面查不到只可能是「阻塞者不在本批票里」。
  // 键走 refKeyOf：'01'、1、' 1 ' 必须落在同一格，否则跨容器比对会认错人。
  // 票的身份见上面导出的 ticketIdentityOf：有票号就用票号（数字房间一字不变），没有票号的行（Linear 的 ENG-101）退回文字键。
  // 为什么不能只认 t.number：文字键的行没有票号，所有这类行会挤进同一个 undefined 格，本批内的阻塞者查不到、层级全是 0（PR #62 评审）。
  // 这条规则只在 ticketIdentityOf 写一次；宿主那份副本 src/host/ticketGrouping.ts 零依赖、不能 import，只能自带一份，由
  // tests/verify-64-text-key-level-blocks.ts 的 D 组逐样本核对两份答同一个键（#64）。
  const idOf = ticketIdentityOf
  const byNum: Record<string, GroupingTicket> = {}
  tickets.forEach((t) => { byNum[refKeyOf(idOf(t))] = t })
  // 只在计算层级时把互相可达的票视为同一层；原有阻塞关系和状态不变。非循环的边仍按最长路径分层。
  // 两次遍历均使用显式栈，避免长依赖链或循环耗尽调用栈；宿主副本保持同一口径。
  const edges = new Map<GroupingTicket, GroupingTicket[]>()
  const reverse = new Map<GroupingTicket, GroupingTicket[]>()
  for (const t of tickets) reverse.set(t, [])
  for (const t of tickets) {
    const blockers = (t.blockedBy || []).map((b) => byNum[refKeyOf(b)]).filter((b) => reverse.has(b))
    edges.set(t, blockers)
    for (const b of blockers) reverse.get(b)!.push(t)
  }
  const finished: GroupingTicket[] = []
  const seen = new Set<GroupingTicket>()
  for (const t of tickets) {
    if (seen.has(t)) continue
    seen.add(t)
    const pending = [{ ticket: t, next: 0 }]
    while (pending.length) {
      const frame = pending[pending.length - 1]
      const neighbors = edges.get(frame.ticket)!
      if (frame.next === neighbors.length) { finished.push(frame.ticket); pending.pop(); continue }
      const b = neighbors[frame.next++]
      if (!seen.has(b)) { seen.add(b); pending.push({ ticket: b, next: 0 }) }
    }
  }
  const componentOf = new Map<GroupingTicket, number>()
  const components: GroupingTicket[][] = []
  for (const t of finished.reverse()) {
    if (componentOf.has(t)) continue
    const component = components.length
    const members = [t]
    components.push(members)
    componentOf.set(t, component)
    for (let i = 0; i < members.length; i++) {
      for (const dependent of reverse.get(members[i])!) {
        if (!componentOf.has(dependent)) { componentOf.set(dependent, component); members.push(dependent) }
      }
    }
  }
  // 反向迭代时，每个组的外部阻塞者都已经有层级；组内没有办法满足严格的先后顺序。
  const depth: number[] = []
  for (let i = components.length - 1; i >= 0; i--) {
    depth[i] = 0
    for (const t of components[i]) for (const b of edges.get(t)!) {
      const blocker = componentOf.get(b)!
      if (blocker !== i) depth[i] = Math.max(depth[i], depth[blocker] + 1)
    }
  }
  const byNumber: Record<string, number> = {}
  tickets.forEach((t) => { byNumber[idOf(t)] = depth[componentOf.get(t)!] })
  // 先按深度就位（下标即深度，中间没票的位置留空洞），最后再压掉空洞。
  const levels: (TicketLevel | undefined)[] = []
  tickets.forEach((t) => {
    const lv = byNumber[idOf(t)]
    let layer = levels[lv]
    if (!layer) { layer = { level: lv, numbers: [], open: 0, closed: 0, total: 0, frontier: 0, claimed: 0, blocked: 0 }; levels[lv] = layer }
    layer.numbers.push(idOf(t))
    layer.total++
    if (t.state === 'CLOSED') layer.closed++
    else layer.open++
  })
  // 层内状态细分（frontier/claimed/blocked 归层）：判定走 blockerBlocks，与本文件 groupTickets、
  // 宿主 src/host/ticketGrouping.ts 同一口径（跨容器引用按引用态收口，#1768）。
  levels.forEach((layer) => {
    // 稀疏数组的空洞不会被 forEach 访问，这一句只是让编译器知道 layer 一定在。
    if (!layer) return
    const openT = tickets.filter((t) => byNumber[idOf(t)] === layer.level && t.state === 'OPEN')
    layer.frontier = openT.filter((t) => !t.claimedBy && !(!Array.isArray(t.blockedBy) || t.blockedBy.some((b) => blockerBlocks(t, b, byNum)))).length
    layer.claimed = openT.filter((t) => t.claimedBy).length
    layer.blocked = openT.filter((t) => !t.claimedBy && (!Array.isArray(t.blockedBy) || t.blockedBy.some((b) => blockerBlocks(t, b, byNum)))).length
  })
  // 剔除空洞（levels 数组可能因跳级出现 undefined）
  const compact = levels.filter((layer): layer is TicketLevel => Boolean(layer))
  return { byNumber: byNumber, levels: compact }
}

/** 分组结果：各状态计数 + DAG 分层（面板的漏斗与层级都用这一份）。 */
export interface TicketGroups {
  total: number
  open: number
  closed: number
  frontier: number
  claimed: number
  blocked: number
  /** 按深度归拢的层，见 computeLevels。 */
  levels: TicketLevel[]
  /** 票号 → 深度。 */
  levelOf: Record<string, number>
}

// ——— groupTickets：open/closed/frontier/claimed/blocked 分组 + 附 DAG 分层（v1.4 T1 #442） ———

/**
 * 把一批票分成 open/closed/frontier/claimed/blocked 五组，并附上 DAG 分层。
 *
 * 五组里只有 open/closed 是「按状态分组」，另外三组是**可以重叠**的视角：
 * frontier 是「未关闭、认领已知且空、阻塞都关掉了」（#1 明确写着的可接票），
 * claimed 是「有人认领」，blocked 是「还有开着的票挡着」。
 *
 * #1768：阻塞者不在本批票里时不再默认「不算挡」——看本行 `blockedByRefs` 的引用态，
 * 明确 CLOSED 才放行，OPEN / 未知 / 没有旁表都按挡着收口。判定细节见 blockerBlocks。
 * 本函数与 src/host/ticketGrouping.ts 的同名函数是两份副本，必须同一口径；
 * tests/verify-map-first-frame.ts 有交叉核对，改一处必须同步改另一处。
 */
export function groupTickets(tickets: readonly GroupingTicket[]): TicketGroups {
  // 票号缺席的行（Linear 的 ENG-101）按文字键进索引，与 computeLevels 用同一条身份规则（ticketIdentityOf）。
  const byNum: Record<string, GroupingTicket> = {}
  tickets.forEach((t) => { byNum[refKeyOf(ticketIdentityOf(t))] = t })
  const open = tickets.filter((t) => t.state === 'OPEN')
  const closed = tickets.filter((t) => t.state === 'CLOSED')
  const frontier = open.filter((t) => !t.claimedBy && !(!Array.isArray(t.blockedBy) || t.blockedBy.some((b) => blockerBlocks(t, b, byNum))))
  const claimed = open.filter((t) => t.claimedBy)
  const blocked = open.filter((t) => !t.claimedBy && (!Array.isArray(t.blockedBy) || t.blockedBy.some((b) => blockerBlocks(t, b, byNum))))
  // v1.4（T1 #442）：附 DAG 分层（client 渲染漏斗分层用）
  const lv = computeLevels(tickets)
  return {
    total: tickets.length, open: open.length, closed: closed.length,
    frontier: frontier.length, claimed: claimed.length, blocked: blocked.length,
    levels: lv.levels, levelOf: lv.byNumber,
  }
}
