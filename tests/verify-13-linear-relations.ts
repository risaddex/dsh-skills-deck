// tests/verify-13-linear-relations.ts — the Linear room's blocking relation: setBlockedBy (#13)
//
// Why this gate exists: this operation rewrites a graph, and the failure that matters is a write that
// looks done while the graph is wrong. The contract states two rules as behaviour, not as advice:
// self-blocking is a conflict, and a write that would close a cycle is a conflict that must never be
// persisted. Everything below pins those two, plus the replacement semantics that makes them worth
// anything:
//   R1  a ticket that names itself as a blocker is refused before any request leaves.
//   R2  a write that would close a cycle is refused, and not one relation mutation is sent
//       (directly and through a two-hop chain).
//   R3  a valid list writes exactly the additions and the removals: a blocker that stays produces no
//       request, removals go first, the edges are built in the blocks direction from research §5,
//       and the answer carries the ticket read back from Linear.
//   R4  a stale expectedUpdatedAt writes nothing, and a matching one lets the write through.
//   R5  an empty list removes every existing blocker (the list is the whole set afterwards).
//   R6  a blocker Linear does not have is a notfound failure before any write.
//   R7  when the cycle check cannot finish inside its bound, the room refuses to write instead of
//       treating "no cycle seen" as "no cycle".
//   R8  a ticket whose own relation list cannot be read whole is refused rather than replaced blindly.
//   R9  the list is normalised: duplicates and case differences do not produce extra requests.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-relations.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { setBlockedByOfIssue } from '../src/tracker/rooms/linear/relations.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'
// The failure kinds are compared through the vocabulary the contract reads from, so a rename there
// cannot leave this gate asserting a word that no longer exists.
import { ERROR_KIND } from '../src/tracker/contract/vocabulary.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

/** The operation name a prepared reply is keyed by (the room names every document). */
function nameOf(query: string): string {
  const m = /^(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(String(query || ''))
  return m ? m[1] : 'anonymous'
}

/**
 * A context whose channel answers by operation name and remembers every call.
 * An operation nobody prepared comes back as a GraphQL error, so a missing route fails loudly
 * instead of being read as an empty answer.
 */
function ctxWith(routes: Record<string, (vars: any, nth: number) => any>): { ctx: OpContext; calls: any[]; ops: () => string[] } {
  const calls: any[] = []
  const seen: Record<string, number> = {}
  const ctx = {
    http: {
      async request(req: any) {
        calls.push(req)
        const body = JSON.parse(req.body || '{}')
        const name = nameOf(body.query)
        seen[name] = (seen[name] || 0) + 1
        const route = routes[name]
        if (!route) {
          return { status: 200, headers: { forEach() {} }, body: JSON.stringify({ errors: [{ message: 'no reply prepared for ' + name }] }) }
        }
        return { status: 200, headers: { forEach() {} }, body: JSON.stringify({ data: route(body.variables || {}, seen[name]) }) }
      },
    },
    logEvent: () => {},
    isEnabled: () => false,
  } as unknown as OpContext
  return { ctx, calls, ops: () => calls.map((c) => nameOf(JSON.parse(c.body).query)) }
}

/** Relation mutations only: these are the calls that change the graph. */
const writes = (ops: string[]): string[] => ops.filter((n) => n === 'DeckRelationCreate' || n === 'DeckRelationDelete')

/** A ticket node answered by DeckBlockedByGraph, with the relations that point at it. */
function graph(identifier: string, updatedAt: string, rels: { id: string; key: string }[], hasNextPage = false): any {
  return {
    issue: {
      id: 'uuid-' + identifier,
      identifier,
      title: identifier + ' ticket',
      description: 'body',
      url: 'https://linear.app/x',
      createdAt: '2026-11-01T10:00:00Z',
      updatedAt,
      state: { name: 'Todo', type: 'unstarted' },
      team: { key: 'ENG' },
      parent: null,
      assignee: null,
      labels: { nodes: [] },
      inverseRelations: {
        pageInfo: { hasNextPage },
        nodes: rels.map((r) => ({ id: r.id, type: 'blocks', issue: { identifier: r.key, title: r.key + ' ticket', state: { type: 'unstarted' } } })),
      },
    },
  }
}

/** A ticket node answered by DeckBlockerNeighbours: who blocks it. */
function neighbours(identifier: string, keys: string[], hasNextPage = false): any {
  return {
    issue: {
      identifier,
      inverseRelations: { pageInfo: { hasNextPage }, nodes: keys.map((k) => ({ type: 'blocks', issue: { identifier: k } })) },
    },
  }
}

const CREATED = { issueRelationCreate: { success: true, issueRelation: { id: 'rel-new' } } }
const DELETED = { issueRelationDelete: { success: true, entityId: 'x' } }

async function main(): Promise<void> {
  console.log('R1 a ticket that blocks itself is refused before any request')
  {
    const { ctx, calls } = ctxWith({ DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', []) })
    const same = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-1'], undefined)
    check(same.ok === false && same.error.kind === ERROR_KIND.CONFLICT, 'naming itself as a blocker is a conflict', same.ok ? 'ok' : same.error.kind)
    check(calls.length === 0, 'and not one request is sent', String(calls.length))

    const mixed = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-2', 'eng-1'], undefined)
    check(mixed.ok === false && mixed.error.kind === ERROR_KIND.CONFLICT, 'a different spelling of itself is caught too', mixed.ok ? 'ok' : mixed.error.kind)
    check(calls.length === 0, 'and still no request', String(calls.length))
  }

  console.log('R2 a write that would close a cycle is refused, and nothing is written')
  {
    const { ctx, calls, ops } = ctxWith({
      DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', []),
      DeckBlockerNeighbours: () => neighbours('ENG-2', ['ENG-1']),
    })
    const direct = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-2'], undefined)
    check(direct.ok === false && direct.error.kind === ERROR_KIND.CONFLICT, 'a blocker that already depends on this ticket is a conflict', direct.ok ? 'ok' : direct.error.kind)
    check(writes(ops()).length === 0, 'and no relation mutation is sent', JSON.stringify(writes(ops())))
    check(calls.length === 2, 'one graph read and one probe, no more', String(calls.length))

    const chain = ctxWith({
      DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', []),
      DeckBlockerNeighbours: (vars: any) => (vars.id === 'ENG-2' ? neighbours('ENG-2', ['ENG-3']) : neighbours('ENG-3', ['ENG-1'])),
    })
    const deep = await setBlockedByOfIssue(chain.ctx, ACCOUNT, 'ENG-1', ['ENG-2'], undefined)
    check(deep.ok === false && deep.error.kind === ERROR_KIND.CONFLICT, 'a two-hop chain back to this ticket is a conflict too', deep.ok ? 'ok' : deep.error.kind)
    check(writes(chain.ops()).length === 0, 'and still nothing is written', JSON.stringify(writes(chain.ops())))
  }

  console.log('R3 a valid list writes the additions and the removals')
  {
    const { ctx, calls, ops } = ctxWith({
      DeckBlockedByGraph: (vars: any, nth: number) =>
        nth === 1
          ? graph('ENG-1', '2026-11-02T10:00:00Z', [{ id: 'rel-2', key: 'ENG-2' }, { id: 'rel-3', key: 'ENG-3' }])
          : graph('ENG-1', '2026-11-03T10:00:00Z', [{ id: 'rel-2', key: 'ENG-2' }, { id: 'rel-new', key: 'ENG-9' }]),
      DeckBlockerNeighbours: () => neighbours('ENG-9', []),
      DeckRelationCreate: () => CREATED,
      DeckRelationDelete: () => DELETED,
    })
    const answer = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-2', 'ENG-9'], undefined)
    check(answer.ok === true, 'the replacement succeeds', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && answer.data.key === 'ENG-1', 'the answer carries the ticket read back from Linear', answer.ok ? answer.data.key : '')
    check(answer.ok && JSON.stringify((answer.data.blockedBy || []).map((b) => b.key)) === JSON.stringify(['ENG-2', 'ENG-9']), 'and the blockers Linear now holds', answer.ok ? JSON.stringify(answer.data.blockedBy) : '')
    const names = ops()
    const all = writes(names)
    check(all.length === 2, 'exactly two mutation calls: one removal and one addition', JSON.stringify(names))
    check(names.indexOf('DeckRelationDelete') < names.indexOf('DeckRelationCreate'), 'the removal goes before the addition')
    const deleteVars = JSON.parse(calls[names.indexOf('DeckRelationDelete')].body).variables
    check(deleteVars.id === 'rel-3', 'the removal names the relation of the blocker that left the list', JSON.stringify(deleteVars))
    const createVars = JSON.parse(calls[names.indexOf('DeckRelationCreate')].body).variables
    check(createVars.input.issueId === 'ENG-9' && createVars.input.relatedIssueId === 'ENG-1' && createVars.input.type === 'blocks', 'the addition is built in the blocks direction (blocker blocks this ticket)', JSON.stringify(createVars))
    check(ops().filter((n) => n === 'DeckRelationCreate').length === 1, 'the blocker that stayed is not written again', String(ops().filter((n) => n === 'DeckRelationCreate').length))
  }

  console.log('R4 a stale expectedUpdatedAt writes nothing')
  {
    const stale = ctxWith({ DeckBlockedByGraph: () => graph('ENG-1', '2026-11-09T00:00:00Z', []) })
    const refused = await setBlockedByOfIssue(stale.ctx, ACCOUNT, 'ENG-1', ['ENG-2'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' })
    check(refused.ok === false && refused.error.kind === ERROR_KIND.CONFLICT, 'a stale timestamp is a conflict', refused.ok ? 'ok' : refused.error.kind)
    check(writes(stale.ops()).length === 0, 'and no relation mutation is sent', JSON.stringify(writes(stale.ops())))
    check(stale.calls.length === 1, 'only the read happens', String(stale.calls.length))

    const fresh = ctxWith({
      DeckBlockedByGraph: (vars: any, nth: number) => graph('ENG-1', '2026-11-01T00:00:00Z', nth === 1 ? [] : [{ id: 'rel-new', key: 'ENG-2' }]),
      DeckBlockerNeighbours: () => neighbours('ENG-2', []),
      DeckRelationCreate: () => CREATED,
    })
    const allowed = await setBlockedByOfIssue(fresh.ctx, ACCOUNT, 'ENG-1', ['ENG-2'], { expectedUpdatedAt: '2026-11-01T00:00:00Z' })
    check(allowed.ok === true, 'a matching timestamp lets the write through', allowed.ok ? 'ok' : JSON.stringify(allowed.error))
    check(fresh.ops().filter((n) => n === 'DeckRelationCreate').length === 1, 'and the addition is written once', String(fresh.ops().filter((n) => n === 'DeckRelationCreate').length))
  }

  console.log('R5 an empty list removes every blocker')
  {
    const { ctx, ops } = ctxWith({
      DeckBlockedByGraph: (vars: any, nth: number) =>
        graph('ENG-1', '2026-11-02T10:00:00Z', nth === 1 ? [{ id: 'rel-2', key: 'ENG-2' }, { id: 'rel-3', key: 'ENG-3' }] : []),
      DeckRelationDelete: () => DELETED,
    })
    const answer = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', [], undefined)
    check(answer.ok === true, 'clearing the list succeeds', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(answer.ok && Array.isArray(answer.data.blockedBy) && answer.data.blockedBy.length === 0, 'and the answer holds no blockers', answer.ok ? JSON.stringify(answer.data.blockedBy) : '')
    check(ops().filter((n) => n === 'DeckRelationDelete').length === 2, 'both relations are removed', JSON.stringify(ops()))
    check(ops().filter((n) => n === 'DeckRelationCreate').length === 0, 'and nothing is created', JSON.stringify(ops()))
  }

  console.log('R6 a blocker Linear does not have fails before any write')
  {
    const { ctx, ops } = ctxWith({
      DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', []),
      DeckBlockerNeighbours: () => ({ issue: null }),
    })
    const missing = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-404'], undefined)
    check(missing.ok === false && missing.error.kind === ERROR_KIND.NOTFOUND, 'an unknown blocker is a notfound failure', missing.ok ? 'ok' : missing.error.kind)
    check(writes(ops()).length === 0, 'and no relation mutation is sent', JSON.stringify(writes(ops())))
  }

  console.log('R7 a cycle check that cannot finish refuses the write')
  {
    const { ctx, ops } = ctxWith({
      DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', []),
      DeckBlockerNeighbours: () => neighbours('ENG-2', [], true),
    })
    const unproven = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-2'], undefined)
    check(unproven.ok === false && unproven.error.kind === ERROR_KIND.CONFLICT, 'an unfinished cycle check is a conflict, not a silent pass', unproven.ok ? 'ok' : unproven.error.kind)
    check(writes(ops()).length === 0, 'and nothing is written on a guess', JSON.stringify(writes(ops())))
  }

  console.log('R8 a relation list that cannot be read whole is refused')
  {
    const { ctx, ops } = ctxWith({ DeckBlockedByGraph: () => graph('ENG-1', '2026-11-02T10:00:00Z', [], true) })
    const truncated = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', ['ENG-2'], undefined)
    check(truncated.ok === false && truncated.error.kind === ERROR_KIND.UNSUPPORTED, 'a truncated list is unsupported, not a partial replacement', truncated.ok ? 'ok' : truncated.error.kind)
    check(writes(ops()).length === 0, 'and nothing is written', JSON.stringify(writes(ops())))
  }

  console.log('R9 the list is normalised before anything is sent')
  {
    const { ctx, ops } = ctxWith({
      DeckBlockedByGraph: (vars: any, nth: number) => graph('ENG-1', '2026-11-02T10:00:00Z', nth === 1 ? [{ id: 'rel-2', key: 'ENG-2' }] : []),
      DeckBlockerNeighbours: () => neighbours('eng-9', []),
      DeckRelationDelete: () => DELETED,
      DeckRelationCreate: () => CREATED,
    })
    const answer = await setBlockedByOfIssue(ctx, ACCOUNT, 'ENG-1', [' eng-2 ', 'ENG-2', 'eng-9', ''], undefined)
    check(answer.ok === true, 'a list with duplicates, blanks and lower case still succeeds', answer.ok ? 'ok' : JSON.stringify(answer.error))
    const names = ops()
    check(names.filter((n) => n === 'DeckRelationDelete').length === 0, 'the blocker that stayed in any spelling is not removed', JSON.stringify(names))
    check(names.filter((n) => n === 'DeckRelationCreate').length === 1, 'and the new one is written once, not once per spelling', JSON.stringify(names))
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
