// 发布分支 dist 只保存 npm pack 解出的包根；默认演练，只有 --push 才改引用、推送并通知插件索引。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const push = process.argv.includes('--push')
const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}): string => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })?.trim() || ''
const tryRun = (cmd: string, args: string[]): string => { try { return run(cmd, args) } catch { return '' } }
function fail(msg: string): never { console.error('[release-dist] ' + msg); process.exit(1) }

console.log('[release-dist] mode: ' + (push ? 'push' : 'dry-run'))
run(process.execPath, ['scripts/build.mts'], { stdio: 'inherit' })
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/package.json'), 'utf8'))
const version = String(manifest.version || '')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('package/package.json has invalid version ' + version)
const tag = 'dist/v' + version
if (push && tryRun('git', ['rev-parse', '-q', '--verify', 'refs/tags/' + tag])) fail('tag already exists: ' + tag)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-dist-'))
const packArgs = ['pack', './package', '--pack-destination', tmp, '--json']
let packed = ''
try { packed = run('npm', packArgs) } catch {
  // 默认 npm 缓存不可写时改用临时缓存；其他失败会在重试时照常报出。
  packed = run('npm', packArgs, { env: { ...process.env, npm_config_cache: path.join(tmp, 'npm-cache') } })
}
const tarball = path.join(tmp, JSON.parse(packed)[0].filename)
run('tar', ['-xzf', tarball, '-C', tmp])
const pkgRoot = path.join(tmp, 'package')
const packedManifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
if (packedManifest.version !== version) fail('packed version differs from package/package.json')
const targets = new Set<string>([packedManifest.main].filter(Boolean))
function collect(v: unknown): void { if (typeof v === 'string') targets.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect) }
collect(packedManifest.exports)
for (const rel of targets) if (!fs.existsSync(path.join(pkgRoot, rel))) fail('manifest target missing from packed root: ' + rel)

const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') }
run('git', ['--work-tree', pkgRoot, 'add', '-A', '.'], { env })
const tree = run('git', ['write-tree'], { env })
const parent = tryRun('git', ['rev-parse', '-q', '--verify', 'refs/heads/dist'])
const source = run('git', ['rev-parse', 'HEAD'])
const commit = run('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Publish built package ' + version + ' from source commit ' + source + ' as the installable dist tree'])
console.log('[release-dist] version=' + version + ' tree=' + tree + ' commit=' + commit + ' parent=' + (parent || '(none)') + ' targets=' + targets.size)
if (!push) { console.log('[release-dist] dry-run: no ref, tag, push, or dispatch was changed'); process.exit(0) }

run('git', ['update-ref', 'refs/heads/dist', commit, parent || ''])
run('git', ['tag', '-a', tag, commit, '-m', 'Built installable release ' + version])
run('git', ['push', 'origin', 'refs/heads/dist:refs/heads/dist', 'refs/tags/' + tag + ':refs/tags/' + tag], { stdio: ['ignore', 'inherit', 'inherit'] })
run('gh', ['api', 'repos/risaddex/dsh-plugins/dispatches', '-f', 'event_type=skills-deck-dist-tag', '-f', 'client_payload[tag]=' + tag], { stdio: ['ignore', 'inherit', 'inherit'] })
console.log('[release-dist] pushed ' + tag + ' and dispatched the plugin index')
