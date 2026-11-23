// work-path-record.ts —— 工具壳成功收口处的那一步「记一笔或释放一条」（#1261 建；#1086 加释放；#1262 铺满五个写工具；#1561 起不再带回执）。
//
// 为什么单列一份而不是写进 call-shell.ts：壳文件有效行已到 321，离 350 上限只剩 29 行，
// 这一步的分支（认哪些工具、认哪些票、失败写备注）展开要五十多行，会把壳顶超标。
// 本文件只 import 类型与同层的 work-path-receipt-read.ts（读回执的那一半，#80 拆出）；记与释放两支能力
// 由调用方以依赖注入（DeckShellDeps 的 workRouteNote / workRouteRelease）。读在办表走 deck_work_route，不在这里。
//
// 谁记、谁不记（规格 #1259 第 5、6、8 条，本票 #1262 铺满）：
//   写工具：deck_issue_report（动作 report、来源 reported）、deck_issue_create（create / auto）、
//           deck_issue_patch（edit / auto）、deck_map_plan_create（plan / auto）、deck_map_link（link / auto）。
//   读工具：deck_context、deck_issue_get、deck_issue_list、deck_map_snapshot —— 一次都不记。
//   失败、被闸推迟、参数里认不出票号的调用——不记。
//   只认 status 为 ok 的回执：partial 的回执在信封里 ok 也是 false（部分写成功不等于成功），
//   失败的票不能冒充在办，所以 partial 一律不记。#1561 起写回执里不再带在办表。
//
// 记哪几张票：规格写「按工具返回的 touched 票号」，一次调用里每个票号各一笔。
//   report 的 touched 恒为空（它写的是评论与进度，不碰票面），票号在 data.key；
//   plan 只记这一次真建出来的子票（items 里 role=child 且 status=ok 且没标 skipped）——
//     地图票是容器、不在「子票」之列；续跑时上一次已建、这一次跳过的子票也不再重记，
//     否则同一张票每续跑一次就被刷新一次动作时间，在办表会说谎；
//   同一张票重复出现只记一次（link 可能对同一张票办多件事）。
//
// 带 release=true 的上报走释放那一支（#1086；#1349 收紧）：只撤销从没实际处理过的误报，删掉本会话
// 对这张票的那一条工作条目，不记动作，票本身的状态与认领人不碰（工具只把票读回来证明它存在）。
// 建过、改过、关过、建过计划或挂过边的票不许释放，备注说明路径保留。释放处理完只留备注，
// 不再读在办表放进回执（#1561 起要看在办表就调 deck_work_route）。
//
// 输入输出的形状（与 DeckShellDeps 里 workRouteNote / workRouteRelease 那两处注释同源；读形状见 work-route.ts）：
//   note 输入 { rootKey, sessionId, sessionLabel?, backend?, ticketKey, effortId?, title?, action, source }
//        输出 { ok: true, ticketKey, count, warnings? } | { ok: false, reason }
//        warnings 是「这次落上了、但有件事要告诉人」的备注（#1083：盘上旧文件读不出来按空账重写、
//        工作区换了后端旧记录改名留档），调用方原样拼进回执 notes，不改其他格。
//   release 输入 { rootKey, sessionId, ticketKey }
//        输出 { ok: true, ticketKey, removed, count, blocked? } | { ok: false, reason }
//        其中 removed=false 表示没删：本来就不在本会话的工作路线里，或这张票干过实事
//        （blocked='has-work'，按 #1349 只许撤销误报），都不算失败。
// 其中 rootKey 是 workspace.key（工作区键），落到哪一份文件由存储按 chainRootHash 换算。
// #1561 起写回执里不再带在办表，notes 里也不再带摘要与撞车提醒，只留记不上、释放失败这类实话。
// #1352 起上报不再带 progress：工作条目不再新增这一格，旧存档里已经记下的原样保留（不回溯删除）。
//
// 标题与工作单元是锦上添花：能从这次回执里认出来就写进去，认不出就省略键——
// 存储约定传 undefined 保留上一次的值，传空串会覆盖（见 work-path-store.ts 的 note）。
//
// 票号怎么收成同一个键、怎么认 Linear 的文本票号（`OMB-923`）、哪些写工具从回执哪一处取票号与票面，都在
// work-path-receipt-read.ts（#80 拆出，原因写在那份文件头）：数字票号 "#01"、"01"、"1" 都记成 "1"，文本票号原样记下。
// 回执里有票号、但一个也认不出来时，本文件在回执备注里说实话（#80），不再悄悄返回。
// 本文件现在没有运行时的跨层导入，只用类型与那份同层文件。

import type { DeckShellDeps, ShellSession, UnknownRecord } from './call-shell-types.js';
import { WRITE_TOOLS, obj, str } from './work-path-receipt-read.js';

/**
 * 写工具成功收口处调一次：逐张票记一笔（上报带 release=true 时改走释放一支），不再读在办表、不写回执。
 * 不是写工具、回执不是成功（partial 也不算）、一个票号都认不出、依赖缺席，都直接返回，不碰回执；
 * 记或释放失败时，在 notes 末尾留一句实话，不抛错、不改回执其他格。
 * 要看在办表就调 deck_work_route（#1561 起写回执里不再带 data.workRoute、notes 里不再带摘要与撞车提醒）。
 */
export async function recordWorkRoute(
  deps: Pick<DeckShellDeps, 'workRouteNote' | 'workRouteRead' | 'workRouteRelease'> & { now?: () => number },
  tool: string,
  s: ShellSession,
  backendId: string,
  value: unknown,
): Promise<void> {
  const spec = WRITE_TOOLS[tool];
  if (!spec) return;
  const note = deps ? deps.workRouteNote : undefined;
  const releaseFn = deps ? deps.workRouteRelease : undefined;
  const vRec = obj(value);
  if (!vRec) return;
  // 工具交出来的 value 用 status 不用 ok（ok 是壳合并信封时才有的格）。
  // 只认 ok：规格 #1259 决定 8 把 data.workRoute 限定在 ok 回执的 data 内，决定 6 说失败不记
  // 不注入；partial 的信封 ok 是 false（只写成了一部分），按失败办，宁可这次少记也不把没写成
  // 的票冒充在办。
  if (str(vRec.status) !== 'ok') return;
  const scan = spec.ticketKeys(vRec);
  const tickets = scan.keys;
  // 回执里一个票号都没给（例如建图续跑时没有新建的子票）是正常的，不吭声；给了却一个都认不出才要说实话。
  if (tickets.length === 0 && scan.unrecognized === 0) return;
  // 释放是工具 value 顶层的内部信号（信封只拷固定那几格，不会漏进回执）：只有上报会带它。
  const releaseMode = spec.action === 'report' && vRec.release === true;
  if (!Array.isArray(vRec.notes)) vRec.notes = [];
  const notes = vRec.notes as unknown[];
  if (releaseMode) {
    // 释放这一支接不上时也要说清楚：静默什么都不做会让人以为票已经释放了。
    if (typeof releaseFn !== 'function') {
      if (tickets.length > 0) notes.push('The work route did not release this time (no-release-binding): this assembly has no release branch wired up, so the work entry of the ticket is still there.');
      return;
    }
  } else if (typeof note !== 'function') return;
  // 认不出票号：什么都没记（也没有可释放的），回执里说清楚，免得人以为已经记上了（#80）。
  if (tickets.length === 0) {
    notes.push('The work route did not ' + (releaseMode ? 'release' : 'record') + ' this time (unrecognized-ticket-key): the receipt carried ' + scan.unrecognized + ' ticket key(s) in a shape the work board does not recognize, so nothing was ' + (releaseMode ? 'released' : 'recorded') + '. It recognizes a number such as 42 and a tracker key such as OMB-923. To see the work board, call deck_work_route.');
    return;
  }
  // 上面按模式各放行一支，这里把可调用形状收窄一次：TS 不会把上一个 if 里的收窄带进下面的新分支。
  const callRelease = releaseFn as NonNullable<typeof releaseFn>;
  const callNote = note as NonNullable<typeof note>;
  // 两句失败备注分开写，是为了不说假话：记这一步失败时盘上可能是旧内容，但换后端那一刻旧文件已经被
  // 改名留档、主文件这次可能根本不在；读回核对失败时盘上其实已经是这次写的新内容。原来一句
  // 「盘上还是上一次的样子」在两种情形下都不成立。逐张票写时还多一种「记了几张、剩下的没记上」，
  // 这种只说「没记全」，不谎称整次没落上。#1263 之后若要再细分，按 reason 接着加。
  const noteFailNote = function (reason: string): void {
    const tail = reason === 'readback-failed'
      ? 'The write went through, but the read-back check did not pass, and the next ticket write will read the disk again and fill in what is missing.'
      : 'Nothing was written; the disk may still hold the old content (when the backend changed, the old file was archived on its own), and the next ticket write will read the disk again and fill in what is missing.';
    notes.push('The work route did not record this time (' + reason + '): ' + tail + ' To see the work board, call deck_work_route.');
  };
  const partialNote = function (reason: string): void {
    notes.push('The work route recorded only part of this time (' + reason + '): what was already recorded is not lost, and the next ticket write will fill in what is missing.');
  };
  // 释放失败要人知道票的工作条目还留着。
  // 读回核对失败是释放里的特例：写盘那一步已经成了，删除大概率已经落盘，这时说「条目还留着」是假话
  // （与 noteFailNote 里分两句同一个理由）。
  const releaseFailNote = function (reason: string): void {
    if (reason === 'readback-failed') {
      notes.push('The release of the work route was not confirmed (readback-failed): the deletion was already written to disk, but the read-back check after the write did not pass; the next release or report will read the disk again to confirm.');
      return;
    }
    notes.push('The work route did not release this time (' + reason + '): the work entry of this ticket in this session is still there, and the next release or report will handle it as usual.');
  };
  const rootKey = str(s && s.workspaceKey);
  const sessionId = str(s && s.sessionId);
  let recorded = 0;
  try {
    if (releaseMode) {
      // 释放只针对上报那一张票（data.key 归一后的 tickets[0]）。工具已经把票读回来证明它存在，
      // 这里只删本会话对它的那一条工作条目，票本身的状态与认领人不碰。
      const released = (await callRelease({
        rootKey: rootKey,
        sessionId: sessionId,
        ticketKey: tickets[0],
      })) as UnknownRecord | null;
      if (!released || released.ok !== true) {
        releaseFailNote(str(released && released.reason) || 'unknown');
        return;
      }
      if (released.removed === true) {
        const left = typeof released.count === 'number' ? released.count : 0;
        notes.push('Ticket ' + tickets[0] + ' was released from the work route of this session (' + left + ' entries are still in progress in this session; the state and assignee of the ticket itself were not changed).');
      } else if (released.blocked === 'has-work') {
        notes.push('Ticket ' + tickets[0] + ' was actually worked on in this session (one of: created, edited, closed, a plan was made, an edge was attached), so the rules do not allow releasing it from the work route; this path is kept. release only takes back a report of a ticket that was never worked on.');
      } else {
        notes.push('Ticket ' + tickets[0] + ' was not in the work route of this session in the first place, so there was no entry to release this time.');
      }
    } else {
      for (let i = 0; i < tickets.length; i++) {
        const ticketKey = tickets[i];
        const facts = spec.ticketFactsOf(vRec, ticketKey);
        const input: UnknownRecord = {
          rootKey: rootKey,
          sessionId: sessionId,
          sessionLabel: '',           // 会话标题快照由宿主侧在 workRouteNote 里按 titleFactOf 同一条取法填（取不到留空），这里传空串表示没带。
          backend: backendId,
          ticketKey: ticketKey,
          action: spec.action,
          source: spec.source,
        };
        // 认不出的标题与工作单元省略键，让存储保留上一次的值（传空串会把它抹掉）。
        if (facts.title !== '') input.title = facts.title;
        if (facts.effortId !== '') input.effortId = facts.effortId;
        const noted = (await callNote(input)) as UnknownRecord | null;
        if (!noted || noted.ok !== true) {
          if (recorded > 0) partialNote(str(noted && noted.reason) || 'unknown');
          else noteFailNote(str(noted && noted.reason) || 'unknown');
          return;
        }
        // 落上了但有件事得让人知道：把存储带回来的每一句如实拼进回执备注。一次调用可能记多张票，
        // 同一句警告（例如「盘上旧文件读不出来，按空账重写」）只说一遍，不重复刷屏。
        const warned = Array.isArray(noted.warnings) ? (noted.warnings as unknown[]) : [];
        for (let w = 0; w < warned.length; w++) {
          const text = str(warned[w]);
          if (text !== '' && notes.indexOf(text) < 0) notes.push(text);
        }
        recorded += 1;
      }
    }
  } catch {
    if (releaseMode) {
      releaseFailNote('threw');
    } else if (recorded > 0) {
      partialNote('threw');
    } else {
      noteFailNote('threw');
    }
  }
}
