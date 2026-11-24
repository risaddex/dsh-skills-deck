// tests/verify-85-linear-label-resolution.ts — Linear label names ignore case, and a refused label creation is explained (#85)
//
// Why this gate exists: in the `guedder` workspace the app token may not create labels and the workspace label is
// spelled `Bug`, so every ticket that needed `bug` or a `wayfinder:*` label failed with a bare "not allowed to take
// action". Three things are pinned, both for creating a ticket and for replacing the labels of an existing one:
//   M1  a label that differs only in case satisfies the request: its id is used and no label is created;
//   M2  the lookup is case-insensitive (an `or` of eqIgnoreCase conditions, in the caller order) and the choice among
//       same-named labels keeps own team, then workspace, then prefers the exact spelling;
//   M3  when Linear refuses to create a missing label, nothing is written, the failure names the step, quotes Linear,
//       lists every label that is still missing and says where to create them (only when the cause is permission).
// The older gates (verify-13-linear-labels, verify-33-linear-create) keep guarding everything that did not change.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-85-linear-label-resolution.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { setLabelsOfIssue } from '../src/tracker/rooms/linear/labels.ts'
import { createIssue } from '../src/tracker/rooms/linear/write.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

const ISSUE_NODE = { identifier: 'ENG-123', title: 'A ticket', description: 'body', url: 'https://linear.app/x', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'ENG' }, parent: null, assignee: null, labels: { nodes: [{ name: 'bug', color: '#EB5757' }, { name: 'docs', color: '#4EA7FC' }] } }

/**
 * A context whose channel answers one prepared reply and remembers every call it made.
 * A reply written as `{ __errors: [...] }` is sent the way Linear sends a refusal: HTTP 200 with an `errors` list.
 */
function ctxAnswering(replies: any[]): { ctx: OpContext; calls: any[] } {
  const calls: any[] = []
  const ctx = {
    http: {
      async request(req: any) {
        calls.push(req)
        const reply = replies[calls.length - 1] || replies[replies.length - 1]
        const body = reply && reply.__errors ? { errors: reply.__errors } : { data: reply }
        return { status: 200, headers: { forEach() {} }, body: JSON.stringify(body) }
      },
    },
    logEvent: () => {},
    isEnabled: () => false,
  } as unknown as OpContext
  return { ctx, calls }
}

/** The GraphQL document of a call, plus its variables, for assertions about what went out. */
function sentOf(call: any): { query: string; variables: any } {
  if (!call) return { query: '', variables: {} }
  const body = JSON.parse(call.body)
  return { query: String(body.query || ''), variables: body.variables || {} }
}

/** The label ids an issueUpdate call carried, or undefined when that call was not an issue write (keeps a red run readable). */
function writtenIdsOf(call: any): string[] | undefined {
  const input = sentOf(call).variables.input
  return input ? input.labelIds : undefined
}

async function main(): Promise<void> {
  console.log('M1/M2 label names are matched without regard to upper and lower case (#85), when replacing labels')
  {
    // The workspace has `Bug`; the caller asks for `bug`. Linear itself treats the two as one name, so creating
    // `bug` would be refused: the label that exists has to be used, and nothing may be created.
    const upper = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-Bug', name: 'Bug', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    const answer = await setLabelsOfIssue(upper.ctx, ACCOUNT, 'ENG-123', ['bug'], undefined, 'ENG')
    check(answer.ok === true, 'the workspace label `Bug` satisfies a request for `bug`', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(upper.calls.length === 2, 'one lookup and one write: no team lookup and no label creation', String(upper.calls.length))
    check(upper.calls.every((call) => sentOf(call).query.indexOf('issueLabelCreate') < 0), 'no label creation is attempted', String(upper.calls.length))
    check(JSON.stringify(writtenIdsOf(upper.calls[1])) === JSON.stringify(['lbl-Bug']), 'the write uses the id of `Bug`', JSON.stringify(sentOf(upper.calls[1]).variables))

    // The lookup itself must be case-insensitive, otherwise Linear never returns `Bug` for `bug`.
    // Linear has no case-insensitive `in`, so the names go out as an `or` of `eqIgnoreCase` conditions.
    const lookup = sentOf(upper.calls[0])
    const filter = lookup.variables.filter
    check(!!filter && Array.isArray(filter.or) && filter.or.length === 1 && filter.or[0].name && filter.or[0].name.eqIgnoreCase === 'bug', 'the lookup filters names with eqIgnoreCase', JSON.stringify(lookup.variables))
    const two = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }, { id: 'lbl-Docs', name: 'Docs', team: null }] } },
      { issueUpdate: { success: true, issue: ISSUE_NODE } },
    ])
    await setLabelsOfIssue(two.ctx, ACCOUNT, 'ENG-123', ['bug', 'docs'], undefined, 'ENG')
    const twoFilter = sentOf(two.calls[0]).variables.filter
    check(!!twoFilter && JSON.stringify((twoFilter.or || []).map((c: any) => c.name && c.name.eqIgnoreCase)) === JSON.stringify(['bug', 'docs']), 'every wanted name is in the one lookup, in the caller order', JSON.stringify(sentOf(two.calls[0]).variables))
    check(JSON.stringify(writtenIdsOf(two.calls[1])) === JSON.stringify(['lbl-bug', 'lbl-Docs']), 'both are found whatever their case, and written in the caller order', JSON.stringify(sentOf(two.calls[1]).variables))

    // Choosing among same-named labels keeps the existing order (own team, then workspace) and ignores case.
    const both = [{ id: 'lbl-ws', name: 'bug', team: null }, { id: 'lbl-eng', name: 'BUG', team: { id: 'team-1', key: 'ENG' } }]
    const own = ctxAnswering([{ issueLabels: { nodes: both } }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    await setLabelsOfIssue(own.ctx, ACCOUNT, 'ENG-123', ['Bug'], undefined, 'ENG')
    check(JSON.stringify(writtenIdsOf(own.calls[1])) === JSON.stringify(['lbl-eng']), "the binding team's label still wins when the case differs", JSON.stringify(sentOf(own.calls[1]).variables))
    // Same tier, two spellings: the one written exactly as asked is preferred, so a caller who spells it right gets it.
    const exact = ctxAnswering([{ issueLabels: { nodes: [{ id: 'lbl-upper', name: 'BUG', team: null }, { id: 'lbl-exact', name: 'bug', team: null }] } }, { issueUpdate: { success: true, issue: ISSUE_NODE } }])
    await setLabelsOfIssue(exact.ctx, ACCOUNT, 'ENG-123', ['bug'], undefined, 'ENG')
    check(JSON.stringify(writtenIdsOf(exact.calls[1])) === JSON.stringify(['lbl-exact']), 'within one tier the exact spelling is preferred', JSON.stringify(sentOf(exact.calls[1]).variables))
  }

  console.log('M3 Linear refuses to create a missing label: the failure names the step, quotes Linear and lists every missing name (#85), when replacing labels')
  {
    // Linear's own refusal, as the app token of the `guedder` workspace gets it: HTTP 200 with errors[], type `forbidden`.
    const FORBIDDEN = { __errors: [{ message: 'not allowed to take action', extensions: { type: 'forbidden' } }] }
    const refused = ctxAnswering([
      { issueLabels: { nodes: [{ id: 'lbl-docs', name: 'docs', team: null }] } },
      { teams: { nodes: [{ id: 'team-1', key: 'GUE', name: 'Guedder' }] } },
      FORBIDDEN,
    ])
    const answer = await setLabelsOfIssue(refused.ctx, ACCOUNT, 'GUE-1', ['docs', 'bug', 'wayfinder:map', 'wayfinder:task'], undefined, 'GUE')
    check(answer.ok === false, 'a refused label creation fails the whole call', answer.ok ? 'ok' : '')
    const error: any = answer.ok ? {} : answer.error
    check(error.kind === 'auth', 'the kind stays auth, which the receipt maps to backend-unsupported', String(error.kind))
    check(error.stage === 'label-create', 'the failure carries the label-creation step marker', String(error.stage))
    const message = String(error.message || '')
    check(/creating a label/i.test(message), 'the message names the step: creating a label', message)
    check(message.indexOf('not allowed to take action') >= 0, "the message quotes Linear's own words", message)
    check(['bug', 'wayfinder:map', 'wayfinder:task'].every((name) => message.indexOf('"' + name + '"') >= 0), 'it lists every missing name, not only the one that was refused', message)
    check(message.indexOf('"docs"') < 0, 'a label that exists is not reported as missing', message)
    check(/Settings, Labels/.test(message) && message.indexOf('GUE') >= 0 && /retry/i.test(message), 'it says where to create them (Settings, Labels, the team) and to retry', message)
    check(refused.calls.length === 3, 'it stops at the first refusal: no further creation and no issue write', String(refused.calls.length))
    check(refused.calls.every((call) => sentOf(call).query.indexOf('issueUpdate') < 0), 'and the ticket is left unchanged', String(refused.calls.length))

    // A refusal that is not about permission keeps its kind, and still names the step.
    const flaky = ctxAnswering([
      { issueLabels: { nodes: [] } },
      { teams: { nodes: [{ id: 'team-1', key: 'GUE', name: 'Guedder' }] } },
      { __errors: [{ message: 'label name is too long', extensions: { type: 'invalid input' } }] },
    ])
    const invalid = await setLabelsOfIssue(flaky.ctx, ACCOUNT, 'GUE-1', ['bug'], undefined, 'GUE')
    check(invalid.ok === false && invalid.error.kind === 'conflict' && invalid.error.stage === 'label-create', 'another refusal keeps its own kind and carries the same step marker', invalid.ok ? 'ok' : JSON.stringify(invalid.error))
    check(invalid.ok === false && invalid.error.message.indexOf('label name is too long') >= 0 && !/Settings, Labels/.test(invalid.error.message), 'and it does not tell the person to create labels by hand, because the cause is not permission', invalid.ok ? 'ok' : invalid.error.message)
  }

  console.log('M4 a workspace label that differs only in case is used, and a refused label creation creates no ticket (#85), when creating a ticket')
  {
    // The `guedder` workspace has `Bug`; the deck asks for `bug`. Linear treats them as one name, so no label may be created.
    const BUG_NODE = { ...ISSUE_NODE, labels: { nodes: [{ name: 'Bug', color: '#EB5757' }] } }
    const cased = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'GUE' }] } },
      { issueLabels: { nodes: [{ id: 'lab-Bug', name: 'Bug', color: '#EB5757', team: null }], pageInfo: { hasNextPage: false } } },
      { issueCreate: { success: true, issue: BUG_NODE } },
    ])
    const made = await createIssue(cased.ctx, ACCOUNT, { title: 'x', labels: [{ name: 'bug' }] } as any, 'GUE')
    const sentCased = cased.calls.map((c) => JSON.parse(c.body))
    const createCased = sentCased.find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(made.ok === true, 'a ticket asking for `bug` is created when the workspace has `Bug`', made.ok ? 'ok' : JSON.stringify(made.error))
    check(!!createCased && JSON.stringify(createCased.variables.input.labelIds) === JSON.stringify(['lab-Bug']), 'it carries the id of `Bug`', JSON.stringify(createCased && createCased.variables))
    check(sentCased.every((b) => String(b.query).indexOf('issueLabelCreate(') < 0), 'and no label creation is attempted', String(sentCased.length))

    // Linear refuses to create the missing labels: nothing is created, and the failure says what to do.
    const FORBIDDEN = { __errors: [{ message: 'not allowed to take action', extensions: { type: 'forbidden' } }] }
    const refused = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'GUE' }] } },
      { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } },
      { teams: { nodes: [{ id: 'team-1', key: 'GUE' }] } },
      FORBIDDEN,
    ])
    const failedCreate = await createIssue(refused.ctx, ACCOUNT, { title: 'A map', type: 'map', labels: [{ name: 'bug' }] } as any, 'GUE')
    const error: any = failedCreate.ok ? {} : failedCreate.error
    check(failedCreate.ok === false && error.kind === 'auth' && error.stage === 'label-create', 'the create fails with the label-step marker and the auth kind', failedCreate.ok ? 'ok' : JSON.stringify(failedCreate.error))
    check(refused.calls.map((c) => JSON.parse(c.body)).every((b) => String(b.query).indexOf('issueCreate(') < 0), 'no issueCreate is sent: the ticket is not created, and the labels are not silently dropped', String(refused.calls.length))
    check(['bug', 'wayfinder:map'].every((name) => String(error.message).indexOf('"' + name + '"') >= 0) && String(error.message).indexOf('not allowed to take action') >= 0, 'the message lists both missing names, the one asked for and the one the map adds, and quotes Linear', String(error.message))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
