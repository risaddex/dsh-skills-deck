// tests/verify-13-linear-labels.ts — the Linear room's setLabels: names become ids, the list replaces (#13)
//
// Why this gate exists: the contract's setLabels is a REPLACEMENT list, and the failure worth pinning is a
// write that looks done. Six things are checked:
//   L1  names are turned into label ids through one lookup, and the write carries those ids;
//   L2  a name Linear does not have is created (as a team label) and then used in the same write;
//   L3  what goes out is the replacement list, not the ticket's old labels plus the new ones;
//   L4  an empty list clears every label with exactly one request and no lookup at all;
//   L5  a stale expectedUpdatedAt writes nothing, and a matching one reads once and writes once;
//   L6  a blank name is refused before any request, a missing list is refused instead of read as "clear all",
//       and same-name labels are picked deterministically.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-labels.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { setLabelsOfIssue } from '../src/tracker/rooms/linear/labels.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'
import type { LabelInput } from '../src/tracker/contract/inputs.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

const ISSUE_NODE = { identifier: 'ENG-123', title: 'A ticket', description: 'body', url: 'https://linear.app/x', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'ENG' }, parent: null, assignee: null, labels: { nodes: [{ name: 'bug', color: '#EB5757' }, { name: 'docs', color: '#4EA7FC' }] } }

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

/** The GraphQL document of the n-th call, plus its variables, for assertions about what went out. */
function sentOf(call: any): { query: string; variables: any } {
  if (!call) return { query: '', variables: {} }
  const body = JSON.parse(call.body)
  return { query: String(body.query || ''), variables: body.variables || {} }
}

async function main(): Promise<void> {
  console.log('L1 names become label ids through one lookup')
  {
    const { ctx, calls } = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }, { id: 'lbl-docs', name: 'docs', team: { id: 'team-1', key: 'ENG' } }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    const answer = await setLabelsOfIssue(ctx, ACCOUNT, 'ENG-123', ['bug', 'docs'], undefined, 'ENG')
    check(answer.ok === true && answer.data.key === 'ENG-123', 'setting labels returns the normalised ticket', answer.ok ? answer.data.key : JSON.stringify(answer.error))
    check(answer.ok && (answer.data.labels || []).length === 2, 'the returned ticket carries its labels', answer.ok ? JSON.stringify(answer.data.labels) : '')
    check(calls.length === 2, 'one lookup and one write, nothing else', String(calls.length))
    const lookup = sentOf(calls[0])
    check(lookup.query.indexOf('issueLabels') >= 0, 'the first request asks Linear for the labels', lookup.query.slice(0, 80))
    check(JSON.stringify(lookup.variables.names) === JSON.stringify(['bug', 'docs']), 'the lookup asks for both names at once', JSON.stringify(lookup.variables))
    check(calls[0] && calls[0].bucket === 'read', 'the lookup is a read for the outbound gate', calls[0] ? calls[0].bucket : '(none)')
    const write = sentOf(calls[1])
    check(write.query.indexOf('issueUpdate') >= 0, 'the second request is the issue write', write.query.slice(0, 80))
    check(JSON.stringify(write.variables.input.labelIds) === JSON.stringify(['lbl-bug', 'lbl-docs']), 'the write carries the looked-up ids in the caller order', JSON.stringify(write.variables.input))
    check(calls[1] && calls[1].bucket === 'write', 'the write is on the write bucket', calls[1] ? calls[1].bucket : '(none)')
  }

  console.log('L2 a missing name is created and then used')
  {
    const { ctx, calls } = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }] } },
      { teams: { nodes: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] } },
      { issueLabelCreate: { success: true, issueLabel: { id: 'lbl-new', name: 'wayfinder:map', team: { id: 'team-1', key: 'ENG' } } } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    const answer = await setLabelsOfIssue(ctx, ACCOUNT, 'ENG-123', ['bug', 'wayfinder:map'], undefined, 'ENG')
    check(answer.ok === true, 'a name Linear does not have is created instead of refused', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(calls.length === 4, 'lookup, team, creation, write — in that order', String(calls.length))
    const lookup = sentOf(calls[0])
    check(lookup.query.indexOf('issueLabels') >= 0, 'the lookup comes first', lookup.query.slice(0, 60))
    const creation = sentOf(calls[2])
    check(creation.query.indexOf('issueLabelCreate') >= 0, 'the missing name is created with issueLabelCreate', creation.query.slice(0, 80))
    check(creation.variables.input.name === 'wayfinder:map', 'the creation carries the name verbatim', JSON.stringify(creation.variables.input))
    check(creation.variables.input.teamId === 'team-1', 'the new label belongs to the binding team, not the whole workspace', JSON.stringify(creation.variables.input))
    check(creation.variables.input.organizationId === undefined, 'and no organization field is invented', JSON.stringify(creation.variables.input))
    const write = sentOf(calls[3])
    check(JSON.stringify(write.variables.input.labelIds) === JSON.stringify(['lbl-bug', 'lbl-new']), 'the created id is used in the same write', JSON.stringify(write.variables.input))
  }

  console.log('L3 the list sent is the replacement, not a merge')
  {
    // The returned ticket already carries bug and docs; the caller asks for docs only.
    const { ctx, calls } = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }, { id: 'lbl-docs', name: 'docs', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    await setLabelsOfIssue(ctx, ACCOUNT, 'ENG-123', ['docs'], undefined, 'ENG')
    const write = sentOf(calls[1])
    check(write.query.indexOf('addedLabelIds') < 0 && write.query.indexOf('removedLabelIds') < 0, 'the write is not an add/remove pair', write.query.slice(0, 120))
    check(JSON.stringify(write.variables.input.labelIds) === JSON.stringify(['lbl-docs']), 'only the requested label goes out, the old one is dropped', JSON.stringify(write.variables.input))
    check(JSON.stringify(Object.keys(write.variables.input)) === JSON.stringify(['labelIds']), 'the write sends the label list and nothing else', JSON.stringify(Object.keys(write.variables.input)))
  }

  console.log('L4 an empty list clears every label and sends no lookup')
  {
    const bare = { ...ISSUE_NODE, labels: { nodes: [] } }
    const { ctx, calls } = ctxAnswering([{ issueUpdate: { success: true, issue: bare } }])
    const answer = await setLabelsOfIssue(ctx, ACCOUNT, 'ENG-123', [], undefined, 'ENG')
    check(answer.ok === true, 'clearing succeeds', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(calls.length === 1, 'exactly one request goes out', String(calls.length))
    const write = sentOf(calls[0])
    check(write.query.indexOf('issueUpdate') >= 0, 'and it is the issue write', write.query.slice(0, 80))
    check(Array.isArray(write.variables.input.labelIds) && write.variables.input.labelIds.length === 0, 'the empty list is what Linear receives, which removes all labels', JSON.stringify(write.variables.input))
    check(calls.every((call) => sentOf(call).query.indexOf('issueLabels') < 0), 'no label lookup is sent for an empty list', String(calls.length))
  }

  console.log('L5 a stale expectedUpdatedAt writes nothing')
  {
    const stale = ctxAnswering([{ issue: { identifier: 'ENG-123', updatedAt: '2026-11-09T00:00:00Z' } }])
    const refused = await setLabelsOfIssue(stale.ctx, ACCOUNT, 'ENG-123', ['bug'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' }, 'ENG')
    check(refused.ok === false && refused.error.kind === 'conflict', 'a stale expectedUpdatedAt is a conflict', refused.ok ? 'ok' : refused.error.kind)
    check(stale.calls.length === 1, 'and neither a lookup nor a write is sent', String(stale.calls.length))

    const fresh = ctxAnswering([
      { issue: { identifier: 'ENG-123', updatedAt: '2026-11-01T00:00:00Z' } },
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    const ok = await setLabelsOfIssue(fresh.ctx, ACCOUNT, 'ENG-123', ['bug'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' }, 'ENG')
    check(ok.ok === true, 'a matching timestamp lets the write through', ok.ok ? 'ok' : JSON.stringify(ok.error))
    check(fresh.calls.length === 3, 'the read, the lookup and the write all happen', String(fresh.calls.length))
    check(sentOf(fresh.calls[0]).query.indexOf('updatedAt') >= 0, 'the guard read asks for the ticket timestamp', sentOf(fresh.calls[0]).query.slice(0, 80))

    const unguarded = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    await setLabelsOfIssue(unguarded.ctx, ACCOUNT, 'ENG-123', ['bug'], undefined, 'ENG')
    check(unguarded.calls.length === 2, 'no timestamp means no guard read', String(unguarded.calls.length))
  }

  console.log('L6 blank names are refused, and same-name labels are picked deterministically')
  {
    const blank = ctxAnswering([{ issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const refused = await setLabelsOfIssue(blank.ctx, ACCOUNT, 'ENG-123', ['   '] as LabelInput[], undefined, 'ENG')
    check(refused.ok === false && refused.error.kind === 'conflict', 'a blank label name is refused', refused.ok ? 'ok' : refused.error.kind)
    check(blank.calls.length === 0, 'and no request goes out for it', String(blank.calls.length))

    // A missed argument must not be read as "remove every label": the room refuses it, sends nothing.
    const missingList = ctxAnswering([{ issueUpdate: { success: true, issue: ISSUE_NODE } }])
    const noList = await setLabelsOfIssue(missingList.ctx, ACCOUNT, 'ENG-123', undefined as unknown as LabelInput[], undefined, 'ENG')
    check(noList.ok === false && noList.error.kind === 'conflict', 'a missing replacement list is refused', noList.ok ? 'ok' : noList.error.kind)
    check(missingList.calls.length === 0, 'and nothing is sent for it', String(missingList.calls.length))

    const duplicated = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    await setLabelsOfIssue(duplicated.ctx, ACCOUNT, 'ENG-123', ['bug', 'bug'], undefined, 'ENG')
    const deduped = sentOf(duplicated.calls[1])
    check(JSON.stringify(deduped.variables.input.labelIds) === JSON.stringify(['lbl-bug']), 'a repeated name is written once', JSON.stringify(deduped.variables.input))

    const both = [{ id: 'lbl-ws', name: 'bug', team: null }, { id: 'lbl-eng', name: 'bug', team: { id: 'team-1', key: 'ENG' } }]
    const ownTeam = ctxAnswering([{ issueLabels: { nodes: both } }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    await setLabelsOfIssue(ownTeam.ctx, ACCOUNT, 'ENG-123', ['bug'], undefined, 'ENG')
    check(JSON.stringify(sentOf(ownTeam.calls[1]).variables.input.labelIds) === JSON.stringify(['lbl-eng']), "the binding team's label wins over the workspace label of the same name", JSON.stringify(sentOf(ownTeam.calls[1]).variables.input))
    const otherTeam = ctxAnswering([{ issueLabels: { nodes: both } }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    await setLabelsOfIssue(otherTeam.ctx, ACCOUNT, 'ENG-123', ['bug'], undefined, 'OPS')
    check(JSON.stringify(sentOf(otherTeam.calls[1]).variables.input.labelIds) === JSON.stringify(['lbl-ws']), 'with no label of its own team, the workspace label is preferred', JSON.stringify(sentOf(otherTeam.calls[1]).variables.input))
  }

  console.log('L7 the label lookup is read to the end before anything is created')
  {
    // 第一页没有本团队那份、第二页才有：只看第一页就会重复建标签。
    const replies = [
      { issueLabels: { nodes: [{ id: 'lbl-other', name: 'bug', color: '#EB5757', team: { id: 'team-sales', key: 'SALES' } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { issueLabels: { nodes: [{ id: 'lbl-own', name: 'bug', color: '#EB5757', team: { id: 'team-1', key: 'ENG' } }], pageInfo: { hasNextPage: false, endCursor: null } } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ]
    const { ctx, calls } = ctxAnswering(replies)
    const answer = await setLabelsOfIssue(ctx, ACCOUNT, 'ENG-123', [{ name: 'bug' } as any], undefined, 'ENG')
    check(answer.ok === true, 'the replacement succeeds with a label found on the second page', answer.ok ? 'ok' : JSON.stringify(answer.error))
    const lookups = calls.filter((c) => String(JSON.parse(c.body).query || '').indexOf('issueLabels') >= 0)
    check(lookups.length === 2 && JSON.parse(lookups[1].body).variables.after === 'c1', 'the lookup follows the cursor', String(lookups.length))
    const writes = calls.filter((c) => String(JSON.parse(c.body).query || '').indexOf('issueUpdate') >= 0)
    check(writes.length === 1 && JSON.parse(writes[0].body).variables.input.labelIds[0] === 'lbl-own', 'the write uses the team own label, not the other team one', writes.length ? JSON.stringify(JSON.parse(writes[0].body).variables.input) : '(none)')

    // 翻到上限还没到底：拒绝写，绝不建重复标签。
    const deep = ctxAnswering([{ issueLabels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c1' } } }])
    const refused = await setLabelsOfIssue(deep.ctx, ACCOUNT, 'ENG-123', [{ name: 'bug' } as any], undefined, 'ENG')
    check(refused.ok === false && refused.error.kind === 'unsupported', 'an endless label list is refused', refused.ok ? 'ok' : refused.error.kind)
    check(!deep.calls.some((c) => String(JSON.parse(c.body).query || '').indexOf('issueUpdate') >= 0), 'and nothing is written', String(deep.calls.length))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
