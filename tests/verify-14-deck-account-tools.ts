// #14: account reads cross the real registry, session and budget facades without losing identity.
import assert from 'node:assert/strict'
import { createRegistry } from '../src/tracker/registry/core.ts'
import { createGate } from '../src/refresh/rooms/host/refresh-gate.ts'
import { createLedger } from '../src/refresh/rooms/host/quota-ledger.ts'
import { createDeckIssueList } from '../src/deck/tools/issue-list.ts'
import { createDeckIssueGet } from '../src/deck/tools/issue-get.ts'
import { createDeckContext } from '../src/deck/tools/context.ts'
import { chooseWorkspace, makeDecideStub } from './lib/deck-decide-stub.ts'

async function main(): Promise<void> {
  const cwd = '/virtual/deck-account-tools-14'
  const backendId = 'probe-account-tools-14'
  const clock = 1700000000000
  const model = { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false }
  const ref = { backend: backendId, refId: 'fixture', name: 'fixture', url: '' }
  const accounts = [{ alias: 'first', teams: ['ENG'], reviewPattern: 'review', reviewScope: 'assigned' }]
  const errors = [{ account: 'broken', error: { kind: 'auth', message: 'Sign in again', raw: '' } }]
  const calls: { filters: any[]; gets: any[]; deps: number; maps: number } = { filters: [], gets: [], deps: 0, maps: 0 }
  let preflightFailure = ''
  let mapsUnsupported = false
  let listFailure = false
  let configFailure = false
  const configError = { kind: 'env', message: 'Account configuration is unreadable', raw: '' }
  const issue = (account?: string) => ({ key: 'ENG-1', title: 'Fixture ticket', type: 'issue', state: 'open', effortId: '', body: '', labels: [], assignees: [], parentKey: null, updatedAt: '', url: '', ...(account ? { account } : {}) })
  const registry = createRegistry({} as never)
  registry.register({
    id: backendId, label: 'Account tool probe', matches: () => false, budget: model,
    describe: () => ref,
    create: () => ({
      id: backendId,
      preflight: async () => configFailure
        ? { ok: false, error: configError, accountsError: configError }
        : preflightFailure
          ? { ok: false, error: { kind: preflightFailure, message: 'Bound account needs sign-in', raw: '' }, accounts }
          : { ok: true, accounts },
      list: async (_repo: unknown, filter: unknown) => {
        calls.filters.push(filter)
        if (listFailure) return { ok: false, error: { kind: 'env', message: 'Bound account is unavailable', raw: '' } }
        return { ok: true, data: [issue('first'), issue('second')], partial: true, errors }
      },
      get: async (_repo: unknown, key: unknown, opts: any) => {
        calls.gets.push({ key, opts })
        return { ok: true, data: issue(opts.account) }
      },
      getDependencies: async () => { calls.deps += 1; return { ok: true, data: { blockedBy: [], blocking: [] } } },
      listMaps: async () => {
        calls.maps += 1
        return mapsUnsupported ? { ok: false, error: { kind: 'unsupported', message: 'No thin maps', raw: '' } }
          : { ok: true, data: { rows: [], total: 0, truncated: false } }
      },
      getRepoPermissions: async () => ({ ok: true, data: { push: true, triage: true } }),
    }),
  } as never)
  chooseWorkspace(cwd, backendId)
  const ledger = createLedger({ now: () => clock })
  const gate = createGate({ ledger, now: () => clock, budgetModelOf: () => model } as never)
  const deps = {
    registry, gate, now: () => clock, backendCtx: {}, handleFor: () => ({ cwd }),
    decideBackend: makeDecideStub(registry), log: { fire: () => {} },
    getCachedReading: async () => ({ known: false, reason: 'not-measured' }),
    admit: async () => ({ allowed: true, reason: 'test-read' }), accountPort: async () => {},
  }
  const exec = { agent: { session: { id: 'account-tools-14', cwd } } }
  const list = createDeckIssueList(deps)
  const get = createDeckIssueGet(deps)
  const context = createDeckContext(deps)
  const listed: any = await list.run(exec, { account: '*', scope: 'review', state: 'all' })
  assert.equal(listed.status, 'partial', JSON.stringify(listed))
  assert.deepEqual(calls.filters[0], { account: '*', scope: 'review' })
  assert.deepEqual(listed.data.errors, errors)
  assert.equal(listed.data.partial, true)
  assert.deepEqual(listed.data.issues.map((row: any) => [row.account, row.key]), [['first', 'ENG-1'], ['second', 'ENG-1']])
  await list.run(exec, { account: 'first', scope: 'assigned', labels: ['wayfinder:map'], state: 'all' })
  assert.equal(calls.maps, 0, 'Account filters must not disappear through the thin-map shortcut')
  assert.equal(calls.filters[1].account, 'first')
  assert.equal(calls.filters[1].scope, 'assigned')
  const qualified: any = await get.run(exec, { key: 'first:ENG-1' })
  assert.equal(qualified.status, 'ok', JSON.stringify(qualified))
  assert.equal(calls.gets[0].key, 'ENG-1')
  assert.equal(calls.gets[0].opts.account, 'first')
  assert.equal(calls.deps, 0, 'Qualified reads must not query dependencies with bound credentials')
  assert.equal(qualified.data.ticket.account, 'first')
  const ordinary: any = await get.run(exec, { key: 'ENG-1' })
  assert.equal(ordinary.status, 'ok', JSON.stringify(ordinary))
  assert.equal(calls.gets[1].key, 'ENG-1')
  assert.equal(calls.gets[1].opts.account, undefined)
  assert.equal(calls.deps, 1, 'Ordinary reads keep their reverse-dependency query')
  for (const failure of ['', 'auth', 'env']) {
    preflightFailure = failure
    const receipt: any = await context.run(exec, {})
    assert.deepEqual(receipt.data.accounts, accounts, JSON.stringify(receipt))
    assert.equal(receipt.data.accountsStatus, 'configured-not-probed')
    assert.equal(receipt.data.initialized, !failure)
  }
  // Linear has no listMaps implementation: its unsupported stub triggers an ordinary bound read.
  mapsUnsupported = true
  listFailure = true
  preflightFailure = 'env'
  const fallback: any = await context.run(exec, {})
  assert.equal(fallback.status, 'partial', JSON.stringify(fallback))
  assert.deepEqual(fallback.data.accounts, accounts)
  assert.equal(fallback.data.accountsStatus, 'configured-not-probed')
  assert.ok(fallback.reason, 'Failed fallback map reads must carry a nonempty reason')
  assert.equal(calls.filters.at(-1).type, 'map')
  configFailure = true
  listFailure = false
  mapsUnsupported = false
  const unavailable: any = await context.run(exec, {})
  assert.equal(unavailable.status, 'partial', JSON.stringify(unavailable))
  assert.ok(unavailable.reason, 'Account configuration failure must carry a nonempty reason even when maps succeed')
  assert.deepEqual(unavailable.data.accountsError, configError)
  assert.equal(unavailable.data.accounts, undefined, 'Failed configuration must not masquerade as an empty account list')
  console.log('PASS deck account filters, identities, partial errors, qualified reads and context metadata')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
