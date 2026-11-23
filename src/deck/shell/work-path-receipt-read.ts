// work-path-receipt-read.ts —— 工具壳「记一笔」那一步从写工具回执里读票号与票面的那一半（#1261 起在 work-path-record.ts，#80 拆出）。
//
// 为什么单列一份：记一笔那一步加上「认文本票号」与「认不出就在回执里说实话」之后，work-path-record.ts 越过了单文件 20 KB 的上限；
// 读回执这一半没有任何运行时副作用、只做形状识别，拆出来最干净。记与释放的流程、备注文案仍在 work-path-record.ts。
//
// 票号先收成同一个键再记（workRouteKey）：后端回执的写法并不统一，markdown 建票回 "01"、上报却回 "1"；
// 不先收成同一个键，同一张票会在在办表里出现两条。数字票号走链的同一套归一（chainTicketKey：去 #、去前导零），
// "#01"、"01"、"1" 都记成 "1"。Linear 房间给的是文本票号（`OMB-923`），原样记下（#80：以前只认数字，
// Linear 工作区的每一次写都被静默丢掉，在办表永远是空的）。文本票号的形状与 deck_issue_report 的 normKey 同口径（队名-数字）；
// chainTicketKey 本身不动，它还管着胶囊那条链和票文件路径里的编号，那边只认数字是对的。
//
// deck_issue_report 的 normKey 也从这里取 TEXT_TICKET_KEY：文本票号的形状只在这一处定义，两边不会各改各的。
//
// 这是本文件唯一一处运行时值导入：refresh-chain.ts 是共享纯逻辑（不碰 DOM、不碰 Node 内置模块），
// 与依赖规则门禁里登记的跨层方向一致，不新增豁免。

import { chainTicketKey } from '../../refresh/kernel/refresh-chain.js';
import type { UnknownRecord } from './call-shell-types.js';

/** 一张票这次要写进工作路线的标题与工作单元；认不出就给空串，调用方据此省略键。 */
export interface TicketFacts {
  title: string;
  effortId: string;
}

/** 一次调用从回执里读到的票号：认得出的（已归一、已去重），和认不出的有几个（只数回执里真给了值的）。 */
export interface KeyScan {
  keys: string[];
  unrecognized: number;
}

/** 一个写工具的登记表：动作、来源、这次写到的票号、票面信息从回执哪一处取。 */
export interface WriteToolRule {
  action: string;
  source: string;
  /** 这次调用写到的票号：认得出的归一去重，认不出的只计数。 */
  ticketKeys: (vRec: UnknownRecord) => KeyScan;
  /** 这张票的标题与工作单元；认不出返回空串，note 时省略键。 */
  ticketFactsOf: (vRec: UnknownRecord, key: string) => TicketFacts;
}

/** 存储里标题最多留 80 字，与读出口的展示口径一致。 */
function clip(t: string): string {
  return t.slice(0, 80);
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function obj(v: unknown): UnknownRecord | null {
  return (v && typeof v === 'object') ? (v as UnknownRecord) : null;
}

/** Linear 这类房间的文本票号：队名（字母开头）、横线、数字，与 deck_issue_report 的 normKey 同形。 */
export const TEXT_TICKET_KEY = /^[A-Za-z][A-Za-z0-9_]{0,15}-\d{1,10}$/;

/**
 * 工作路线认的票号：数字票号走链的归一（去 #、去前导零），文本票号（`OMB-923`）去掉开头的 # 后原样记下；
 * 别的形状一律当认不出，返回空串。大小写不改：房间回给什么就记什么，改了反而会和房间对不上。
 */
function workRouteKey(raw: unknown): string {
  const numeric = chainTicketKey(raw);
  if (numeric !== '') return numeric;
  if (typeof raw !== 'string') return '';
  const text = raw.trim().replace(/^#/, '');
  return TEXT_TICKET_KEY.test(text) ? text : '';
}

/** 回执里「真给了值」才算一个票号：空串、没给、null 不数，免得没写票的调用被当成认不出。 */
function isGiven(raw: unknown): boolean {
  if (typeof raw === 'number') return isFinite(raw);
  return typeof raw === 'string' && raw.trim() !== '';
}

/** 往 scan 里放一个票号：认得出就去重收下，给了值却认不出就计一个。 */
function addKey(scan: KeyScan, raw: unknown): void {
  if (!isGiven(raw)) return;
  const key = workRouteKey(raw);
  if (key === '') scan.unrecognized += 1;
  else if (scan.keys.indexOf(key) < 0) scan.keys.push(key);
}

/** 大多数写工具都从 touched 取票号：本次写到的每一张票，按回执给的顺序。 */
function keysOfTouched(vRec: UnknownRecord): KeyScan {
  const scan: KeyScan = { keys: [], unrecognized: 0 };
  const list = Array.isArray(vRec.touched) ? vRec.touched : [];
  for (let i = 0; i < list.length; i++) addKey(scan, list[i]);
  return scan;
}

/** 上报不碰票面，touched 恒空；它报的那张票在 data.key。 */
function keysOfReport(vRec: UnknownRecord): KeyScan {
  const scan: KeyScan = { keys: [], unrecognized: 0 };
  const data = obj(vRec.data);
  if (data) addKey(scan, data.key);
  return scan;
}

/**
 * 建图只记这一次真建出来的子票：items 里 role=child、status=ok、且没标 skipped。
 * 不记地图票（规格只写「它建出的每张子票各一条」），也不记上次已建、这次跳过的子票
 * （记了会刷新它们的动作时间，续跑一次就在办表里再「动」一次）。
 */
function keysOfPlanChildren(vRec: UnknownRecord): KeyScan {
  const items = Array.isArray(vRec.items) ? vRec.items : [];
  const scan: KeyScan = { keys: [], unrecognized: 0 };
  for (let i = 0; i < items.length; i++) {
    const row = obj(items[i]);
    if (!row || row.role !== 'child' || row.status !== 'ok' || row.skipped === true) continue;
    addKey(scan, row.key);
  }
  return scan;
}

/** 建票与改票的回执里都有 data.ticket：key 对得上才算这张票的份，对不上就当作没这份信息。 */
function ticketFactsOfTicket(vRec: UnknownRecord, key: string): TicketFacts {
  const data = obj(vRec.data);
  const ticket = data ? obj(data.ticket) : null;
  if (!ticket || workRouteKey(ticket.key) !== key) return { title: '', effortId: '' };
  return { title: clip(str(ticket.title)), effortId: str(ticket.effortId) };
}

/** 上报的票面信息就在 data 上（title 与 effortId 直接给，票号已在 data.key 上认过）。 */
function ticketFactsOfReport(vRec: UnknownRecord): TicketFacts {
  const data = obj(vRec.data) || {};
  return { title: clip(str(data.title)), effortId: str(data.effortId) };
}

/** 建图的回执把每张票放在 items 里，按票号找子票那一行取标题。 */
function ticketFactsOfPlanChild(vRec: UnknownRecord, key: string): TicketFacts {
  const items = Array.isArray(vRec.items) ? vRec.items : [];
  for (let i = 0; i < items.length; i++) {
    const row = obj(items[i]);
    if (!row || row.role !== 'child' || workRouteKey(row.key) !== key) continue;
    return { title: clip(str(row.title)), effortId: '' };
  }
  return { title: '', effortId: '' };
}

/** 连边的回执里没有标题与工作单元，留空（存储会保留上一次的值，不会抹掉）。 */
function emptyTicketFacts(): TicketFacts {
  return { title: '', effortId: '' };
}

/** 五个写工具的动作类别与来源。读工具不在这张表里，所以它们走不到记一笔那一步。 */
export const WRITE_TOOLS: Record<string, WriteToolRule> = {
  deck_issue_report: { action: 'report', source: 'reported', ticketKeys: keysOfReport, ticketFactsOf: ticketFactsOfReport },
  deck_issue_create: { action: 'create', source: 'auto', ticketKeys: keysOfTouched, ticketFactsOf: ticketFactsOfTicket },
  deck_issue_patch: { action: 'edit', source: 'auto', ticketKeys: keysOfTouched, ticketFactsOf: ticketFactsOfTicket },
  deck_map_plan_create: { action: 'plan', source: 'auto', ticketKeys: keysOfPlanChildren, ticketFactsOf: ticketFactsOfPlanChild },
  deck_map_link: { action: 'link', source: 'auto', ticketKeys: keysOfTouched, ticketFactsOf: emptyTicketFacts },
};
