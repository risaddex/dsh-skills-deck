// src/deck/tools/issue-patch-definition.ts —— deck_issue_patch 的工具定义（#1495 加关闭原因后从 issue-patch.ts 搬出）
//
// 为什么单独一份：issues-patch.ts 的有效行一直贴着每文件 350 行的上限（tests/verify-file-granularity.ts）。
// #1495 给 deck_issue_patch 加「关闭原因」参数之后，那份文件到了 359 有效行、门禁判红；搬走的第一块
// 就挑最纯的这份工具定义——它只是一段数据（名字、给 AI 看的说明、参数表），与运行逻辑没有耦合，
// 搬走不改任何行为。文件头注释里原先那句「工具定义（唯一事实）」仍然成立，只是真源换了位置。
import { MD_SCOPE_LOCATE } from './md-scope.js'

/** 工具定义（唯一事实）：路由、参数名与给 AI 看的那句话都从这里出，别在别处再抄一份。 */
export const definition = {
  name: 'deck_issue_patch',
  description: 'Part of the ISSUE and map management surface of the dsh-skills-deck plugin; it handles only the repo of the current workspace. Before touching an ISSUE, call deck_context to confirm the workspace and the backend, and stop if it reports no backend. Change one ISSUE: comments, labels, assignees, closing, title and body, the progress section, and the maintainer original-words section; in one call only what you name. Reopening is not on this tool (only a person does it in the backend), and closing a spec needs the wrap-up check comment in this same call with every spec ticket already closed. A local backend claim is written into the Assignees line of the ticket. When a local Markdown ticket has a status conflict the whole call is refused and data.retry comes back: retry with it, or pass resolveStatus.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The ticket to change' },
      comment: { type: 'string', description: 'The comment body to post' },
      addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
      removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'The assignees (replaced as a whole; an empty array takes the claim off)' },
      title: { type: 'string', description: 'The new title' },
      body: { type: 'string', description: 'The new body (the whole body is replaced): first read the full text and its digest with deck_issue_get(body=\'full\'), then pass the digest you read in bodyDigest, otherwise the body is left untouched this time. When you only change progress or original words and do not replace the whole body, this is not needed.' },
      bodyDigest: { type: 'string', description: 'Optimistic lock for writing the whole body: the body digest you read last time with body=\'full\' (data.body.digest). The tool reads the current body and computes its digest first; when they do not match it refuses without changing a byte, so a change someone else made is not overwritten.' },
      originalWords: {
        type: 'object',
        description: 'Append what the user themselves said, verbatim, to the body section "## 维护者原话" (right after "## 目的", or at the very top of the body when there is no 目的 section): {text, source}, with source required. When to write it: every sentence the user typed by hand is worth recording (they do not type much), so do not decide for them which sentences matter; the original words on a ticket are the highest requirement for that ticket, and later conflicts are settled by the original words. The words are kept byte for byte (no polishing, no punctuation changes, no translation, no summarizing): append only, never edit, delete or reorder; when the same words with the same source are already there, the write is skipped as idempotent. All three backends write them into the ticket body, not into a comment. When the body would pass 60KB the write is refused and not one byte is written.',
        properties: {
          text: { type: 'string', description: 'The original words of the maintainer, byte for byte; they may span several lines, and blank lines are kept as they are' },
          source: { type: 'string', description: 'Where it came from, required: a ticket writes the full link, an answer in this session writes "this session (time)", a file writes "path:line number", and a commit writes the short hash' },
        },
        required: ['text', 'source'],
        additionalProperties: false,
      },
      progress: {
        type: 'object',
        description: 'Write one progress entry: {percent, note} (since #1090 a free-form paragraph is no longer accepted). The tool stamps the current time and puts this entry at the top of the "## 进度" section, keeping the older entries exactly as they were; when the body would pass 60KB the write is refused and not one byte is written.',
        properties: {
          percent: { type: 'integer', description: 'The progress percentage, an integer from 0 to 100' },
          note: { type: 'string', description: 'Where you got to, required, one sentence (no line breaks)' },
        },
        required: ['percent', 'note'],
        additionalProperties: false,
      },
      close: { type: 'boolean', description: 'true closes this ticket; closing a spec needs comment in this same call (checking the conclusion of each item) with every spec ticket already closed, otherwise the close is refused. Reopening can only be done by a person in the backend; this tool does not support false' },
      closeReason: { type: 'string', description: 'Why it is closed: used together with close:true to tell the backend why this close happened. The reason of a map ticket goes into the ## Answer section of the body and also adds a pointer to the Decisions so far of the map; the reason of a spec ticket is appended as a comment in the words given; an old-layout ticket writes a Close reason line; specs and map containers only record the state and the reason is ignored. Passing closeReason without close:true refuses the whole call and not one byte is written.' },
      resolveStatus: { type: 'string', enum: ['visible', 'hidden'], description: 'Only needed when a local Markdown ticket has a status conflict: the visible Status line of the ticket and its hidden triage label each name a status, and the read side answers by the visible line for now. visible means normalize to the visible Status line, hidden means normalize to the hidden triage label; when it is not given, a conflict refuses the whole call (not a byte is written), and data.retry.args from the receipt can be used to retry as it is.' },
      ...MD_SCOPE_LOCATE,
    },
    required: ['key'],
    additionalProperties: false,
  },
}
