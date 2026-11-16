/**
 * src/tracker/rooms/github/model/issue-key.ts —— 「仓库坐标」的解析助手（#1687 从房间根抽出来）。
 *
 * 为什么住 model：这里只做纯字符串解析，不发请求、不读上下文，属于可被读写两侧共用的数据形状。
 * 为什么抽出来：parseRepo / repoId 原先在 issues.ts、labels.ts、graph.ts、comments.ts 里各抄了一份，
 * 四份函数体逐字相同。分层之后写侧要解析仓库坐标、读侧也要（read/labels.ts），可读侧不能反过来引用
 * 写侧文件，于是把这段纯解析放到双方都能引用的 model 层，谁都不必再抄第五份。
 * 行为零变化：函数体与原四份一字不差，返回值语义完全照旧（refId 形不对回 null / 空串，不抛）。
 */

import type { RepositoryRef } from '../../../contract/entities.js';

/** 仓库坐标：拥有者与仓库名，refId 形不对就回 null 而不是抛。 */
export interface ParsedRepo {
  owner: string;
  name: string;
}

/** 把 `{refId: "owner/name"}` 拆成拥有者与仓库名；refId 缺失或形状不对回 null。 */
export function parseRepo(repo: RepositoryRef | null | undefined): ParsedRepo | null {
  if (!repo || typeof repo.refId !== 'string' || !repo.refId) return null
  const s = repo.refId.trim()
  const idx = s.indexOf('/')
  if (idx <= 0) return null
  return { owner: s.slice(0, idx), name: s.slice(idx + 1) }
}

/**
 * 仓库口径的标识串：优先 refId，其次 name，都没有回空串（调用方按「缺仓库标识」处理）。
 *
 * 本函数**保持原样**，不去收紧：它返回的是「这个身份里写着的最像 id 的那串」，不负责判断
 * 那串能不能当身份用。要印进报错、要写进日志、要拿去拼地址的地方一律用 `repoIdentityText`——
 * 那条才负责拒绝把工作区目录名当仓库（#22 的教训在这里：`describe` 只拿到目录时回的是
 * `{refId: '', name: 'dsh-skills-deck'}`，旧报错把这个目录名当 id 印了出来）。
 */
export function repoId(repo: RepositoryRef | null | undefined): string {
  if (!repo) return ''
  if (typeof repo.refId === 'string' && repo.refId) return repo.refId
  if (typeof repo.name === 'string' && repo.name) return repo.name
  return ''
}

/**
 * 报错文案与日志里的「仓库是谁」：解析出来就是 `owner/name`；解析不出来就明说没解析出来，
 * 并把工作区目录名作为线索写进去（写成线索，不写成标识）。
 *
 * 两条判据与 `repoId` 不同，是故意的：`refId` 非空才算身份；`name` 只有本身就是 `owner/name`
 * 形态时才算（离网后端只填 name 的老口径照旧），因为 GitHub 的 `describe` 只拿到目录时，
 * `name` 是目录名。目录名不是身份，把它当 id 印出来会让「没解析出仓库」读成
 * 「仓库解析到了、只是 refId 丢了」，排查方向被带到 keyring 的 token 上（#22 的现场）。
 *
 * 为什么还带目录名：一条「repo.refId missing: 」的报错，读的人只知道少了什么，不知道少了谁、
 * 该去哪儿找；写成 `(the workspace folder is "x", which is not a repository id)` 既给了线索，
 * 又明说它不是仓库 id。
 */
export function repoIdentityText(repo: RepositoryRef | null | undefined): string {
  const refId = (repo && typeof repo.refId === 'string') ? repo.refId : ''
  if (refId) return refId
  const name = (repo && typeof repo.name === 'string') ? repo.name : ''
  if (name && name.indexOf('/') > 0) return name
  return name
    ? ('no owner/repository was resolved (the workspace folder is "' + name + '", which is not a repository id)')
    : 'no owner/repository was resolved'
}

export default { parseRepo, repoId, repoIdentityText }
