// tests/verify-33-linear-create.ts — creating a ticket on the Linear room: labels, containers and the idempotency anchor (#33)
//
// Why this gate exists: the failure worth pinning is a create that looks done. Three things are checked:
//   C1  create resolves the team by key; one `issueCreate` carries `labelIds` (missing labels are created as
//       team labels, another team's label is never attached); blank title / missing team / assignees / a blank
//       label name are refused before any request.
//   C2  a container is created in ONE write: a map carries `wayfinder:map` in that same call and reads back as a
//       map, a spec carries the body marker and no label and reads back as a spec.
//   C3  an idempotency anchor is written as the first body line; a hit returns the old ticket with no write; a
//       closed or longer-key candidate is no hit; a lookup that cannot be sure fails and creates nothing.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-33-linear-create.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { createIssue } from '../src/tracker/rooms/linear/write.ts'
import { lookupByAnchor } from '../src/tracker/rooms/linear/anchor.ts'
import { anchorLineFor } from '../src/refresh/contract/idempotency-keys.ts'
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
  console.log('C1 create resolves the team, carries labelIds, and refuses what it cannot configure')
  {
    const { ctx, calls } = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] } },
      { issueCreate: { success: true, issue: ISSUE_NODE } },
    ])
    const created = await createIssue(ctx, ACCOUNT, { title: 'A new ticket', body: 'body' } as any, 'ENG')
    check(created.ok === true && created.data.key === 'ENG-123', 'creating returns the normalised ticket', created.ok ? created.data.key : JSON.stringify(created.error))
    const sent = calls[1] ? JSON.parse(calls[1].body).variables.input : {}
    check(sent.teamId === 'team-1' && sent.title === 'A new ticket' && sent.description === 'body', 'the mutation carries the team id, the title and the body', JSON.stringify(sent))

    const noTitle = ctxAnswering([{ teams: { nodes: [] } }])
    const blank = await createIssue(noTitle.ctx, ACCOUNT, { title: '   ' } as any, 'ENG')
    check(blank.ok === false && blank.error.kind === 'conflict', 'a ticket without a title is refused', blank.ok ? 'ok' : blank.error.kind)
    check(noTitle.calls.length === 0, 'and nothing is sent for it', String(noTitle.calls.length))

    const withAssignees = ctxAnswering([{ teams: { nodes: [] } }])
    const noPeople = await createIssue(withAssignees.ctx, ACCOUNT, { title: 'x', assignees: [{ login: 'danilo' }] } as any, 'ENG')
    check(noPeople.ok === false && noPeople.error.kind === 'unsupported', 'assignees at creation are refused, not dropped', noPeople.ok ? 'ok' : noPeople.error.kind)
    check(/assignees/.test(noPeople.ok ? '' : noPeople.error.message), 'and the refusal names the missing capability', noPeople.ok ? 'ok' : noPeople.error.message)
    check(withAssignees.calls.length === 0, 'and nothing is sent for it', String(withAssignees.calls.length))

    const noTeam = ctxAnswering([{ teams: { nodes: [] } }])
    const teamless = await createIssue(noTeam.ctx, ACCOUNT, { title: 'x' } as any, '')
    check(teamless.ok === false && teamless.error.kind === 'env' && noTeam.calls.length === 0, 'a binding with no team is refused before any request', teamless.ok ? 'ok' : teamless.error.kind)

    // The label path: one lookup, one issueCreate carrying labelIds; the label already exists on the team.
    const withLabel = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueLabels: { nodes: [{ id: 'lab-bug', name: 'bug', color: '#EB5757', team: { id: 'team-1', key: 'ENG' } }], pageInfo: { hasNextPage: false } } },
      { issueCreate: { success: true, issue: { ...ISSUE_NODE, labels: { nodes: [{ name: 'bug', color: '#EB5757' }] } } } },
    ])
    const labelled = await createIssue(withLabel.ctx, ACCOUNT, { title: 'x', labels: [{ name: 'bug' }] } as any, 'ENG')
    const creates = withLabel.calls.map((c) => JSON.parse(c.body)).filter((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(labelled.ok === true, 'a ticket with a label is created', labelled.ok ? 'ok' : JSON.stringify(labelled.error))
    check(creates.length === 1 && JSON.stringify(creates[0].variables.input.labelIds) === JSON.stringify(['lab-bug']), 'one issueCreate carries labelIds', JSON.stringify(creates.map((c) => c.variables.input)))
    check(labelled.ok && labelled.data.labels.some((l) => l.name === 'bug'), 'and the label reads back on the ticket', labelled.ok ? JSON.stringify(labelled.data.labels) : 'n/a')

    // A missing label is created as a TEAM label (teamId given), then attached; a label of another team is never used.
    const missing = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueLabels: { nodes: [{ id: 'lab-other', name: 'bug', color: '#EB5757', team: { id: 'team-2', key: 'OPS' } }], pageInfo: { hasNextPage: false } } },
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueLabelCreate: { success: true, issueLabel: { id: 'lab-new', name: 'bug', team: { id: 'team-1', key: 'ENG' } } } },
      { issueCreate: { success: true, issue: ISSUE_NODE } },
    ])
    await createIssue(missing.ctx, ACCOUNT, { title: 'x', labels: [{ name: 'bug' }] } as any, 'ENG')
    const sentMissing = missing.calls.map((c) => JSON.parse(c.body))
    const labelCreate = sentMissing.find((b) => String(b.query).indexOf('issueLabelCreate(') >= 0)
    const createCall = sentMissing.find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(!!labelCreate && labelCreate.variables.input.teamId === 'team-1', 'a missing label is created as a team label', JSON.stringify(labelCreate && labelCreate.variables))
    check(!!createCall && JSON.stringify(createCall.variables.input.labelIds) === JSON.stringify(['lab-new']), 'another team\'s label of the same name is never attached', JSON.stringify(createCall && createCall.variables.input))

    // A blank label name is refused as a whole: no request is sent for a half-labelled ticket.
    const blankLabel = ctxAnswering([{ teams: { nodes: [] } }])
    const refusedBlank = await createIssue(blankLabel.ctx, ACCOUNT, { title: 'x', labels: [{ name: '   ' }] } as any, 'ENG')
    check(refusedBlank.ok === false && blankLabel.calls.length === 0, 'a blank label name is refused and nothing is sent', refusedBlank.ok ? 'ok' : String(blankLabel.calls.length))
  }

  console.log('C2 a container is created in one write: a map by label, a spec by body marker')
  {
    const MAP_NODE = { ...ISSUE_NODE, identifier: 'ENG-1', labels: { nodes: [{ name: 'wayfinder:map', color: '#5E6AD2' }] } }
    const map = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueLabels: { nodes: [{ id: 'lab-map', name: 'wayfinder:map', color: '#5E6AD2', team: { id: 'team-1', key: 'ENG' } }], pageInfo: { hasNextPage: false } } },
      { issueCreate: { success: true, issue: MAP_NODE } },
    ])
    const created = await createIssue(map.ctx, ACCOUNT, { title: 'A map', type: 'map' } as any, 'ENG')
    const mapCreates = map.calls.map((c) => JSON.parse(c.body)).filter((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(created.ok === true && created.data.type === 'map', 'creating a map reads back as a map', created.ok ? created.data.type : JSON.stringify(created.error))
    check(mapCreates.length === 1 && JSON.stringify(mapCreates[0].variables.input.labelIds) === JSON.stringify(['lab-map']), 'the wayfinder:map label rides the same issueCreate', JSON.stringify(mapCreates.map((c) => c.variables.input)))
    check(map.calls.filter((c) => String(JSON.parse(c.body).query).indexOf('issueUpdate(') >= 0).length === 0, 'and no later label write exists', 'issueUpdate was sent')

    // A caller that already gave the map label does not get it twice.
    const twice = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueLabels: { nodes: [{ id: 'lab-map', name: 'wayfinder:map', team: null }], pageInfo: { hasNextPage: false } } },
      { issueCreate: { success: true, issue: MAP_NODE } },
    ])
    await createIssue(twice.ctx, ACCOUNT, { title: 'A map', type: 'map', labels: [{ name: 'wayfinder:map' }] } as any, 'ENG')
    const twiceInput = twice.calls.map((c) => JSON.parse(c.body)).find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(!!twiceInput && twiceInput.variables.input.labelIds.length === 1, 'the map label is not added twice', JSON.stringify(twiceInput && twiceInput.variables.input))

    // A spec carries NO label; the marker line stays the first thing of the body, and it reads back as a spec.
    const MARKER = '<!-- DSH-ISSUE-KIND: spec -->'
    const SPEC_NODE = { ...ISSUE_NODE, identifier: 'ENG-2', description: MARKER + '\n\n## Purpose\n' }
    const spec = ctxAnswering([
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueCreate: { success: true, issue: SPEC_NODE } },
    ])
    const specCreated = await createIssue(spec.ctx, ACCOUNT, { title: 'A spec', type: 'spec', body: '## Purpose\n' } as any, 'ENG')
    const specInput = spec.calls.map((c) => JSON.parse(c.body)).find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(specCreated.ok === true && specCreated.data.type === 'spec', 'creating a spec reads back as a spec', specCreated.ok ? specCreated.data.type : JSON.stringify(specCreated.error))
    check(!!specInput && specInput.variables.input.labelIds === undefined, 'a spec carries no label', JSON.stringify(specInput && specInput.variables.input))
    check(!!specInput && String(specInput.variables.input.description).split('\n')[0] === MARKER, 'the spec marker is added when the body had none', JSON.stringify(specInput && specInput.variables.input.description))

    // The deck already writes the marker: it is kept exactly once, not duplicated.
    const marked = ctxAnswering([{ teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } }, { issueCreate: { success: true, issue: SPEC_NODE } }])
    await createIssue(marked.ctx, ACCOUNT, { title: 'A spec', type: 'spec', body: MARKER + '\n\n## Purpose\n' } as any, 'ENG')
    const markedInput = marked.calls.map((c) => JSON.parse(c.body)).find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(!!markedInput && String(markedInput.variables.input.description).split(MARKER).length === 2, 'a marker the caller already wrote is not duplicated', JSON.stringify(markedInput && markedInput.variables.input.description))
  }

  console.log('C3 an idempotency anchor: written first, a hit reuses the ticket, an unsure lookup creates nothing')
  {
    const KEY = 'deck-931b382c-5983073'
    // ISSUE_NODE is a closed ticket (state `completed`); an anchor only counts on an OPEN one, so this node is open.
    const ANCHORED = { ...ISSUE_NODE, identifier: 'ENG-9', description: anchorLineFor(KEY) + 'body', state: { name: 'Todo', type: 'unstarted' } }

    // Miss: nothing carries the anchor -> create, with the anchor as the first body line.
    // The look-up comes first in the call order: anchor search, then team, then create.
    const missCtx = ctxAnswering([
      { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } },
      { issueCreate: { success: true, issue: ANCHORED } },
    ])
    const made = await createIssue(missCtx.ctx, ACCOUNT, { title: 'x', body: 'body', idempotencyKey: KEY } as any, 'ENG')
    const missSent = missCtx.calls.map((c) => JSON.parse(c.body))
    const search = missSent[0]
    check(made.ok === true, 'no hit: the ticket is created', made.ok ? 'ok' : JSON.stringify(made.error))
    check(String(search.query).indexOf('issues(') >= 0 && search.variables.filter.team.key.eq === 'ENG' && search.variables.filter.description.contains === KEY, 'the search is scoped to the team and to the key', JSON.stringify(search.variables))
    const createdInput = missSent.find((b) => String(b.query).indexOf('issueCreate(') >= 0)
    check(!!createdInput && String(createdInput.variables.input.description).split('\n')[0] === anchorLineFor(KEY).trim(), 'the anchor is the first line of the body', JSON.stringify(createdInput && createdInput.variables.input.description))

    // Hit: an open ticket carries the anchor -> the old ticket comes back and not one write is sent.
    const hit = ctxAnswering([{ issues: { nodes: [ANCHORED], pageInfo: { hasNextPage: false } } }])
    const reused = await createIssue(hit.ctx, ACCOUNT, { title: 'x', body: 'body', idempotencyKey: KEY } as any, 'ENG')
    check(reused.ok === true && reused.data.key === 'ENG-9', 'a hit returns the same ticket', reused.ok ? reused.data.key : JSON.stringify(reused.error))
    check(hit.calls.length === 1, 'and sends no write (only the search)', String(hit.calls.length))

    // A closed ticket is no hit; so is a ticket that merely mentions a longer key (substring from the server).
    const closed = { ...ANCHORED, state: { name: 'Done', type: 'completed' } }
    const lookClosed = await lookupByAnchor(ctxAnswering([{ issues: { nodes: [closed], pageInfo: { hasNextPage: false } } }]).ctx, ACCOUNT, 'ENG', KEY)
    check(lookClosed.ok === true && lookClosed.hit === false, 'a closed ticket is not a hit', JSON.stringify(lookClosed))
    const longer = { ...ISSUE_NODE, identifier: 'ENG-10', description: anchorLineFor(KEY + '9') + 'body' }
    const lookLonger = await lookupByAnchor(ctxAnswering([{ issues: { nodes: [longer], pageInfo: { hasNextPage: false } } }]).ctx, ACCOUNT, 'ENG', KEY)
    check(lookLonger.ok === true && lookLonger.hit === false, 'a ticket carrying a longer key is not a hit', JSON.stringify(lookLonger))

    // Unsure: the search fails, or never reaches the end -> fail with stage anchor-lookup, create nothing.
    const errCtx = {
      http: { async request() { return { status: 200, headers: { forEach() {} }, body: JSON.stringify({ errors: [{ message: 'boom', extensions: { type: 'invalid input' } }] }) } } },
      logEvent: () => {}, isEnabled: () => false,
    } as unknown as OpContext
    const unsure = await createIssue(errCtx, ACCOUNT, { title: 'x', idempotencyKey: KEY } as any, 'ENG')
    check(unsure.ok === false && (unsure.error as any).stage === 'anchor-lookup', 'a failed lookup fails with stage anchor-lookup', unsure.ok ? 'ok' : JSON.stringify(unsure.error))
    const endless: any[] = []
    for (let i = 0; i < 60; i += 1) endless.push({ issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c' + i } } })
    const never = ctxAnswering(endless)
    const stuck = await createIssue(never.ctx, ACCOUNT, { title: 'x', idempotencyKey: KEY } as any, 'ENG')
    check(stuck.ok === false && (stuck.error as any).stage === 'anchor-lookup', 'an endless result is "not sure", not "not found"', stuck.ok ? 'ok' : JSON.stringify(stuck.error))
    check(never.calls.every((c) => String(JSON.parse(c.body).query).indexOf('issueCreate(') < 0), 'and no ticket was created', 'a create was sent')

    // A key the contract refuses is refused before any request.
    const badKey = ctxAnswering([{ teams: { nodes: [] } }])
    const refused = await createIssue(badKey.ctx, ACCOUNT, { title: 'x', idempotencyKey: 'has space' } as any, 'ENG')
    check(refused.ok === false && refused.error.kind === 'parse' && badKey.calls.length === 0, 'an unusable key is refused and nothing is sent', refused.ok ? 'ok' : String(badKey.calls.length))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })