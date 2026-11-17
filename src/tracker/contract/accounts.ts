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
 * 账号缝：宿主实现、随进程注入一次，房间只认形状。
 *
 * 为什么 `resolve` 是异步且每次都可调用：OAuth 的访问令牌会过期，而一次 `create()` 时拿到的值
 * 到会话中途就不好用了；由缝隙每次问、自己缓存（按 (别名, token) 缓存，token 变了就重探），
 * 房间不必关心刷新。
 */
export interface AccountSeam {
  /** 按别名取这一趟的账号；`signal` 用于调用方放弃时连解析一起放弃。 */
  resolve(alias: string, signal?: AbortSignal): Promise<AccountSeamResult>
}
