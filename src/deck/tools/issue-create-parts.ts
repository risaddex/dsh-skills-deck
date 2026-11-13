// src/deck/tools/issue-create-parts.ts —— deck_issue_create 的工具定义（参数表与给 AI 看的那段话）
//
// 为什么单独拆：这份参数表是纯数据，三十多行只描述「这个工具收哪些参数、每个参数是什么意思」，
// 与执行逻辑没有关系；留在 issue-create.ts 里会把那份文件顶过 tests/verify-file-granularity.ts
// 的 350 行有效行上限。拆出来只搬位置、不改一个字符：参数名、枚举值、描述文案、required 与
// additionalProperties 全部原样，所以模型看到的工具面与拆之前完全一致。
//
// 不能改的约定：
//   1. 这里是这张票参数的唯一一份答复，别的文件不许再抄一份 —— 抄两份必然漂移，
//      模型会按旧的那一份填参数，而门禁只看功能不看文案。
//   2. 描述文案是提示词成本：改字等于改模型看到的东西，不属于「拆文件」的范围。
//   3. 工具名 deck_issue_create 由这里出，改名要同时改装配层、门禁与文档，不在本文件自留地里做。
import { MD_SCOPE_CREATE } from './md-scope.js'
import { DECK_STATUS } from '../shell/call-shell.js'
import { reasonForItems } from '../shell/receipt-reason.js'
import * as budget from '../../refresh/kernel/host-budget.js'

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_issue_create',
  description: 'Part of the ISSUE and map management surface of the dsh-skills-deck plugin; it handles only the repo of the current workspace. Before touching an ISSUE, call deck_context to confirm the workspace and the backend, and stop if it reports no backend. Create one ticket: kind is required, with the six values map / map-ticket / spec / spec-ticket / bug / issue; map and spec are top-level containers, a map ticket hangs under an exploration map and a spec ticket hangs under a spec, both through parentKey, and a map ticket also needs label. Labels and progress are filled in for you; specs and spec tickets get a type marker; originalWords is copied verbatim; blockedBy becomes dependency edges. The number and header markers of a local backend ticket are written by the tool, so do not write ticket files by hand.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The title of the ticket' },
      body: { type: 'string', description: 'The body; when omitted, a minimal skeleton is added for the kind' },
      originalWords: {
        type: 'object',
        description: 'While creating the ticket, append what the user themselves said, verbatim, to the body section "## 维护者原话" (right after "## 目的", or at the very top of the body when there is no 目的 section): {text, source}, with source required. When to write it: every sentence the user typed by hand is worth recording (they do not type much), so do not decide for them which sentences matter; the original words on a ticket are the highest requirement for that ticket, and later conflicts are settled by the original words. The words are kept byte for byte (no polishing, no punctuation changes, no translation, no summarizing): append only, never edit, delete or reorder. All three backends write them into the ticket body, not into a comment; when the body would pass 60KB the ticket is refused and not one byte is written.',
        properties: {
          text: { type: 'string', description: 'The original words of the maintainer, byte for byte; they may span several lines, and blank lines are kept as they are' },
          source: { type: 'string', description: 'Where it came from, required: a ticket writes the full link, an answer in this session writes "this session (time)", a file writes "path:line number", and a commit writes the short hash' },
        },
        required: ['text', 'source'],
        additionalProperties: false,
      },
      kind: { type: 'string', enum: ['map', 'map-ticket', 'spec', 'spec-ticket', 'bug', 'issue'], description: 'The position of the ticket, required: map (exploration map) / map-ticket (a ticket under a map) / spec (spec) / spec-ticket (a spec ticket under a spec) / bug (defect) / issue (plain ticket, the catch-all). The old task / ticket are no longer accepted: use map-ticket with a label instead of task, and spec-ticket instead of ticket.' },
      label: { type: 'string', enum: ['wayfinder:research', 'wayfinder:prototype', 'wayfinder:grilling', 'wayfinder:task'], description: 'Accepted only with kind=map-ticket, and required there: wayfinder:research / wayfinder:prototype / wayfinder:grilling / wayfinder:task, one of the four. The type label comes from it, so do not put it in labels as well.' },
      parentKey: { type: 'string', description: 'The parent ticket: required for map-ticket, where the parent must be an exploration map; required for spec-ticket, where the parent must be a spec; map and spec are top-level containers and do not take parentKey; optional for bug and issue, and when it is given it must be an exploration map or a spec.' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'Which tickets block this one once it exists (an array of ticket numbers or keys, replaced as a whole; only tickets of this repo are accepted, so do not write ticket numbers from another repo)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Extra labels to carry, added on top of the required ones; except for issue, do not put a type label in here as well (wayfinder:map / wayfinder:research / wayfinder:prototype / wayfinder:grilling / wayfinder:task / bug), because the type label is decided by kind and label.' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'The assignees' },
      idempotencyKey: { type: 'string', description: 'The idempotency anchor of this batch of writes; pass the same value on a retry' },
      ...MD_SCOPE_CREATE,
    },
    required: ['title', 'kind'],
    additionalProperties: false,
  },
}

/** 回执里那句「落在哪儿」（#1486）：本地后端的 url 就是票文件路径，远端是 http(s) 链接。
 *
 *  为什么要单说这一句：新布局把规格放进 `<feature>/spec.md`、把票放进 `<feature>/issues/NN-slug.md`，
 *  编号按目录各自从 01 起。AI 只看「票 01 建好了」会以为全仓库只有这一张 01；说清目录与编号，
 *  下一步查票、补边、报告才不会找错文件。远端后端的 url 是链接，没有本地路径可说，返回空串。 */
export function landingNote(issue: Record<string, unknown> | null | undefined): string {
  const url = String((issue && issue.url) || '')
  if (!url || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return ''
  const file = url.split(/[\\/]/).pop() || ''
  const effort = String((issue && issue.effortId) || '')
  const isSpec = String((issue && issue.type) || '') === 'spec' || file === 'spec.md'
  if (isSpec) {
    return 'Landed at ' + (effort ? '.scratch/' + effort + '/spec.md' : file) + ' (container number 00). '
  }
  return 'Landed at ' + (effort ? '.scratch/' + effort + '/issues/' : '') + file + ' (number ' + String((issue && issue.key) || '') + '). '
}

/** 部分成功（票建成、某一步没做成）的回执形状：四处分支的 status / reason / data / items / notes /
 *  touched 与拆之前逐字相同，集中在这里只为把 issue-create.ts 压回 350 有效行以内。 */
export function partialCreateResult(issue: Record<string, unknown>,kind: string,anchor: string,items: Array<Record<string, unknown>>,notes: string[],text: string,claimed: { requests: number; points: number }): unknown {
  return {
    value: { status: DECK_STATUS.PARTIAL, reason: reasonForItems(items), text: text, data: { ticket: issue, kind: kind, idempotencyKey: anchor, limits: { maxChildTicketsPerCall: budget.AI_TOOL_MAX_CHILD_TICKETS_PER_CALL } }, items: items, notes: notes, touched: issue.key ? [String(issue.key)] : [] },
    claimed: claimed,
  }
}
