// Account reads must fail before IO in rooms that cannot honour their filters (#14).
import assert from 'node:assert/strict'
import { createGithubBackend } from '../src/tracker/rooms/github/room/backend.ts'
import { createGitlabBackend } from '../src/tracker/rooms/gitlab/index.ts'
import { createMarkdownBackend } from '../src/tracker/rooms/markdown/index.ts'
import { refuseAccountRead } from '../src/tracker/kernel/account-read-refusal.ts'

async function main(): Promise<void> {
  let ioCalls = 0
  const io = async (): Promise<never> => { ioCalls += 1; throw new Error('Unexpected IO') }
  const ctx = { exec: io, fs: { readFile: io, readdir: io, stat: io }, http: { request: io } }
  const repo = { backend: '', refId: 'owner/repo', name: 'repo', url: '', path: '/missing' }
  const rooms = [createGithubBackend(ctx as never), createGitlabBackend(ctx as never), createMarkdownBackend(ctx as never)]
  for (const room of rooms) {
    for (const options of [{ account: 'demo' }, { account: '*' }, { scope: 'assigned' }, { scope: 'review' }]) {
      for (const result of [await room.list(repo as never, options as never, ctx as never), await room.get(repo as never, 'ENG-1', options as never, ctx as never)]) {
        assert.equal(result.ok, false, room.id)
        assert.equal(result.error?.kind, 'unsupported', room.id)
        assert.equal(result.error?.stage, 'input-refused', room.id)
      }
    }
    for (const options of [{ account: '' }, { account: 3 }, { scope: 'unknown' }]) {
      const result = await room.list(repo as never, options as never, ctx as never)
      assert.equal(result.ok, false, room.id)
      assert.equal(result.error?.kind, 'parse', room.id)
      assert.equal(result.error?.stage, 'input-refused', room.id)
    }
  }
  assert.equal(ioCalls, 0, 'Refusing account input must not read the network or disk')
  for (const options of [undefined, {}, { state: 'open' }, { comments: { first: 0 } }]) {
    assert.equal(refuseAccountRead(options), null, 'Ordinary reads keep their previous path')
  }
  console.log('PASS account reads are explicitly refused by non-account rooms without IO')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
