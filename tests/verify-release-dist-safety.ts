// 门禁归属: scripts/release-dist.mts scripts/lib/release-dist-safety.mts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requireCleanSource, requireVerifiedSource, notifyPublishedTag, pushAndNotify } from '../scripts/lib/release-dist-safety.mts'
import { printGateResult } from './lib/gate-result.ts'
let total = 0
function check(name: string, fn: () => void): void { fn(); total++; console.log('PASS ' + name) }
const tag = 'dist/v1.2.3'
const calls: string[] = []
let dirty = '', head = 'source', remote = 'object refs/tags/dist/v1.2.3\ncommit refs/tags/dist/v1.2.3^{}'
let failPush = false, failNotify = false
const run = (cmd: string, args: string[]): string => {
  calls.push([cmd, ...args].join(' '))
  if (args[0] === 'status') return dirty
  if (args[0] === 'cat-file') return 'tag'
  if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? head : args[1].endsWith('^{}') ? 'commit' : 'object'
  if (args[0] === 'ls-remote') return remote
  if (args[0] === 'push' && failPush) throw new Error('push failed')
  if (cmd === 'gh' && failNotify) throw new Error('dispatch failed')
  return ''
}
check('clean source captures HEAD', () => assert.equal(requireCleanSource(run), 'source'))
check('tracked edits are rejected before building', () => { dirty = ' M file'; assert.throws(() => requireCleanSource(run), /clean/); dirty = '' })
check('tracked edits after building are rejected', () => { dirty = 'M  file'; assert.throws(() => requireCleanSource(run, 'source'), /clean/); dirty = '' })
check('HEAD movement after building is rejected', () => { head = 'other'; assert.throws(() => requireCleanSource(run, 'source'), /HEAD changed/); head = 'source' })
check('atomic push precedes dispatch', () => { calls.length = 0; pushAndNotify(run, tag); assert.ok(calls[0].startsWith('git push --atomic origin ')); assert.ok(calls.at(-1)?.startsWith('gh api ')) })
check('failed push never dispatches', () => { calls.length = 0; failPush = true; assert.throws(() => pushAndNotify(run, tag)); assert.ok(!calls.some(x => x.startsWith('gh '))); failPush = false })
check('remote SHA mismatch never dispatches', () => { calls.length = 0; remote = 'wrong refs/tags/dist/v1.2.3'; assert.throws(() => notifyPublishedTag(run, tag), /SHA/); assert.ok(!calls.some(x => x.startsWith('gh '))); remote = 'object refs/tags/dist/v1.2.3\ncommit refs/tags/dist/v1.2.3^{}' })
check('notification failure can retry without rebuilding or pushing', () => { failNotify = true; assert.throws(() => notifyPublishedTag(run, tag)); failNotify = false; calls.length = 0; notifyPublishedTag(run, tag); assert.ok(!calls.some(x => x.includes('push') || x.includes('build'))); assert.ok(calls.at(-1)?.startsWith('gh ')) })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-safety-'))
const reportFile = path.join(tmp, 'verify.json')
const report = {head:'source', tier:'full', red:0, stepsRan:2, stepsTotal:2, smoke:{ran:true, red:0, stepsRan:1, stepsTotal:1}}
try {
  check('complete green report binds exact source', () => { fs.writeFileSync(reportFile, JSON.stringify(report)); requireVerifiedSource(reportFile, 'source'); assert.throws(() => requireVerifiedSource(reportFile, 'other')) })
  check('known reds never authorize a future release', () => { fs.writeFileSync(reportFile, JSON.stringify({...report, red:24, knownRed:24, newRed:0})); assert.throws(() => requireVerifiedSource(reportFile, 'source')) })
  check('partial or skipped verification is rejected', () => { fs.writeFileSync(reportFile, JSON.stringify({...report, stepsRan:1})); assert.throws(() => requireVerifiedSource(reportFile, 'source')); fs.writeFileSync(reportFile, JSON.stringify({...report, smoke:{...report.smoke, ran:false}})); assert.throws(() => requireVerifiedSource(reportFile, 'source')) })
  check('entry point checks before build, after pack and exposes notify-only', () => { const code = fs.readFileSync('scripts/release-dist.mts','utf8'); assert.ok(code.indexOf('const source = requireCleanSource(run)') < code.indexOf("['scripts/build.mts', '--force']")); assert.ok(code.lastIndexOf('requireCleanSource(run, source)') > code.indexOf("run('git', ['write-tree']")); assert.ok(code.includes("args[0] === '--notify-only'")) })
} finally { fs.rmSync(tmp, {recursive:true, force:true}) }
printGateResult('verify-release-dist-safety', total, 0)
