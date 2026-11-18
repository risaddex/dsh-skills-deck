// tests/verify-45-comment-text-key.ts: the panel can post a comment on a ticket whose key is text, such as OMB-900 (#45).
//
// Why this gate exists: on a Linear ticket the comment box said "Comment failed, please retry (invalid number)". Two places
// refused a text key before anything was sent. The client (submitIssueComment) turned the key into a number and refused NaN;
// the host (handleCommentIssue) refused every key that was not all digits on purpose, because nobody had tried the write path
// on a real Linear ticket. Both refusals are now gone and the key travels as text.
//
// What the gate runs (the real code, no copy of the rule):
//   - host: createCommentThreads(...).handleCommentIssue with a fake write session that records what `session.comment` receives;
//   - client: the real submitIssueComment from src/client/kernel/api-io.ts with a fake `host` that records `host.call`.
// The numeric behaviour must not change by one character: GitHub 42 stays 42 ('42' on the host), Markdown 01 stays 1 ('1' on the
// host, which is what String(Number('01')) gave before this change). Empty, NaN, negative and object keys are still refused.
//
// Nothing here talks to Linear. The one assumption this gate cannot check is that Linear's commentCreate accepts the
// identifier (OMB-900) as `issueId`; that needs a real, disposable Linear ticket.
// 门禁归属: src/client/kernel/api-io.ts
// 门禁归属: src/refresh/rooms/host/comment-thread-fetch.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-comment-text-key.ts
import { printGateResult } from './lib/gate-result.ts'
import { createCommentThreads } from '../src/refresh/rooms/host/comment-thread-fetch.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  assertions += 1
  if (!ok) failed += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (!ok && detail !== undefined ? '\n       got ' + JSON.stringify(detail) : ''))
}

const CWD = '/Users/danilo/Work/Ombrello/OmbrelloSolar/ombrellosolar-backend'

// ---------------------------------------------------------------------------
// A. host: handleCommentIssue
// ---------------------------------------------------------------------------
interface HostRun { reply: any, comments: any[], opens: number, receipts: any[] }

async function hostComment(args: any): Promise<HostRun> {
  const run: HostRun = { reply: null, comments: [], opens: 0, receipts: [] }
  const session = {
    comment: async (repoRef: any, key: any, body: any) => {
      run.comments.push({ refId: repoRef && repoRef.refId, key, body })
      return { ok: true, data: { body: String(body), author: { login: 'me' }, createdAt: '2026-11-18T00:00:00Z' } }
    },
  }
  const opened = {
    ok: true, backendId: 'linear', budget: {}, canWrite: true,
    repoRef: { backend: 'linear', refId: CWD, name: 'ombrellosolar-backend', url: '' },
    call: async (fn: any) => fn(session, { cwd: CWD, caller: 'panel' }),
  }
  const threads = createCommentThreads({
    openSession: async () => { run.opens += 1; return opened },
    normCwd: async (x: any) => x, selectEarly: async () => { throw new Error('unused') }, isComposerSelection: () => false,
    getTrackerRegistry: async () => ({}), getPlatform: async () => ({}), ctx: {}, timer: {}, DEFAULT_CWD: '', errText: (e: any) => String((e && e.message) || e),
    isRateLimitError: () => false, getRepoKey: async () => null, execProc: async () => { throw new Error('unused') },
    fetchIssueIndex: async () => { throw new Error('unused') }, issueIndexFromSnapshot: () => ({}), setCache: () => {}, logCtx: { fire: () => {} },
    getSnapshotLibrary: async () => ({ recordCommentReceipt: async (input: any) => { run.receipts.push(input); return { ok: true } } }),
  } as any)
  run.reply = await threads.handleCommentIssue(args)
  return run
}

console.log('== A. host ==')
{
  const r = await hostComment({ number: 'OMB-900', body: 'hello', cwd: CWD })
  check(r.reply && r.reply.ok === true, 'host: a comment on the text key OMB-900 is accepted', r.reply)
  check(r.comments.length === 1 && r.comments[0].key === 'OMB-900', 'host: the text key reaches session.comment unchanged as "OMB-900"', r.comments)
  check(r.comments.length === 1 && r.comments[0].body === 'hello' && !!r.comments[0].refId, 'host: the body and the repository identity (non-empty refId) reach session.comment', r.comments)
  check(r.receipts.length === 1 && JSON.stringify(r.receipts[0].keys) === JSON.stringify(['OMB-900']), 'host: the write receipt is stored under the text key only, nothing is invented', r.receipts.map((x) => x.keys))
  check(r.reply && r.reply.stored === true, 'host: the reply says the receipt was stored when the library accepted it', r.reply)
}
const numericCases: [string, any, string][] = [
  ['GitHub number 42', 42, '42'],
  ['GitHub string "42"', '42', '42'],
  ['Markdown string "01" (String(Number("01")) is "1")', '01', '1'],
  ['padded with spaces " 7 "', ' 7 ', '7'],
  ['the local container number 0', 0, '0'],
]
for (const [label, key, want] of numericCases) {
  const r = await hostComment({ number: key, body: 'hello', cwd: CWD })
  check(r.reply && r.reply.ok === true && r.comments.length === 1 && r.comments[0].key === want, 'host: ' + label + ' still sends ' + JSON.stringify(want), r.comments)
}
for (const [label, key] of [['an empty key', ''], ['a blank key', '   '], ['a missing key', undefined], ['NaN', NaN], ['an object key', {}]] as [string, any][]) {
  const r = await hostComment({ number: key, body: 'hello', cwd: CWD })
  check(r.reply && r.reply.ok === false && r.reply.error && r.reply.error.kind === 'parse' && r.comments.length === 0 && r.opens === 0, 'host: ' + label + ' is still refused as a parse error before any session opens', r.reply)
}
for (const [label, body] of [['a missing body', undefined], ['an empty body', ''], ['a blank body', '  \n ']] as [string, any][]) {
  const r = await hostComment({ number: 'OMB-900', body, cwd: CWD })
  check(r.reply && r.reply.ok === false && r.reply.error && r.reply.error.kind === 'parse' && r.comments.length === 0, 'host: ' + label + ' is still refused for a text key and nothing is sent', r.reply)
}
{
  const r = await hostComment({ number: 'OMB-900', body: 'hello' })
  check(r.reply && r.reply.ok === false && r.comments.length === 0, 'host: a call without a workspace directory is still refused', r.reply)
}

// ---------------------------------------------------------------------------
// B. client: submitIssueComment (the real function, with the names the panel closure provides)
// ---------------------------------------------------------------------------
const g: any = globalThis
const hostCalls: any[] = []
const rowWrites: any[] = []
g.tr = (key: any) => String(key)
g.idOfParts = (a: any, b: any) => String(a) + '\u0000' + String(b)
g.log = () => {}
g.emit = () => {}
g.isEnabled = () => false
g.dswsLogHash = (s: any) => String(s)
g.dswsLogTrunc = (s: any) => String(s)
g.markRowWrite = (_st: any, num: any, effort: any) => { rowWrites.push({ num, effort }) }
g.host = { call: async (method: string, args: any) => { hostCalls.push({ method, args }); return { ok: true, data: { body: args.body }, stored: true } } }
const api: any = await import('../src/client/kernel/api-io.ts')

async function clientComment(key: any, body: any = 'hello', opts: any = { effortId: 'e1' }): Promise<{ res: any, calls: any[], writes: any[] }> {
  hostCalls.length = 0
  rowWrites.length = 0
  const res = await api.submitIssueComment({ cwd: CWD }, key, body, opts)
  return { res, calls: hostCalls.slice(), writes: rowWrites.slice() }
}

console.log('== B. client ==')
{
  const r = await clientComment('OMB-900')
  check(r.res && r.res.ok === true, 'client: submitting on the text key OMB-900 succeeds', r.res)
  check(r.calls.length === 1 && r.calls[0].method === 'wf.commentIssue' && r.calls[0].args.number === 'OMB-900', 'client: wf.commentIssue receives number "OMB-900" as text', r.calls)
  check(r.calls.length === 1 && r.calls[0].args.body === 'hello' && r.calls[0].args.effortId === 'e1' && r.calls[0].args.cwd === CWD, 'client: body, effortId and cwd travel with it', r.calls)
  check(r.writes.length === 1 && r.writes[0].num === 'OMB-900' && r.writes[0].effort === 'e1', 'client: the row-write mark is recorded for "OMB-900"', r.writes)
}
const clientNumeric: [string, any, any][] = [
  ['GitHub number 42', 42, 42],
  ['GitHub string "42"', '42', 42],
  ['Markdown string "01"', '01', 1],
  ['padded with spaces " 7 "', ' 7 ', 7],
  ['the local container number 0', 0, 0],
  ['the local container string "00"', '00', 0],
]
for (const [label, key, want] of clientNumeric) {
  const r = await clientComment(key)
  check(r.res && r.res.ok === true && r.calls.length === 1 && r.calls[0].args.number === want && typeof r.calls[0].args.number === 'number', 'client: ' + label + ' is still sent as the number ' + JSON.stringify(want), r.calls)
  check(r.writes.length === 1 && r.writes[0].num === want, 'client: ' + label + ' records the row-write mark with the same number', r.writes)
}
for (const [label, key] of [['an empty string', ''], ['a blank string', '   '], ['null', null], ['undefined', undefined], ['NaN', NaN], ['the number -1', -1], ['the string "-1"', '-1'], ['an object', {}], ['Infinity', Infinity]] as [string, any][]) {
  const r = await clientComment(key)
  check(r.res && r.res.ok === false && r.res.error && r.res.error.message === 'invalid number' && r.calls.length === 0, 'client: ' + label + ' is refused with "invalid number" and the host is not called', r)
}
{
  const r = await clientComment('OMB-900', '   ')
  check(r.res && r.res.ok === false && r.res.error && r.res.error.message === 'comment body required' && r.calls.length === 0, 'client: an empty body is still refused for a text key and the host is not called', r)
}

printGateResult('verify-45-comment-text-key', assertions, failed)
if (failed) process.exit(1)
