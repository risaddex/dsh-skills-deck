// tests/verify-13-linear-room.ts — the Linear room's first slice: transport, reads and the probe (#13)
//
// Why this gate exists: the room is the first one whose backend has no CLI, so everything it does
// goes through the injected HTTP channel. The behaviour worth pinning is the part that would fail
// silently:
//   L1  a call goes out exactly as the contract says: POST to the account endpoint, the
//       Authorization header untouched (the account layer built it), JSON body, and the bucket and
//       service the channel needs to account for the request.
//   L2  the failures Linear actually produces land in the right one of the eight contract kinds:
//       HTTP status, HTTP 200 with errors[], a 429 carrying RATELIMITED, a body that is not JSON,
//       and a context with no channel at all (which must fail loudly, not be skipped).
//   L3  a node normalises into the full contract shape: state from the workflow state type, the map
//       type from the wayfinder:map label, the parent, the labels with their colour, the assignee.
//   L4  list builds the Linear filter the contract's state asks for, and says so when the page is
//       not the whole answer.
//   L5  preflight answers the environment question only, and does not claim success when the probe
//       came back as an error.
//   L6  the room never touches the global fetch — that is the whole point of the channel.
//   L7  every request leaves one debug-only boundary line, carrying no replayable credential.
//   L8  the closed-state list is defined in one place, so the query filter and the reading of a
//       state can never disagree about which workflow states mean closed.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-13-linear-room.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { gql, type LinearAccount } from '../src/tracker/rooms/linear/client.ts'
import { issueOf } from '../src/tracker/rooms/linear/normalize.ts'
import { buildIssuesFilter, getIssue, listIssues } from '../src/tracker/rooms/linear/read.ts'
import { preflightLinear } from '../src/tracker/rooms/linear/preflight.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }

/** A context whose channel answers with one prepared response, remembering how it was called. */
function ctxAnswering(status: number, body: string): { ctx: OpContext; calls: any[] } {
  const calls: any[] = []
  const ctx = {
    http: {
      request: async (req: any) => {
        calls.push(req)
        return { status, headers: {}, body }
      },
    },
  } as unknown as OpContext
  return { ctx, calls }
}

const ISSUE_NODE = {
  id: 'uuid-1',
  identifier: 'ENG-123',
  title: 'A ticket',
  description: 'body text',
  url: 'https://linear.app/ombrello/issue/ENG-123',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-02T10:00:00Z',
  state: { name: 'Done', type: 'completed' },
  team: { key: 'ENG', name: 'Engineering' },
  parent: { identifier: 'ENG-100' },
  assignee: { name: 'danilo', displayName: 'Danilo' },
  labels: { nodes: [{ name: 'wayfinder:map', color: '#4EA7FC' }, { name: 'bug', color: '#EB5757' }] },
}

async function main(): Promise<void> {
  console.log('L1 one call goes out as the contract says')
  {
    const { ctx, calls } = ctxAnswering(200, JSON.stringify({ data: { viewer: { name: 'danilo' } } }))
    await gql(ctx, ACCOUNT, { query: 'query { viewer { name } }', variables: { a: 1 }, bucket: 'read' })
    const call = calls[0]
    check(calls.length === 1, 'exactly one request went out', String(calls.length))
    check(call && call.method === 'POST', 'it is a POST', call ? call.method : '(none)')
    check(call && call.url === ACCOUNT.endpoint, 'the url is the account endpoint', call ? call.url : '(none)')
    check(call && call.headers && call.headers.Authorization === 'lin_api_key', 'the Authorization value is passed through untouched')
    check(call && call.headers && call.headers['Content-Type'] === 'application/json', 'the body is declared as JSON')
    check(call && JSON.parse(call.body).variables.a === 1, 'the variables travel in the body', call ? call.body : '(none)')
    check(call && call.bucket === 'read', 'the bucket is the one the caller asked for', call ? call.bucket : '(none)')
    check(call && call.service === 'linear', "the service is 'linear' so its cooldown is tracked apart", call ? call.service : '(none)')
  }

  console.log('L2 the failures land in the right contract kind')
  {
    const cases: { name: string; status: number; body: string; kind: string }[] = [
      { name: 'HTTP 401', status: 401, body: '', kind: 'auth' },
      { name: 'HTTP 403', status: 403, body: '', kind: 'auth' },
      { name: 'HTTP 404', status: 404, body: '', kind: 'not-found' },
      { name: 'HTTP 429', status: 429, body: '', kind: 'rate-limit' },
      { name: 'HTTP 500', status: 500, body: '', kind: 'network' },
      { name: 'HTTP 200 with RATELIMITED', status: 200, body: JSON.stringify({ errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] }), kind: 'rate-limit' },
      { name: 'HTTP 200 with an auth error', status: 200, body: JSON.stringify({ errors: [{ message: 'nope', extensions: { type: 'authentication error' } }] }), kind: 'auth' },
      { name: 'HTTP 200 with invalid input', status: 200, body: JSON.stringify({ errors: [{ message: 'bad', extensions: { type: 'invalid input' } }] }), kind: 'conflict' },
      // PR #26 review (P2): 'feature not accessible' also contains 'not accessible', so the order of the
      // two conditions decides whether callers are told "log in again" or "this operation is unavailable".
      { name: 'HTTP 200 with feature not accessible', status: 200, body: JSON.stringify({ errors: [{ message: 'gone', extensions: { type: 'feature not accessible' } }] }), kind: 'unsupported' },
      { name: 'HTTP 200 with a plain not-accessible error', status: 200, body: JSON.stringify({ errors: [{ message: 'nope', extensions: { type: 'not accessible' } }] }), kind: 'auth' },
    ]
    for (const item of cases) {
      const { ctx } = ctxAnswering(item.status, item.body)
      const result = await gql(ctx, ACCOUNT, { query: 'query { viewer { name } }' })
      check(!result.ok && result.error.kind === item.kind, item.name + ' is classified as ' + item.kind, !result.ok ? result.error.kind : 'ok')
    }
    const notJson = ctxAnswering(200, 'not json at all')
    const parsed = await gql(notJson.ctx, ACCOUNT, { query: 'query { viewer { name } }' })
    check(!parsed.ok && parsed.error.kind === 'parse', 'a body that is not JSON is a parse failure', !parsed.ok ? parsed.error.kind : 'ok')

    // `JSON.parse('null')` 成功，但读 payload.errors 会在 try 之外抛错，垃圾回包就绕过了契约；
    // 所以非对象的 JSON 必须当场按解析失败交回去。
    for (const body of ['null', '[]', '"a string"', '42']) {
      const odd = ctxAnswering(200, body)
      const answer = await gql(odd.ctx, ACCOUNT, { query: 'query { viewer { name } }' })
      check(!answer.ok && answer.error.kind === 'parse', 'a JSON body that is not an object is a parse failure (' + body + ')', answer.ok ? 'ok' : answer.error.kind)
    }

    const noChannel = {} as unknown as OpContext
    const missing = await gql(noChannel, ACCOUNT, { query: 'query { viewer { name } }' })
    check(!missing.ok && missing.error.kind === 'env', 'a context with no channel fails loudly as an environment gap', !missing.ok ? missing.error.kind : 'ok')
  }

  console.log('L3 a node becomes the full contract shape')
  {
    const issue = issueOf(ISSUE_NODE as any)
    check(issue.key === 'ENG-123', 'the key is the identifier', issue.key)
    check(issue.state === 'closed', 'a completed workflow state reads as closed', issue.state)
    check(issue.type === 'map', 'the wayfinder:map label makes it a map', issue.type)
    check(issue.parentKey === 'ENG-100', 'the parent identifier becomes the parent key', String(issue.parentKey))
    check(issue.effortId === '', 'a single-work-unit backend writes an empty effort', issue.effortId)
    check(issue.labels && issue.labels.length === 2, 'both labels survive', JSON.stringify(issue.labels))
    // 契约要的是「不带井号的小写六位」，Linear 给的是 `#4EA7FC`，所以颜色必须被收过；
    // 原样透传会让视图拼成 `##4EA7FC`（视图自己会补井号），颜色整条失效。
    check(issue.labels && issue.labels[0].color === '4ea7fc', 'a label colour is lowered and lose its hash', JSON.stringify(issue.labels && issue.labels[0]))
    const oddColours = issueOf({ ...ISSUE_NODE, labels: { nodes: [{ name: 'a', color: '#8b5cf' }, { name: 'b', color: 'not-a-colour' }, { name: 'c', color: '#8B5CF6' }] } } as any)
    check(oddColours.labels && oddColours.labels[0].color === '' && oddColours.labels[1].color === '', 'an unusable colour becomes an empty string, not a guess', JSON.stringify(oddColours.labels))
    check(oddColours.labels && oddColours.labels[2].color === '8b5cf6', 'an uppercase colour with a hash still normalises', JSON.stringify(oddColours.labels && oddColours.labels[2]))
    check(issue.assignees && issue.assignees[0].login === 'danilo' && issue.assignees[0].name === 'Danilo', 'the assignee carries login and name', JSON.stringify(issue.assignees))
    const openIssue = issueOf({ ...ISSUE_NODE, state: { name: 'Todo', type: 'unstarted' }, parent: null, assignee: null } as any)
    check(openIssue.state === 'open', 'an unstarted workflow state reads as open', openIssue.state)
    check(openIssue.parentKey === null, 'a top-level ticket has a null parent', String(openIssue.parentKey))
    // 三态：null（问了、明确没人）→ 空数组；字段没问 → 省略。省略会把库里旧的负责人留下。
    check(openIssue.assignees !== undefined && openIssue.assignees.length === 0, 'an explicit null assignee becomes an empty array, not an absent field', JSON.stringify(openIssue.assignees))
    const unfetched = { ...ISSUE_NODE }
    delete (unfetched as any).assignee
    check(issueOf(unfetched as any).assignees === undefined, 'an assignee that was never asked for stays absent')
  }

  console.log('L4 list asks for the right filter and admits a short page')
  {
    check(JSON.stringify(buildIssuesFilter({ state: 'open' })) === JSON.stringify({ state: { type: { nin: ['completed', 'canceled', 'duplicate'] } } }), 'open asks Linear to exclude the closing state types', JSON.stringify(buildIssuesFilter({ state: 'open' })))
    check(JSON.stringify(buildIssuesFilter({ state: 'closed' })) === JSON.stringify({ state: { type: { in: ['completed', 'canceled', 'duplicate'] } } }), 'closed asks for exactly those types', JSON.stringify(buildIssuesFilter({ state: 'closed' })))
    check(buildIssuesFilter(undefined) === undefined, 'no filter means no condition, not an empty one')

    const full = ctxAnswering(200, JSON.stringify({ data: { issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: false } } } }))
    const one = await listIssues(full.ctx, ACCOUNT, { state: 'open' })
    check(one.ok && one.data.length === 1 && one.data[0].key === 'ENG-123', 'a page comes back as issues', one.ok ? JSON.stringify(one.data.map((i) => i.key)) : JSON.stringify(one.error))
    check(one.ok && one.truncated !== true, 'a complete page is not marked truncated')

    const more = ctxAnswering(200, JSON.stringify({ data: { issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: true } } } }))
    const partial = await listIssues(more.ctx, ACCOUNT, undefined)
    check(partial.ok && partial.truncated === true, 'hasNextPage marks the answer as a short page', partial.ok ? String(partial.truncated) : 'error')

    // 翻得动的一格：增量窗口要真的落到查询里，否则刷新后台每拍全量翻。
    const windowed = ctxAnswering(200, JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }))
    await listIssues(windowed.ctx, ACCOUNT, { since: '2026-11-01T00:00:00Z' })
    const sent = windowed.calls[0] ? JSON.parse(windowed.calls[0].body).variables.filter : null
    check(JSON.stringify(sent) === JSON.stringify({ updatedAt: { gte: '2026-11-01T00:00:00Z' } }), 'the incremental window reaches the query', JSON.stringify(sent))

    // 翻不动的格子必须整体报 unsupported，而且一个请求都不发：交回没筛过的名单比失败更贵。
    const unhonoured: [string, any][] = [
      ['type', { type: 'map' }],
      ['labels', { labels: ['bug'] }],
      ['parentKey', { parentKey: 'ENG-100' }],
      ['parentKey', { parentKey: null }],
      ['keys', { keys: ['ENG-1'] }],
      ['isPullRequest', { isPullRequest: true }],
    ]
    for (const [name, filter] of unhonoured) {
      const refused = ctxAnswering(200, JSON.stringify({ data: { issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: false } } } }))
      const answer = await listIssues(refused.ctx, ACCOUNT, filter as any)
      check(!answer.ok && answer.error.kind === 'unsupported', 'a filter it cannot honour fails as unsupported (' + name + ')', answer.ok ? 'ok' : answer.error.kind)
      check(refused.calls.length === 0, 'no request goes out for it (' + name + ')', String(refused.calls.length))
    }

    // 空数组、省略、isPullRequest:false 都不是「要求了做不到的条件」，照常发。
    const fine = ctxAnswering(200, JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }))
    const fineAnswer = await listIssues(fine.ctx, ACCOUNT, { labels: [], isPullRequest: false })
    check(fineAnswer.ok === true && fine.calls.length === 1, 'an empty label list and a false pull-request filter cost nothing', fineAnswer.ok ? String(fine.calls.length) : JSON.stringify(fineAnswer.error))
  }

  console.log('L5 get and preflight answer only what they can')
  {
    const found = ctxAnswering(200, JSON.stringify({ data: { issue: ISSUE_NODE } }))
    const got = await getIssue(found.ctx, ACCOUNT, 'ENG-123')
    check(got.ok && got.data.title === 'A ticket', 'get returns the normalised ticket', got.ok ? got.data.title : JSON.stringify(got.error))
    check(found.calls[0] && JSON.parse(found.calls[0].body).variables.id === 'ENG-123', 'get passes the key as Linear expects', found.calls[0] ? found.calls[0].body : '')

    const missing = ctxAnswering(200, JSON.stringify({ data: { issue: null } }))
    const notFound = await getIssue(missing.ctx, ACCOUNT, 'ENG-999')
    check(!notFound.ok && notFound.error.kind === 'not-found', 'a null issue is a not-found, not an empty ticket', !notFound.ok ? notFound.error.kind : 'ok')

    const okProbe = ctxAnswering(200, JSON.stringify({ data: { viewer: { name: 'danilo', organization: { name: 'Ombrello', urlKey: 'ombrello' } } } }))
    const pre = await preflightLinear(okProbe.ctx, ACCOUNT)
    check(pre.ok === true, 'a reachable identity probe passes preflight')
    check(okProbe.calls[0] && okProbe.calls[0].bucket === 'probe', 'the probe uses the probe bucket', okProbe.calls[0] ? okProbe.calls[0].bucket : '')

    const badProbe = ctxAnswering(401, '')
    const pre2 = await preflightLinear(badProbe.ctx, ACCOUNT)
    check(pre2.ok === false && pre2.error && pre2.error.kind === 'auth', 'a rejected credential fails preflight as auth', pre2.ok ? 'ok' : JSON.stringify(pre2.error))
  }

  console.log('L7 every request leaves one boundary line, without what would replay it')
  {
    const records: { level: string; event: string; fields: Record<string, unknown> }[] = []
    const ctx = {
      http: { request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { viewer: { name: 'x' } } }) }) },
      logEvent: (level: string, event: string, fields: Record<string, unknown>) => records.push({ level, event, fields: fields || {} }),
      isEnabled: () => true,
    } as unknown as OpContext
    await gql(ctx, { ...ACCOUNT, authorization: 'SECRET-TOKEN' }, { query: 'query LinearViewer { viewer { name } }', bucket: 'read' })
    const line = records.find((r) => r.event === 'linear.request')
    check(!!line, 'a successful request writes a linear.request line', JSON.stringify(records.map((r) => r.event)))
    const flat = JSON.stringify(line ? line.fields : {})
    check(/"op":"LinearViewer"/.test(flat), 'the line names the operation', flat)
    check(/"outcome":"ok"/.test(flat) && /"bucket":"read"/.test(flat), 'the line carries the outcome and the bucket', flat)
    check(/"ms":\d+/.test(flat) && /"alias":"demo"/.test(flat), 'the line carries the duration and the account alias', flat)
    check(!/SECRET-TOKEN/.test(flat), 'the line carries no credential', flat)

    const failing: Record<string, unknown>[] = []
    const ctx2 = {
      http: { request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: 'slow', extensions: { code: 'RATELIMITED' } }] }) }) },
      logEvent: (_l: string, _e: string, fields: Record<string, unknown>) => failing.push(fields || {}),
      isEnabled: () => true,
    } as unknown as OpContext
    await gql(ctx2, ACCOUNT, { query: 'query LinearIssues { issues { nodes { id } } }' })
    check(/"outcome":"rate-limit"/.test(JSON.stringify(failing[0] || {})), 'a failure records its classified outcome, not just "failed"', JSON.stringify(failing[0]))

    const quiet: Record<string, unknown>[] = []
    const ctx3 = {
      http: { request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: {} }) }) },
      logEvent: (_l: string, _e: string, fields: Record<string, unknown>) => quiet.push(fields || {}),
      isEnabled: () => false,
    } as unknown as OpContext
    await gql(ctx3, ACCOUNT, { query: 'query LinearViewer { viewer { name } }' })
    check(quiet.length === 0, 'with the debug switch off nothing is written at all')
  }

  console.log('L6 the room never reaches for the global fetch')
  {
    const roomDir = new URL('../src/tracker/rooms/linear/', import.meta.url)
    const files = readdirSync(roomDir).filter((name) => name.endsWith('.ts'))
    check(files.length > 0, 'the room has files to scan', String(files.length))
    let offenders: string[] = []
    for (const name of files) {
      const text = readFileSync(join(roomDir.pathname, name), 'utf8')
      if (/(^|[^.\w])fetch\s*\(/.test(text) || /globalThis\s*\.\s*fetch/.test(text)) offenders.push(name)
    }
    check(offenders.length === 0, 'no room file calls the global fetch', offenders.join(', '))
  }

  console.log('L8 the closed-state list has exactly one definition')
  {
    const normalizeText = readFileSync(new URL('../src/tracker/rooms/linear/normalize.ts', import.meta.url), 'utf8')
    const readText = readFileSync(new URL('../src/tracker/rooms/linear/read.ts', import.meta.url), 'utf8')
    check(/export const CLOSED_STATE_TYPES/.test(normalizeText), 'normalize.ts exports the one closed-state list')
    check(!/const CLOSED_STATE_TYPES/.test(readText), 'read.ts keeps no second copy of it')
    check(/import \{[^}]*CLOSED_STATE_TYPES[^}]*\} from '\.\/normalize\.js'/.test(readText), 'read.ts imports it from normalize.ts instead')
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('gate crashed:', e); process.exit(2) })
