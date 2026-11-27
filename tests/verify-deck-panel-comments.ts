import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createDeckPanelComments, provideDeckPanelComments } from '../src/refresh/rooms/host/deck-panel-comments.js'
import { DECK_READ_LIMITS } from '../src/tracker/contract/deck-read.js'
import { printGateResult } from './lib/gate-result.ts'

const hidden = '/internal/deck/worktree'
const comment = (i: number) => ({ id: 'c' + i, body: 'Comment ' + i, author: { login: 'alice', avatarUrl: hidden }, authorAssociation: 'OWNER', createdAt: '2026-01-01T12:00:00Z', updatedAt: '' })
const all = Array.from({ length: 207 }, (_, i) => comment(i + 1))
let calls = 0

for (const backend of ['github', 'gitlab', 'linear', 'markdown']) {
  const ref = { backend, refId: 'private-repo', effortId: backend === 'markdown' ? '' : 'effort' }
  const wants: number[] = []
  const key = backend === 'linear' ? ' OMB-42 ' : backend === 'markdown' ? '00' : 42
  const service = createDeckPanelComments({
    handleCwd: async ({ sessionId }) => {
      assert.equal(sessionId, 'session')
      return { ok: true, cwd: hidden }
    },
    openSession: async (cwd, opts) => {
      assert.equal(cwd, hidden)
      assert.deepEqual(opts, { write: false })
      const opCtx = { cwd }
      const get = async (actualRef: unknown, actualKey: unknown, options: { comments: { first: number } }, actualCtx: unknown) => {
        if (backend === 'markdown') assert.deepEqual(actualRef, ref)
        else assert.equal(actualRef, ref)
        assert.equal(actualKey, String(key).trim())
        assert.equal(actualCtx, opCtx)
        assert.deepEqual(options, { comments: { first: options.comments.first } })
        const want = options.comments.first
        wants.push(want)
        return { ok: true, data: { comments: all.slice(0, want), url: hidden, effortId: ref.effortId, ...(backend === 'linear' ? { commentsHasMore: true } : { commentCount: all.length }) } }
      }
      return { ok: true, backendId: backend, repoRef: ref, call: (fn: Function) => fn({ get, list: async () => ({ ok: true, data: [{ key, url: hidden, effortId: ref.effortId }] }) }, opCtx) }
    },
  })
  assert.deepEqual(Object.keys(service).sort(), ['available', 'feature', 'list'])
  assert.equal(service.feature, 'deck.panel.comments.v1')
  assert.deepEqual(service.available(), { available: true })
  assert(Object.isFrozen(service))
  let cursor: string | undefined
  for (let i = 0; i < 4; i++) {
    const page = await service.list({ sessionId: ' session ', key, ...(cursor === undefined ? {} : { cursor }) })
    assert(page.ok)
    assert.equal(page.sessionId, 'session')
    assert.equal(page.key, key)
    assert.deepEqual(page.comments, all.slice(i * 50, (i + 1) * 50).map(({ body, author, createdAt }) => ({ body, author: author.login, createdAt })))
    assert(!JSON.stringify(page).includes(hidden))
    if (i === 3) {
      assert.equal(page.truncated, true)
      assert.equal(page.nextCursor, undefined)
    } else {
      assert.equal(page.truncated, undefined)
      assert(page.nextCursor && page.nextCursor.length <= 200)
    }
    cursor = page.nextCursor
  }
  assert.deepEqual(wants, [50, 100, 150, 200])
  calls++
}

const query = { sessionId: 'session', key: '42' }
let repoRef = { backend: 'github', refId: 'project', host: 'host', effortId: 'effort' }
let getCalls = 0
const deps = {
  handleCwd: async ({ sessionId }: { sessionId: string }) => ({ ok: true, cwd: sessionId === 'moved' ? '/other' : hidden }),
  openSession: async () => ({ ok: true, backendId: repoRef.backend, repoRef, call: async () => {
    getCalls++
    return { ok: true, data: { comments: all.slice(0, 50), commentCount: 51 } }
  } }),
}
const service = createDeckPanelComments(deps)
const first = await service.list(query)
assert(first.ok && first.nextCursor)
const cursor = first.nextCursor
const invalid = async (value: unknown, kind: string) => {
  const r = await service.list(value)
  assert(!r.ok)
  assert.equal(r.error.kind, kind)
}
await invalid({ ...query, cursor: cursor.replace(/^50/, '100') }, 'invalid-cursor')
await invalid({ ...query, cursor, key: 42 }, 'invalid-cursor')
await invalid({ ...query, cursor, key: '43' }, 'invalid-cursor')
await invalid({ ...query, cursor, sessionId: 'alternate-session' }, 'invalid-cursor')
await invalid({ ...query, cursor, sessionId: 'moved' }, 'invalid-cursor')
for (const change of [{ refId: 'other' }, { backend: 'linear' }, { effortId: 'other' }, { host: 'other' }]) {
  const originalRef = repoRef
  repoRef = { ...repoRef, ...change }
  await invalid({ ...query, cursor }, 'invalid-cursor')
  repoRef = originalRef
}
for (const bad of [null, [], { ...query, cwd: hidden }, { ...query, cursor: '' }, { ...query, cursor: 'a'.repeat(201) }, { ...query, key: 0 }, { ...query, key: 1.5 }, { ...query, sessionId: 'a'.repeat(513) }]) await invalid(bad, 'bad-request')
assert.equal(getCalls, 1)
assert.deepEqual(await createDeckPanelComments(deps).list({ ...query, cursor }), {
  ok: false, error: { kind: 'invalid-cursor', message: 'This comment page cursor is invalid. Reopen the comments to start again.' },
})
calls++

let markdownGets = 0
const markdown = createDeckPanelComments({
  ...deps,
  openSession: async () => ({ ok: true, backendId: 'markdown', repoRef, call: (fn: Function) => fn({
    list: async () => ({ ok: true, data: [{ key: '42', effortId: 'a' }, { key: '42', effortId: 'b' }] }),
    get: async () => { markdownGets++; assert.fail('Must not read ambiguous local ticket') },
  }, {}) }),
})
const conflict = await markdown.list(query)
assert(!conflict.ok && conflict.error.kind === 'conflict')
assert.equal(markdownGets, 0)
calls++

async function getReply(result: unknown) {
  return createDeckPanelComments({ ...deps, openSession: async () => ({ ...await deps.openSession(), call: async () => result }) }).list(query)
}
const empty = await getReply({ ok: true, data: { comments: [], commentCount: 0 } })
assert.deepEqual(empty, { ok: true, ...query, comments: [] })
const absent = await getReply({ ok: true, data: { title: 'Not a comment' } })
assert(!absent.ok && absent.error.kind === 'comments-unavailable')
const exact = await getReply({ ok: true, data: { comments: all.slice(0, 50), commentCount: 50 } })
assert(exact.ok && !exact.nextCursor && !exact.truncated)
const short = await getReply({ ok: true, data: { comments: [{ body: '' }] }, provenance: { fieldGroups: { comments: 'truncated' } } })
assert.deepEqual(short, { ok: true, ...query, comments: [{ body: '' }], truncated: true })
const oversized = await getReply({ ok: true, data: { comments: [{ body: '📝'.repeat(DECK_READ_LIMITS.maxProjectionBytes / 4) }] } })
assert(!oversized.ok && oversized.error.kind === 'oversized')
const missing = await getReply({ ok: false, error: { kind: 'not-found', message: hidden, raw: hidden } })
assert(!missing.ok && missing.error.kind === 'not-found' && !JSON.stringify(missing).includes(hidden))
const noSession = await createDeckPanelComments({ ...deps, handleCwd: async () => { throw new Error(hidden) }, openSession: async () => { assert.fail('Must not open a fallback workspace') } }).list(query)
assert(!noSession.ok && noSession.error.kind === 'session' && !JSON.stringify(noSession).includes(hidden))
const timeout = await createDeckPanelComments({ ...deps, handleCwd: () => new Promise(() => {}) }, undefined, 5).list(query)
assert(!timeout.ok && timeout.error.kind === 'timeout')
calls++

let registration: [string, unknown] | undefined
assert(provideDeckPanelComments({ provide: (name, value) => { registration = [name, value] } }, deps))
assert.equal(registration?.[0], 'deckPanelComments')
assert.equal((registration?.[1] as typeof service).feature, service.feature)
assert.equal(provideDeckPanelComments({}, deps), false)
const source = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8')
assert.match(source, /import\('[^']*\/deck-panel-comments\.js'\)\.then.*provideDeckPanelComments/)
assert(!source.includes("harness.handle('wf.deckComments"))
calls++

printGateResult('verify-deck-panel-comments', calls, 0)
