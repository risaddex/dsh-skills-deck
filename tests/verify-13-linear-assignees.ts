// tests/verify-13-linear-assignees.ts — the Linear room's setAssignees: one login, one id, one write (#13)
//
// 门禁归属: src/tracker/rooms/linear
//
// Why this gate exists: the contract's setAssignees takes a REPLACEMENT list, while Linear's
// `issueUpdate` carries a single `assigneeId`. Everything that can go wrong lives in that gap, so
// the pinned things are the ones a person would only notice later, in Linear's UI:
//   A1  one login becomes one user id, and exactly one write goes out with it
//   A2  a login Linear does not know is refused as not-found, and nothing is written
//   A3  two assignees are refused as unsupported, and nothing is written (no silent pick)
//   A4  an empty list clears with `assigneeId: null`, which is a different request from omitting it
//   A5  a stale `expectedUpdatedAt` is a conflict, and nothing is written
//   A6  an empty login and a name that matches two people are refused before any write
//   A7  the lookup filter is the documented shape (displayName OR name, apps excluded)
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-assignees.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { setAssigneesOfIssue } from '../src/tracker/rooms/linear/assignees.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

/** 一张票面：assignee 给什么，读侧的 issueOf 就翻成什么（name 是全名，displayName 是昵称）。 */
function issueNode(assignee: any): any {
  return {
    identifier: 'ENG-123',
    title: 'A ticket',
    description: 'body',
    url: 'https://linear.app/x',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T10:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    team: { key: 'ENG' },
    parent: null,
    assignee,
    labels: { nodes: [] },
  }
}

/** A channel that answers one prepared reply per call and remembers every call it made. */
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

/** 一次请求的正文：查询串与变量分开取，断言里就不用反复 JSON.parse。 */
function sentCall(call: any): { query: string; variables: any; bucket: string } {
  const payload = call ? JSON.parse(call.body) : {}
  return { query: String(payload.query || ''), variables: payload.variables || {}, bucket: String((call && call.bucket) || '') }
}

/** 查人的那个人：昵称 ana、全名 Ana Lima。 */
const ANA = { id: 'user-1', name: 'Ana Lima', displayName: 'ana', app: false }

async function main(): Promise<void> {
  console.log('A1 one login becomes one user id, and one write carries it')
  {
    const { ctx, calls } = ctxAnswering([
      { users: { nodes: [ANA] } },
      { issueUpdate: { success: true, issue: issueNode({ name: 'Ana Lima', displayName: 'ana' }) } },
    ])
    const answer = await setAssigneesOfIssue(ctx, ACCOUNT, 'ENG-123', ['ana'], undefined)
    check(answer.ok === true && answer.data.key === 'ENG-123', 'the changed ticket comes back normalised', answer.ok ? answer.data.key : JSON.stringify(answer.error))
    check(answer.ok && Array.isArray(answer.data.assignees) && answer.data.assignees.length === 1 && answer.data.assignees[0].login === 'Ana Lima',
      'the ticket comes back with the one assignee the read side would show', answer.ok ? JSON.stringify(answer.data.assignees) : '')
    check(calls.length === 2, 'exactly one lookup and one write go out', String(calls.length))
    const lookup = sentCall(calls[0])
    check(lookup.query.indexOf('users(') >= 0 && lookup.bucket === 'read', 'the lookup is a users() read', lookup.bucket + ' / ' + lookup.query.slice(0, 60))
    const write = sentCall(calls[1])
    check(write.query.indexOf('issueUpdate') >= 0, 'the write is an issueUpdate', write.query.slice(0, 60))
    check(write.bucket === 'write', 'the change is a write for the outbound gate', write.bucket)
    check(write.variables.id === 'ENG-123', 'the mutation names the ticket', write.variables.id)
    check(write.variables.input && write.variables.input.assigneeId === 'user-1', 'the mutation carries the resolved user id', JSON.stringify(write.variables.input))
  }

  console.log('A2 a login Linear does not know is refused, and nothing is written')
  {
    const { ctx, calls } = ctxAnswering([{ users: { nodes: [] } }])
    const answer = await setAssigneesOfIssue(ctx, ACCOUNT, 'ENG-123', ['nobody-here'], undefined)
    check(answer.ok === false && answer.error.kind === 'not-found', 'an unknown login is not-found', answer.ok ? 'ok' : answer.error.kind)
    check(answer.ok === false && answer.error.message.indexOf('nobody-here') >= 0, 'the receipt names the login that was not found', answer.ok ? '' : answer.error.message)
    check(calls.length === 1, 'only the lookup goes out; no write is attempted', String(calls.length))
  }

  console.log('A3 two assignees are refused rather than silently collapsed to one')
  {
    const { ctx, calls } = ctxAnswering([{ users: { nodes: [ANA] } }])
    const answer = await setAssigneesOfIssue(ctx, ACCOUNT, 'ENG-123', ['ana', 'bruno'], undefined)
    check(answer.ok === false && answer.error.kind === 'unsupported', 'a second person is unsupported', answer.ok ? 'ok' : answer.error.kind)
    check(calls.length === 0, 'and nothing at all is sent', String(calls.length))
  }

  console.log('A4 an empty list clears the assignee with assigneeId: null')
  {
    const { ctx, calls } = ctxAnswering([{ issueUpdate: { success: true, issue: issueNode(null) } }])
    const answer = await setAssigneesOfIssue(ctx, ACCOUNT, 'ENG-123', [], undefined)
    check(answer.ok === true, 'clearing succeeds', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && Array.isArray(answer.data.assignees) && answer.data.assignees.length === 0, 'the ticket comes back with nobody assigned', answer.ok ? JSON.stringify(answer.data.assignees) : '')
    check(calls.length === 1, 'clearing needs no user lookup and sends one write', String(calls.length))
    const write = sentCall(calls[0])
    check(write.variables.input && write.variables.input.assigneeId === null, 'the write carries assigneeId: null (not an omitted field)', JSON.stringify(write.variables.input))
  }

  console.log('A5 a stale expectedUpdatedAt writes nothing')
  {
    const stale = ctxAnswering([{ issue: { identifier: 'ENG-123', updatedAt: '2026-11-09T00:00:00Z' } }])
    const refused = await setAssigneesOfIssue(stale.ctx, ACCOUNT, 'ENG-123', ['ana'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' })
    check(refused.ok === false && refused.error.kind === 'conflict', 'a stale timestamp is a conflict', refused.ok ? 'ok' : refused.error.kind)
    check(stale.calls.length === 1, 'only the guard read goes out; no write', String(stale.calls.length))

    const fresh = ctxAnswering([
      { issue: { identifier: 'ENG-123', updatedAt: '2026-11-01T00:00:00Z' } },
      { users: { nodes: [ANA] } },
      { issueUpdate: { success: true, issue: issueNode({ name: 'Ana Lima', displayName: 'ana' }) } },
    ])
    const through = await setAssigneesOfIssue(fresh.ctx, ACCOUNT, 'ENG-123', ['ana'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' })
    check(through.ok === true, 'a matching timestamp lets the write through', through.ok ? 'ok' : JSON.stringify(through.error))
    check(fresh.calls.length === 3, 'the guard read, the lookup and the write all happen', String(fresh.calls.length))
    check(sentCall(fresh.calls[2]).variables.input.assigneeId === 'user-1', 'the write still carries the resolved id', JSON.stringify(sentCall(fresh.calls[2]).variables))

    const noGuard = ctxAnswering([{ users: { nodes: [ANA] } }, { issueUpdate: { success: true, issue: issueNode({ name: 'Ana Lima' }) } }])
    await setAssigneesOfIssue(noGuard.ctx, ACCOUNT, 'ENG-123', ['ana'], undefined)
    check(noGuard.calls.length === 2, 'no timestamp means no extra read', String(noGuard.calls.length))
  }

  console.log('A6 a blank login, an ambiguous name and an app account are all refused')
  {
    const blank = ctxAnswering([{ users: { nodes: [ANA] } }])
    const refused = await setAssigneesOfIssue(blank.ctx, ACCOUNT, 'ENG-123', ['   '], undefined)
    check(refused.ok === false && refused.error.kind === 'conflict', 'a blank login is a conflict, not "nobody"', refused.ok ? 'ok' : refused.error.kind)
    check(blank.calls.length === 0, 'and nothing is sent for it', String(blank.calls.length))

    const two = ctxAnswering([{ users: { nodes: [{ id: 'user-1', name: 'Ana Lima', displayName: 'ana' }, { id: 'user-2', name: 'ana', displayName: 'aninha' }] } }])
    const ambiguous = await setAssigneesOfIssue(two.ctx, ACCOUNT, 'ENG-123', ['ana'], undefined)
    check(ambiguous.ok === false && ambiguous.error.kind === 'conflict', 'a login that matches two people is a conflict', ambiguous.ok ? 'ok' : ambiguous.error.kind)
    check(two.calls.length === 1, 'and only the lookup goes out', String(two.calls.length))

    const bot = ctxAnswering([{ users: { nodes: [{ id: 'bot-1', name: 'Ana Lima', displayName: 'ana', app: true }] } }])
    const notPerson = await setAssigneesOfIssue(bot.ctx, ACCOUNT, 'ENG-123', ['ana'], undefined)
    check(notPerson.ok === false && notPerson.error.kind === 'not-found', 'an account that is an application is not a person', notPerson.ok ? 'ok' : notPerson.error.kind)
    check(bot.calls.length === 1, 'and no write goes out for it', String(bot.calls.length))
  }

  console.log('A7 the lookup uses the documented filter, and the login is read from objects too')
  {
    const { ctx, calls } = ctxAnswering([
      { users: { nodes: [{ id: 'user-9', name: 'Ana Lima', displayName: 'aninha' }] } },
      { issueUpdate: { success: true, issue: issueNode({ name: 'Ana Lima', displayName: 'aninha' }) } },
    ])
    const answer = await setAssigneesOfIssue(ctx, ACCOUNT, 'ENG-123', [{ login: 'Ana Lima' }], undefined)
    check(answer.ok === true, 'a { login } object is accepted', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && sentCall(calls[1]).variables.input.assigneeId === 'user-9', 'a full name resolves even when the nick differs', JSON.stringify(sentCall(calls[1]).variables.input))
    const lookup = sentCall(calls[0])
    const filter = lookup.variables.filter || {}
    check(filter.app && filter.app.eq === false, 'the filter excludes application accounts server-side', JSON.stringify(filter.app))
    check(Array.isArray(filter.or) && filter.or.length === 2, 'the filter is an OR of the two name fields', JSON.stringify(filter.or))
    check(filter.or && filter.or[0] && filter.or[0].displayName && filter.or[0].displayName.eqIgnoreCase === 'Ana Lima',
      'the display name is compared case-insensitively', JSON.stringify(filter.or && filter.or[0]))
    check(filter.or && filter.or[1] && filter.or[1].name && filter.or[1].name.eqIgnoreCase === 'Ana Lima',
      'the full name is compared case-insensitively too', JSON.stringify(filter.or && filter.or[1]))

    const duplicated = ctxAnswering([{ users: { nodes: [ANA] } }, { issueUpdate: { success: true, issue: issueNode({ name: 'Ana Lima' }) } }])
    const same = await setAssigneesOfIssue(duplicated.ctx, ACCOUNT, 'ENG-123', ['ana', 'ANA'], undefined)
    check(same.ok === true, 'the same person written twice is one person, not "more than one"', same.ok ? 'ok' : JSON.stringify(same.error))
    check(duplicated.calls.length === 2, 'and it still costs one lookup and one write', String(duplicated.calls.length))

    const noIssue = ctxAnswering([{ users: { nodes: [ANA] } }, { issueUpdate: { success: true, issue: null } }])
    const hollow = await setAssigneesOfIssue(noIssue.ctx, ACCOUNT, 'ENG-123', ['ana'], undefined)
    check(hollow.ok === false && hollow.error.kind === 'conflict', 'a mutation that reports success without an issue is a conflict', hollow.ok ? 'ok' : hollow.error.kind)
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
