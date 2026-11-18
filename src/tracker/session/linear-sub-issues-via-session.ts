/**
 * src/tracker/session/linear-sub-issues-via-session.ts —— 地图电话（wf.mapTickets）里 Linear 工作区取子票的那一条路（#50）
 *
 * 为什么单独一份文件：这段逻辑原先就写在 mapTickets.ts 里，写进去之后那份文件超过了仓库对单文件体积的上限，
 * 而它自己是一整件事（给 Linear 开只读会话、把操作编号补进会话上下文），拆出来行为一字不变。
 * 为什么住在 tracker 层的 session/ 而不是 src/host/：宿主目录里的文件之间不许互相引（`same-layer-import-host` 规则），
 * 而 mapTickets.ts 本来就静态引用这一层的共享补齐入口（session/repo-ref.ts），这份与它同属「宿主电话借会话做事」的共享件。
 * 谁调它：只有 src/host/mapTickets.ts 的 handleMapTickets，在选中的后端是 linear 时调一次；别的后端不进来。
 *
 * 为什么 Linear 要走只读会话：Linear 只走 HTTP（房间从递进来的上下文里取 `ctx.http` 与账号，见
 * rooms/linear/client.ts 的 channelOf）。地图电话自己拼的那份上下文只有 exec（它是给「跑命令」的房用的），
 * 递给 Linear 房必然回「the room has no HTTP channel wired (ctx.http is missing)」，一条请求都发不出去 ——
 * 与 #45 里 probe（refresh/rooms/host/probe-handler.ts）和翻页电话（issuePage.ts）犯过的是同一个错。
 * 所以 Linear 的子票照它们的做法走只读会话，会话的上下文带着 HTTP 通道与账号，也过闸、记账。
 * 房间那层的日志要靠 opId 与宿主那一行对上，会话给的上下文没有这一格，这里补进去（只补这一格，不改别的）。
 * 什么约定不能改：GitHub、GitLab 与本地 Markdown 保持在 mapTickets.ts 里那条直调路上（它们的记账与会话政策不一样，
 * 旧门禁按它钉住）；以后多一家只走 HTTP 的房，这一格与 probe、翻页电话那两格要一起改。
 *
 * 返回值：成功或失败都是房间原样的结果（`{ok, data|error}`）；会话没接好或开不起来时回 env 档的失败，
 * 话术点名是哪一步没成，不是「不支持」—— 这是接线缺件，要让维护者看见，不能被当成「这个后端不提供子票」悄悄跳过。
 */

import { ERROR_KIND } from '../contract/vocabulary.js'
import { fail } from '../kernel/preflight.js'

/** 取子票要用的几样东西：开会话的口子、工作区目录、仓库身份、父票的键、宿主这一趟的操作编号。 */
export interface LinearSubIssuesRequest {
  openSession?: any
  cwd: string
  repoRef: any
  key: string
  opId: string
}

/** 经只读会话向 Linear 要一张票的子票（见文件头）。 */
export async function listLinearSubIssues(req: LinearSubIssuesRequest): Promise<any> {
  const { openSession, cwd, repoRef, key, opId } = req
  if (typeof openSession !== 'function') {
    return fail(ERROR_KIND.ENV, 'The host did not connect the read session outlet (internally called openSession), so the child tickets were not read: a Linear workspace is read only through that session, which carries the HTTP channel and the account. Report this exact message to the plugin maintainer.', '')
  }
  const opened: any = await openSession(cwd)
  if (!opened || opened.ok !== true || typeof opened.call !== 'function') {
    return fail(ERROR_KIND.ENV, 'The read session for this workspace could not be opened (internally called openSession; reason: ' + String((opened && (opened.reason || opened.detail)) || 'open-failed') + '), so the child tickets were not read.', '')
  }
  return opened.call(function (session: any, c: any): any { return session.listSubIssues(repoRef, key, {}, Object.assign({}, c, { opId: opId })) })
}
