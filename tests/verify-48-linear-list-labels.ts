// tests/verify-48-linear-list-labels.ts: the Linear room answers `listLabels` with the team's labels and their colours (#48).
//
// Why this gate exists: the Linear room returned no `listLabels`, so the registry answered its "does not implement op listLabels"
// stub and the panel painted every label badge in the fallback colour (host log: `quota.op` listLabels, backendId linear,
// ok:false, requests:0). The behaviour worth pinning is the part that would fail silently, so this gate runs the REAL room, reached
// the way production reaches it (through the registry), over a FAKE HTTP channel that counts every request:
//   A1  the answer is a real list in the contract shape (labelListAnswerCheck): names as they are, colours as six lower-case hex
//       digits without a hash, an empty string where Linear gave no colour, a description only when there is one;
//   A2  the read walks every page of the connection (the request count and the cursors prove it) and goes only through the HTTP
//       channel of the operation context it was handed, never through the global fetch;
//   A3  "the team's labels" means the labels of the team named by the workspace binding plus the workspace labels; another team's
//       labels are not listed, and a team label wins over a workspace label of the same name (the same order setLabels uses);
//   A4  a list that cannot be read in full fails as a whole: a failing second page, a page without a cursor, a connection that
//       never ends, a reply without the connection, an entry without a name, a GraphQL error in an HTTP 200 reply, a context
//       without a channel. None of them may come back as a short list that looks like a success;
//   A5  a binding without a team is refused before any request is sent, instead of listing the workspace labels only;
//   A6  a workspace that truly has no labels is a success with an empty list after exactly one request;
//   A7  the checker itself catches a list cut after the first page, so A1 cannot pass on a truncated answer.
// 门禁归属: src/tracker/rooms/linear/index.ts
// 门禁归属: src/tracker/rooms/linear/label-list.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-48-linear-list-labels.ts
import { printGateResult } from './lib/gate-result.ts'
import { labelListAnswerCheck } from './tracker-contract/sections/labels.ts'
import { createRegistry } from '../src/tracker/registry/core.ts'
import { linearModule } from '../src/tracker/rooms/linear/index.ts'
import { PAGINATION } from '../src/tracker/contract/pagination.ts'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  assertions += 1
  if (!ok) failed += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail === undefined ? '' : ' — ' + String(detail).slice(0, 400))))
}

const ENDPOINT = 'https://api.linear.app/graphql'
const AUTHORIZATION = 'lin_api_key_for_the_gate'
const CWD = '/ws/ombrello'
const REPO = { backend: 'linear', refId: CWD, name: 'ombrello', url: '' }

/** The binding section the room reads from the workspace; `team` may be left out to model a binding without one. */
function bindingText(team: string | null): string {
  return '# Issue tracker: linear\n\n- alias: demo\n' + (team ? '- team: ' + team + '\n' : '')
}

/** One Linear label node as the connection returns it. */
function node(id: string, name: string, color: string, team: { id: string; key: string } | null, description?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { id, name, color, team }
  if (description !== undefined) out.description = description
  return out
}

type Reply = { status?: number; body?: unknown }

/**
 * The account seam, shared by the creation context and the per-call context the way production injects it.
 * After #88 the room reads the seam from the per-call context, so a fixture that seeds only the creation
 * context models a shape production no longer produces (and the room rightly reports it as an env gap).
 */
const ACCOUNT_SEAM = { resolve: async (alias: string) => ({ ok: true, alias, endpoint: ENDPOINT, authorization: AUTHORIZATION }) }

/**
 * An operation context whose channel answers from a script and remembers every call.
 * `replies` is read in order; when it runs out the last one repeats, which models a connection that never ends.
 */
function scripted(replies: Reply[], options: { team?: string | null; withChannel?: boolean } = {}): { opCtx: any; calls: any[] } {
  const calls: any[] = []
  const team = options.team === undefined ? 'ENG' : options.team
  const http = {
    async request(req: any) {
      calls.push(req)
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)] || {}
      return { status: reply.status === undefined ? 200 : reply.status, headers: {}, body: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body === undefined ? {} : reply.body) }
    },
  }
  const opCtx: any = {
    cwd: CWD,
    fs: { resolve: async (rel: string) => '/ws/ombrello/' + rel, readText: async () => bindingText(team) },
    logEvent: () => {},
    isEnabled: () => false,
    accounts: ACCOUNT_SEAM,
  }
  if (options.withChannel !== false) opCtx.http = http
  return { opCtx, calls }
}

/** A connection reply: `labels` is the page, `next` the cursor of the following page (null when this is the last page). */
function page(labels: Record<string, unknown>[], next: string | null, hasNext: boolean = next !== null): Reply {
  return { body: { data: { issueLabels: { nodes: labels, pageInfo: { hasNextPage: hasNext, endCursor: next } } } } }
}

/** The room as production reaches it: registered in the registry, whose account seam hands out the credential. */
function roomForGate(): any {
  const registry = createRegistry({
    accounts: ACCOUNT_SEAM,
    logEvent: () => {},
    isEnabled: () => false,
  } as any, { matchesTimeout: 200 })
  registry.register(linearModule as any)
  return registry.get('linear')
}

const ENG = { id: 'team-eng', key: 'ENG' }
const OPS = { id: 'team-ops', key: 'OPS' }

async function main(): Promise<void> {
  const room = roomForGate()
  const realFetch = (globalThis as any).fetch
  let globalFetchCalls = 0
  ;(globalThis as any).fetch = () => { globalFetchCalls += 1; throw new Error('the room must not use the global fetch') }
  try {
    console.log('A1 / A2 / A3 a two-page workspace comes back as the contract list, read through the context channel')
    {
      const pageOne = page([
        node('l1', 'bug', '#EB5757', null),
        node('l2', 'docs', '#4EA7FC', null, 'Documentation work'),
        node('l3', 'ops-only', '#111111', OPS),
        node('l4', 'no-colour', '', null),
      ], 'cursor-1')
      const pageTwo = page([
        node('l5', 'bug', '#9D7CD8', ENG),
        node('l6', 'wayfinder:grilling', '#9D7CD8', ENG, '   '),
        node('l7', 'odd colour', 'not-a-colour', ENG),
      ], null)
      const { opCtx, calls } = scripted([pageOne, pageTwo])
      const res: any = await room.listLabels(REPO, opCtx)
      const expected = ['bug', 'docs', 'no-colour', 'wayfinder:grilling', 'odd colour']
      check(res && res.ok === true, 'listLabels succeeds (not the "does not implement op listLabels" stub)', JSON.stringify(res))
      const problems = labelListAnswerCheck(res, expected)
      check(problems.length === 0, 'the list has the contract shape and carries every expected name', problems.join('; '))
      const data: any[] = res && res.ok === true ? res.data : []
      const byName = (name: string): any => data.find((item) => item.name === name)
      check(data.length === expected.length, 'no label of another team is listed and no name is listed twice (' + expected.length + ' entries)', JSON.stringify(data.map((item) => item.name)))
      check(data.length > 0 && !byName('ops-only'), 'a label that belongs to another team is not listed', JSON.stringify(data.map((item) => item.name)))
      check(byName('bug') && byName('bug').color === '9d7cd8', 'a team label wins over the workspace label of the same name, colour without the hash and in lower case', JSON.stringify(byName('bug')))
      check(byName('docs') && byName('docs').color === '4ea7fc' && byName('docs').description === 'Documentation work', 'a workspace label is listed with its colour and its description', JSON.stringify(byName('docs')))
      check(byName('no-colour') && byName('no-colour').color === '', 'a label Linear gave no colour is listed with an empty colour, not dropped', JSON.stringify(byName('no-colour')))
      check(byName('odd colour') && byName('odd colour').color === '', 'a colour that is not six hex digits becomes an empty colour, not a guessed one', JSON.stringify(byName('odd colour')))
      check(byName('wayfinder:grilling') && !('description' in byName('wayfinder:grilling')), 'a blank description leaves the description key out', JSON.stringify(byName('wayfinder:grilling')))
      check(calls.length === 2, 'exactly two requests went out for a two-page connection', String(calls.length))
      const variables = calls.map((call) => { try { return JSON.parse(call.body).variables || {} } catch { return {} } })
      check(variables[0] && !variables[0].after && variables[1] && variables[1].after === 'cursor-1', 'the second request carries the cursor the first page returned', JSON.stringify(variables))
      check(calls.length > 0 && calls.every((call) => call.method === 'POST' && call.url === ENDPOINT && call.headers && call.headers.Authorization === AUTHORIZATION), 'every request is a POST to the account endpoint with the account authorization', JSON.stringify(calls.map((call) => [call.method, call.url])))
      check(calls.length > 0 && calls.every((call) => call.bucket === 'read'), 'every request is accounted as a read', JSON.stringify(calls.map((call) => call.bucket)))
      check(calls.length > 0 && calls.every((call) => /issueLabels/.test(String(JSON.parse(call.body).query))), 'every request is the label connection query', calls[0] ? String(JSON.parse(calls[0].body).query).slice(0, 80) : '(none)')
      check(globalFetchCalls === 0, 'the global fetch was never used', String(globalFetchCalls))
    }

    console.log('A4 a list that cannot be read in full fails as a whole')
    {
      const wholeFailure = (res: any, kinds: string[]): boolean => !!res && res.ok === false && res.data === undefined && !!res.error && kinds.includes(res.error.kind)
      {
        const { opCtx, calls } = scripted([page([node('l1', 'bug', '#EB5757', null)], 'cursor-1'), { status: 500, body: 'upstream broke' }])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['network']) && calls.length === 2, 'a failing second page fails the whole read and does not hand out page one', JSON.stringify(res) + ' requests=' + calls.length)
      }
      {
        const { opCtx, calls } = scripted([page([node('l1', 'bug', '#EB5757', null)], null, true)])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']) && calls.length === 1, 'a page that says there is more but gives no cursor fails the whole read', JSON.stringify(res) + ' requests=' + calls.length)
      }
      {
        const { opCtx, calls } = scripted([page([node('l1', 'bug', '#EB5757', null)], 'cursor-again')])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']) && calls.length > 0, 'a connection that never ends fails the whole read instead of returning what was read', JSON.stringify(res).slice(0, 300))
        check(calls.length === PAGINATION.linear.countMaxPages, 'the walk stops at the page cap of the shared table (' + PAGINATION.linear.countMaxPages + ' requests)', String(calls.length))
      }
      {
        const { opCtx } = scripted([{ body: { data: {} } }])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']), 'a reply without the label connection is a failure, not an empty list', JSON.stringify(res))
      }
      {
        const { opCtx } = scripted([{ body: { data: { issueLabels: { nodes: 'nope', pageInfo: { hasNextPage: false, endCursor: null } } } } }])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']), 'a reply whose nodes are not a list is a failure', JSON.stringify(res))
      }
      {
        const { opCtx } = scripted([page([node('l1', 'bug', '#EB5757', null), { id: 'l2', color: '#4EA7FC', team: null }], null)])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']), 'an entry without a name fails the whole read instead of being skipped', JSON.stringify(res))
      }
      {
        const { opCtx } = scripted([{ body: { errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }] } }])
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['auth']), 'a GraphQL error inside an HTTP 200 reply lands in the contract kind, not in an empty list', JSON.stringify(res))
      }
      {
        const { opCtx, calls } = scripted([], { withChannel: false })
        const res: any = await room.listLabels(REPO, opCtx)
        check(wholeFailure(res, ['env']) && calls.length === 0, 'a context without an HTTP channel fails loudly as an environment problem', JSON.stringify(res))
      }
    }

    console.log('A5 a binding without a team is refused before any request')
    {
      const { opCtx, calls } = scripted([page([node('l1', 'bug', '#EB5757', null)], null)], { team: null })
      const res: any = await room.listLabels(REPO, opCtx)
      check(res && res.ok === false && res.error && res.error.kind === 'env' && calls.length === 0, 'no team in the binding: an environment failure and no request sent', JSON.stringify(res) + ' requests=' + calls.length)
    }

    console.log('A6 a workspace with no labels is a success after one request')
    {
      const { opCtx, calls } = scripted([page([], null)])
      const res: any = await room.listLabels(REPO, opCtx)
      check(res && res.ok === true && Array.isArray(res.data) && res.data.length === 0 && calls.length === 1, 'an empty connection is an empty list after exactly one request', JSON.stringify(res) + ' requests=' + calls.length)
    }

    console.log('A7 the checker catches a list cut after the first page')
    {
      const fullNames = ['bug', 'docs', 'wayfinder:grilling']
      const cut = { ok: true, data: [{ name: 'bug', color: 'eb5757' }] }
      check(labelListAnswerCheck(cut, fullNames).length > 0, 'a truncated list does not pass labelListAnswerCheck', JSON.stringify(labelListAnswerCheck(cut, fullNames)))
      const stub = { ok: false, error: { kind: 'unsupported', message: 'backend linear does not implement op listLabels', raw: '' } }
      check(labelListAnswerCheck(stub, fullNames).length > 0, 'the "not implemented" answer does not pass labelListAnswerCheck', JSON.stringify(labelListAnswerCheck(stub, fullNames)))
    }
  } finally {
    ;(globalThis as any).fetch = realFetch
  }
}

await main()
printGateResult('verify-48-linear-list-labels', assertions, failed)
if (failed) process.exit(1)
