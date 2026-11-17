/**
 * src/tracker/contract/accounts.ts —— 账号缝：房间问「以哪本账说话」时认的形状（#27 的决定）
 *
 * ── 这一件为什么在契约层 ──────────────────────────────────────────────────────
 * 凭据解析住在宿主（`src/host/linearAccounts.ts` 要读账号文档、问凭据服务要 token），而房间不许
 * import 宿主模块（`cross-room-import` 那条纪律）。于是在「房间会说话、却没有身份」处留下一个空档。
 * 契约层放这种「公共形状、没有实现」的东西：本文件只有类型，一行实现都没有。
 *
 * ── 过边界的是可用形态，不是 token ─────────────────────────────────────────────
 * 一次成功交出 `{ ok: true, alias, authorization, endpoint? }`：`authorization` 已经是直接可以放进
 * 请求头的那一串（API key 裸值或 `Bearer ...`）。房间拿到它就能发请求，不必理解 token 从哪来、
 * 什么时候过期 —— 那是宿主与登录流程（#19）的事。
 *
 * ── 为什么按别名解析，而不是「给我一本账」 ──────────────────────────────────────
 * 一个工作区用哪本账是**仓库的声明**（`docs/agents/issue-tracker.md` 的 `# Issue tracker: linear` 一节），
 * 不是宿主的配置。房间读自己的声明拿到别名，再问缝隙「这本账能用吗」。宿主于是不需要知道
 * 项目绑定，房间也不需要知道凭据存在哪。
 *
 * ── 失败用账号状态说，不用房间的错误档 ─────────────────────────────────────────
 * 失败是 `{ ok: false, status, message }`，`status` 取账号自己的状态（`needs_auth` /
 * `identity_mismatch` / `error` / `unconfigured`），因为下一步动作是按这四档分的：去登录、去确认
 * 组织、去看错误、去配置。房间再把这一档翻成自己的 `auth` / `env` 口径给上面看。
 *
 * ── 缺了会怎样 ───────────────────────────────────────────────────────────────
 * 与 `outbound` 同一条：不静默跳过。房间读不到账号缝时按环境失败大声报，并说清缺的是哪一格。
 */

/** 账号状态：这四档决定「下一步该做什么」，所以它们原样过边界。 */
export type AccountSeamStatus = 'needs_auth' | 'identity_mismatch' | 'error' | 'unconfigured'

/** 一本可用账号：别名 + 可直接放进请求头的凭据 + （可选）端点。 */
export interface AccountSeamResolved {
  /** 账号别名，例如 `ombrello`；只用于日志、错误与界面指认是哪一本账。 */
  alias: string
  /** 完整可用的 Authorization 头值（API key 裸值或 `Bearer ...`），由宿主拼好，房间不改写。 */
  authorization: string
  /** 端点；缺省表示用该后端自己的默认端点。 */
  endpoint?: string
}

/** 一次解析的两种结局：可用的一本，或带账号状态的失败。 */
export type AccountSeamResult =
  | ({ ok: true } & AccountSeamResolved)
  | { ok: false; status: AccountSeamStatus; message: string }

/**
 * 一本账的公开面貌：房间在「一次问全部」之前，先要知道有哪几本、各自按什么口径读。
 *
 * 为什么这里没有凭据：列账只回答「有哪些账、各自看哪个团队、review 怎么认」。真正发请求之前，
 * 每一本账还要单独走一次 `resolve`，凭据只在那一刻过边界；列账本身于是不产生可重放的秘密，
 * 也不必为了「只是想知道有哪些账」把每本账的 token 都解析一遍。
 */
export interface AccountSeamEntry {
  /** 账号别名，例如 `ombrello`；`alias:ENG-123` 里的 `alias` 就是它。 */
  alias: string
  /** 给人看的短标签；缺省时界面用别名代替。 */
  label?: string
  /** 这本账看的团队 key（大写）；空数组表示这本账不按团队收窄。 */
  teams: string[]
  /** 「需要 review」认哪些工作流状态名（正则源码），来自这本账自己的配置。 */
  reviewPattern: string
  /** 「需要 review」按什么范围取（`subscribed` / `team` / `assigned`），同样来自这本账。 */
  reviewScope: string
}

/** 一次列账的两种结局：账本清单，或与 `resolve` 同一套账号状态的失败。 */
export type AccountSeamListResult =
  | { ok: true; accounts: AccountSeamEntry[] }
  | { ok: false; status: AccountSeamStatus; message: string }

/**
 * 账号缝：宿主实现、随进程注入一次，房间只认形状。
 *
 * 为什么 `resolve` 是异步且每次都可调用：OAuth 的访问令牌会过期，而一次 `create()` 时拿到的值
 * 到会话中途就不好用了；由缝隙每次问、自己缓存（按 (别名, token) 缓存，token 变了就重探），
 * 房间不必关心刷新。
 */
export interface AccountSeam {
  /** 按别名取这一趟的账号；`signal` 用于调用方放弃时连解析一起放弃。 */
  resolve(alias: string, signal?: AbortSignal): Promise<AccountSeamResult>
  /**
   * 列出本机配置的全部账（#14 的决定 A）。
   *
   * 为什么要列在这里，而不是让房间自己读账号文档：文档在宿主手里，房间不许 import 宿主模块；
   * 而「有哪些账、各自看哪个团队」正是 `alias:ENG-123` 和 `account: '*'` 开口之前必须先知道的事。
   *
   * 为什么只列配置、不探活：探活是一次网络往返，列账不该为它付费，而 `deck_context` 是每个会话
   * 第一个调用的工具。真正还能不能用，在那本账被 `resolve` 的那一刻见分晓，那里本来就会报状态。
   */
  list(signal?: AbortSignal): Promise<AccountSeamListResult>
}
