// tests/verify-1385-howto.ts —— #1385：deck_context 的用法说明按后端分支，本地后端追加建票契约
// 门禁归属: src/deck/tools/context.ts, src/deck/tools/issue-create.ts, src/deck/tools/issue-patch.ts, src/deck/tools/issue-patch-definition.ts
// 验证（每条都能被删掉/改坏而变红）：
//   1) 本地后端（markdown）的 howto 含建票契约关键词：文件格式与位置以随包技能原文为唯一依据
//      （规格 spec.md、探索地图 map.md、票在 issues/<NN>-<slug>.md），六种 kind 与 parentKey / blockedBy、
//      补边用 deck_map_link、不要手写票文件、插件信息写进隐藏注释；旧写法「规格就是票」与 kind=ticket / kind=task 必须消失；
//   2) 其它后端（github/gitlab）的 howto 与改前逐字一致，一个字不多一个字不少；
//   3) deck_issue_create / deck_issue_patch 的描述在 350 字内，且含本地后端最必要的一两句。
// 用法: node --import ./scripts/ts-hook.mts tests/verify-1385-howto.ts
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok, msg) => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

// 三后端共用的那段用法说明（逐字冻住）：非本地后端必须与它一字不差（改一个字就红）。
const BASE_HOWTO = 'Confirm the workspace and the backend with this tool before you write a ticket. Create tickets with deck_issue_create, a whole map skeleton with deck_map_plan_create, extra edges with deck_map_link, changes to a ticket with deck_issue_patch, the ticket you are working on with deck_issue_report, one ticket with deck_issue_get, every sub-issue of a map with deck_map_snapshot, and thin rows by state, label and assignee with deck_issue_list. To spend fewer points: scan with deck_issue_list thin rows first; for the reverse edges of one ticket, when you are not in a hurry, call deck_issue_get with blocking=false (it skips one whole-repo scan); when the list of sub-issues must be full and unbroken, call deck_map_snapshot with detail=thin (the counts stay the same). The workspace and the repo take no arguments: they come from the current session only. Everything the user types themselves is worth recording in the original words section of that ticket: when creating or changing a ticket, pass {text,source} in originalWords, unchanged and append-only; the original words on a ticket are the highest requirement for that ticket, and where the rest of the ticket conflicts with them the original words win, so if you cannot tell, tell the user there is a clear conflict. To see which sessions are working on which tickets, and whether anyone is competing with you for the same ticket, call deck_work_route; running:true on a group means that session really has a turn open at this moment (waiting for approval or for an answer counts too).'

async function main() {
  console.log('#1385：howto 按后端分支 + 描述字数与短句')
  const ctxMod = await imp('src/deck/tools/context.ts')
  const createMod = await imp('src/deck/tools/issue-create.ts')
  const patchMod = await imp('src/deck/tools/issue-patch.ts')

  // 纯函数：按后端 id 求值（非本地分支与改前逐字一致靠它保证）。
  const fn = ctxMod.howtoFor || ctxMod.buildHowto || ctxMod.howtoTextFor
  check(typeof fn === 'function', 'context.ts 按后端 id 求值的 howto 纯函数已导出（实得 ' + typeof fn + '）')
  if (typeof fn !== 'function') {
    console.log('\n存在失败')
    process.exit(1)
  }

  // —— 本地后端：含契约关键词 ——
  const local = fn('markdown')
  check(typeof local === 'string' && local.indexOf(BASE_HOWTO) === 0, '本地后端 howto 以共用那段说明开头（老话一句不少）')
  check(local.indexOf('issue-tracker-local.md') >= 0, '本地后端 howto 点名随包技能原文，声明它是唯一依据（#1480）')
  check(local.indexOf('a spec is .scratch/<feature-slug>/spec.md') >= 0, '本地后端 howto 说清规格落在 spec.md（#1480）')
  check(local.indexOf('.scratch/<effort>/map.md') >= 0, '本地后端 howto 说清探索地图落在 map.md（#1480）')
  check(local.indexOf('issues/<NN>-<slug>.md') >= 0, '本地后端 howto 说清票落在 issues/<NN>-<slug>.md（#1480）')
  check(local.indexOf('kind=spec-ticket') >= 0, '本地后端 howto 说清实施票 kind=spec-ticket')
  check(local.indexOf('kind=map-ticket') >= 0, '本地后端 howto 说清地图子票 kind=map-ticket')
  check(local.indexOf('kind=issue') >= 0, '本地后端 howto 说清普通票 kind=issue 的兜底')
  check(local.indexOf('kind=bug') >= 0, '本地后端 howto 说清缺陷票 kind=bug')
  check(local.indexOf('kind=spec creates a spec') >= 0, '本地后端 howto 说清规格票 kind=spec')
  check(local.indexOf('kind=ticket') < 0 && local.indexOf('kind=task') < 0, '本地后端 howto 里旧的 kind=ticket / kind=task 已经消失')
  check(local.indexOf('规格就是票') < 0 && local.indexOf('top-level container') < 0 && local.indexOf('spec is a ticket') < 0, '本地后端 howto 不再把规格说成一张票或顶层容器（#1490）')
  check(local.indexOf('wayfinder:task') >= 0, '本地后端 howto 列出地图子票可选的 label')
  check(local.indexOf('parentKey') >= 0, '本地后端 howto 说清 parentKey 填谁')
  check(local.indexOf('blockedBy') >= 0, '本地后端 howto 说清依赖填 blockedBy')
  check(local.indexOf('do not write ticket files by hand') >= 0, '本地后端 howto 说清不要手写票文件')
  check(local.indexOf('hidden header comments') >= 0, '本地后端 howto 说清插件信息写进文件头隐藏注释（#1480）')
  check(local.indexOf('.scratch') >= 0, '本地后端 howto 点名 .scratch 下的票文件不要手写')
  check(local.indexOf('deck_map_link') >= 0, '本地后端 howto 说清补边用 deck_map_link')
  check(local.indexOf('the skill text wins') >= 0, '本地后端 howto 声明与技能原文冲突时以原文为准（#1480）')
  check(local.indexOf('Reporting is bookkeeping') >= 0 && local.indexOf('deck_work_route') >= 0, '本地后端 howto 说清上报只记账不带表、在办表走 deck_work_route（#1561）')
  // #1793（B4）：两条跨工具规矩进了共用说明——原话区（每句话都值得记、原话是最高要求）与在办表（何时调、running 含义）。
  check(BASE_HOWTO.indexOf('originalWords') >= 0 && BASE_HOWTO.indexOf('the original words on a ticket are the highest requirement') >= 0 && BASE_HOWTO.indexOf('if you cannot tell, tell the user there is a clear conflict') >= 0,
    '共用说明含原话区规矩：每句话都值得记、原话是最高要求、冲突判不清就告诉用户')
  check(BASE_HOWTO.indexOf('deck_work_route') >= 0 && BASE_HOWTO.indexOf('running:true') >= 0,
    '共用说明含在办表规矩：什么时候调、running:true 什么意思')

  // —— 其它后端：逐字不变 ——
  for (const id of ['github', 'gitlab']) {
    const other = fn(id)
    check(other === BASE_HOWTO, id + ' 后端 howto 与改前逐字一致（实得 ' + String(other).length + ' 字，期望 ' + String(BASE_HOWTO).length + ' 字）')
  }

  // —— 描述：1000 个字符内 + 本地短句 ——
  //   2026-11-13：src/deck 的说明从中文翻成英文，上限跟着与 tests/verify-deck-tools.ts 一样改成 1000 个字符。
  //   这道检查管的是「说明别无限长、提示词成本别悄悄涨」，同样的信息用英文写就是比中文长（实测 811 / 808），
  //   内容一个字都没加；新增内容仍然会因为撞到上限被拦住。
  const createDesc = String((createMod.definition && createMod.definition.description) || '')
  const patchDesc = String((patchMod.definition && patchMod.definition.description) || '')
  check(createDesc.length <= 1000, 'deck_issue_create 描述在 1000 个字符内（实得 ' + createDesc.length + ' 个字符）')
  check(patchDesc.length <= 1000, 'deck_issue_patch 描述在 1000 个字符内（实得 ' + patchDesc.length + ' 个字符）')
  check(createDesc.indexOf('The number and header markers of a local backend ticket are written by the tool') >= 0, 'deck_issue_create 描述含本地后端最必要的一句：编号与文件头标记由工具写')
  check(createDesc.indexOf('do not write ticket files by hand') >= 0, 'deck_issue_create 描述提醒不要手写票文件')
  check(patchDesc.indexOf('Assignees') >= 0, 'deck_issue_patch 描述含最必要的一句：认领写 Assignees 行')

  console.log('\n' + (failed ? '存在失败' : '全部通过 — #1385 howto 两分支 + 描述字数（' + total + ' 条）'))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('门禁执行异常：' + ((e && e.stack) || e)); process.exit(1) })
