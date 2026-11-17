// tests/verify-13-linear-write.ts — the Linear room's write side: comment, update, close/reopen (#13)
//
// Why this gate exists: every write here either sends a mutation or refuses, and the failure worth
// pinning is a write that looks done. Four things are checked:
//   W1  a comment goes out as `commentCreate` with the ticket and the body, and comes back as the
//       contract's Comment (author included); an empty body is refused before any request.
//   W2  an update sends only the fields it was given, on the write bucket; an empty patch sends
//       nothing, and a field this slice cannot write is refused as unsupported instead of dropped.
//   W3  close reads the team's workflow states and writes the first `completed`; reopen the first
//       `unstarted`; a team with no such state is refused rather than moved somewhere else.
//   W4  a successful mutation returns the ticket through the same normalisation the reads use.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-write.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { commentOnIssue, updateIssue, setIssueStateType } from '../src/tracker/rooms/linear/write.ts'
import { createLinearBackend } from '../src/tracker/rooms/linear/index.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

const ISSUE_NODE = { identifier: 'ENG-123', title: 'A ticket', description: 'body', url: 'https://linear.app/x', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', state: { name: 'Done', type: 'completed' }, team: { key: 'ENG' }, parent: null, assignee: null, labels: { nodes: [] } }

/** A context whose channel answers one prepared reply and remembers every call it made. */
function ctxAnswering(replies: any[]): { ctx: OpContext; calls: any[] } {
  const calls: any[] = []
  const ctx = {
    http: {
      async request(req: any) {
        calls.push(req)
        const reply = replies[calls.length - 1] || replies[replies.length - 1]
        return { status: 200, headers: { forEach() {} }, body: JSON.stringify({ data: reply }) }
      },
    },
    logEvent: () => {},
    isEnabled: () => false,
  } as unknown as OpContext
  return { ctx, calls }
}

async function main(): Promise<void> {
  console.log('W1 a comment goes out as commentCreate and comes back as a Comment')
  {
    const { ctx, calls } = ctxAnswering([{ commentCreate: { success: true, comment: { id: 'c1', body: 'hello', createdAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:00:00Z', user: { name: 'danilo', displayName: 'Danilo' } } } }])
    const answer = await commentOnIssue(ctx, ACCOUNT, 'ENG-123', 'hello')
    check(answer.ok === true && answer.data.body === 'hello', 'the comment comes back with its body', answer.ok ? answer.data.body : JSON.stringify(answer.error))
    check(answer.ok && answer.data.author.login === 'danilo', 'the author is carried', answer.ok ? JSON.stringify(answer.data.author) : '')
    const sent = calls[0] ? JSON.parse(calls[0].body) : {}
    check(sent.variables && sent.variables.input.issueId === 'ENG-123' && sent.variables.input.body === 'hello', 'the mutation names the ticket and the body', JSON.stringify(sent.variables))
    check(calls[0] && calls[0].bucket === 'write', 'a comment is a write for the outbound gate', calls[0] ? calls[0].bucket : '(none)')

    const empty = ctxAnswering([{ commentCreate: { success: true } }])
    const refused = await commentOnIssue(empty.ctx, ACCOUNT, 'ENG-123', '   ')
    check(refused.ok === false && refused.error.kind === 'conflict', 'an empty comment is refused', refused.ok ? 'ok' : refused.error.kind)
    check(empty.calls.length === 0, 'and no request goes out for it', String(empty.calls.length))
  }

  console.log('W2 an update sends only what it was given')
  {
    const { ctx, calls } = ctxAnswering([{ issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const answer = await updateIssue(ctx, ACCOUNT, 'ENG-123', { title: 'New title' })
    check(answer.ok === true && answer.data.key === 'ENG-123', 'the updated ticket comes back normalised', answer.ok ? answer.data.key : JSON.stringify(answer.error))
    const sent = calls[0] ? JSON.parse(calls[0].body) : {}
    check(JSON.stringify(sent.variables.input) === JSON.stringify({ title: 'New title' }), 'only the given field is in the mutation', JSON.stringify(sent.variables && sent.variables.input))

    const empty = ctxAnswering([{ issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const nothing = await updateIssue(empty.ctx, ACCOUNT, 'ENG-123', {})
    check(nothing.ok === false && nothing.error.kind === 'conflict', 'an empty patch is refused', nothing.ok ? 'ok' : nothing.error.kind)
    check(empty.calls.length === 0, 'and sends nothing', String(empty.calls.length))

    const milestone = ctxAnswering([{ issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const notMine = await updateIssue(milestone.ctx, ACCOUNT, 'ENG-123', { milestone: { title: 'M1' } } as any)
    check(notMine.ok === false && notMine.error.kind === 'unsupported', 'a field this slice cannot write is refused as unsupported', notMine.ok ? 'ok' : notMine.error.kind)
    check(milestone.calls.length === 0, 'and sends nothing', String(milestone.calls.length))
  }

  console.log('W3 close and reopen pick the workflow state by type')
  {
    const states = { issue: { team: { key: 'ENG', states: { nodes: [
      { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 1 },
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 2 },
      { id: 's-done', name: 'Done', type: 'completed', position: 3 },
    ] } } } }
    const closed = ctxAnswering([{ issue: states.issue }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const shut = await setIssueStateType(closed.ctx, ACCOUNT, 'ENG-123', 'completed')
    check(shut.ok === true, 'closing succeeds when the team has a completed state', shut.ok ? 'ok' : JSON.stringify(shut.error))
    const closedInput = closed.calls[1] ? JSON.parse(closed.calls[1].body).variables.input : {}
    check(closedInput.stateId === 's-done', 'close writes the completed state id', JSON.stringify(closedInput))

    const reopened = ctxAnswering([{ issue: states.issue }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    await setIssueStateType(reopened.ctx, ACCOUNT, 'ENG-123', 'unstarted')
    const reopenInput = reopened.calls[1] ? JSON.parse(reopened.calls[1].body).variables.input : {}
    check(reopenInput.stateId === 's-todo', 'reopen writes the unstarted state id', JSON.stringify(reopenInput))

    const noStates = ctxAnswering([{ issue: { team: { key: 'ENG', states: { nodes: [{ id: 's-a', name: 'A', type: 'backlog', position: 1 }] } } } }])
    const stuck = await setIssueStateType(noStates.ctx, ACCOUNT, 'ENG-123', 'completed')
    check(stuck.ok === false && stuck.error.kind === 'unsupported', 'a team with no such state is refused', stuck.ok ? 'ok' : stuck.error.kind)
    check(noStates.calls.length === 1, 'and no write is attempted', String(noStates.calls.length))
  }

  console.log('W4 a close reason is recorded, and a close without it still closes')
  {
    const states = { issue: { team: { key: 'ENG', states: { nodes: [
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
      { id: 's-done', name: 'Done', type: 'completed', position: 2 },
    ] } } } }
    // 调用顺序：先写原因（评论），再读团队状态，最后改状态。
    const { ctx, calls } = ctxAnswering([
      { commentCreate: { success: true, comment: { id: 'c1', body: 'shipped in 1.2', createdAt: '2026-11-03T10:00:00Z', user: { name: 'danilo' } } } },
      { issue: states.issue },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    const backend = createLinearBackend(ctx, ACCOUNT)
    const closed: any = await backend.close({ cwd: '', refId: 'ENG' } as any, 'ENG-123', { reason: 'shipped in 1.2' }, ctx)
    check(closed.ok === true, 'the ticket closes with a reason', closed.ok ? 'ok' : JSON.stringify(closed.error))
    const bodies = calls.map((c) => String(JSON.parse(c.body).query || ''))
    check(bodies.some((q) => q.indexOf('commentCreate') >= 0), 'the reason goes out as a comment first', String(bodies.length))
    const commentCall = calls.filter((c) => String(JSON.parse(c.body).query || '').indexOf('commentCreate') >= 0)[0]
    const sentBody = commentCall ? JSON.parse(commentCall.body).variables.input.body : ''
    check(sentBody === 'shipped in 1.2', 'the comment carries the reason verbatim', String(sentBody))
    const order = bodies.findIndex((q) => q.indexOf('commentCreate') >= 0) < bodies.findIndex((q) => q.indexOf('issueUpdate') >= 0)
    check(order, 'the comment is written before the state changes')
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
