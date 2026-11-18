// 发布分支 dist 只保存 npm pack 解出的包根；默认演练，只有 --push 才改引用、推送并通知插件索引。
//
// 为什么 --push 之前必须先过发布前检查：dist 标签是单向的（同一版本不能重打），而「本版真机验证清单
// 恰好一张且已关闭、批次身份行与候选包对得上、票面记录内部一致」只有发布前检查会回答。这条路以前
// 一次都不调用它：2026-11-18 的 dist/v2.0.0 就是在清单票还是开着的时候推出去的，事后再跑检查才看见。
// 现在只有退出码 0 才往下走；1（票面或候选要人改）与 2（环境或适配器缺失，无法判定）都在建引用、
// 打标签、发 dispatch 之前停手，并把门禁自己的结论行（每条 finding 都带「改法」）照原样打给人看。
// --dry-run 与两条既有发布路径（publish-token.ps1 -DryRun、wizard-release.sh --dry-run）同口径：
// 非 0 只提示不阻断——演练要摆出结论，不是替人拍板。
import { requireCleanSource, requireVerifiedSource, notifyPublishedTag, pushAndNotify, requireReleaseGate, ReleaseGateRefusedError } from './lib/release-dist-safety.mts'
import { runPreflightGate } from './lib/release-preflight-gate.mts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const USAGE = 'Usage: release-dist.mts [--push | --dry-run] [--candidate <candidate.json>] | release-dist.mts --notify-only dist/v<version>'
const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}): string => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })?.trim() || ''
const tryRun = (cmd: string, args: string[]): string => { try { return run(cmd, args) } catch { return '' } }
function fail(msg: string, code = 1): never { console.error('[release-dist] ' + msg); process.exit(code) }

interface Options {
  /** 建引用、打标签、推送并发 dispatch；缺省是演练。 */
  readonly push: boolean
  /** 候选清单路径，原样交给发布前检查做字节级对账；空串表示没给，门禁会自己说明只查了票面。 */
  readonly candidatePath: string
}

/** 只认 --push、--dry-run 与 --candidate <路径>，其余一律按用法错误停手（原来的契约就是一个开关都别乱传）。 */
function parseArgs(args: string[]): Options {
  let push = false
  let dryRun = false
  let candidatePath = ''
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    // 同一个开关给两遍也按用法错误处理：原来的契约是「只认一个开关」，重复传多半是命令拼错了。
    if (arg === '--push') { if (push) fail(USAGE); push = true; continue }
    if (arg === '--dry-run') { if (dryRun) fail(USAGE); dryRun = true; continue }
    if (arg === '--candidate') {
      if (candidatePath !== '') fail(USAGE)
      const value = args[index + 1]
      // 下一个词缺值、或者又是一个开关时按用法错误报出来：否则 '--push' 会被当成候选清单的路径交给门禁，
      // 人看到的会是一句「候选清单文件不存在」，离真正的问题（参数少了值）很远。
      if (value === undefined || value === '' || value.startsWith('-')) fail('--candidate needs the path to a candidate manifest. ' + USAGE)
      candidatePath = value
      index += 1
      continue
    }
    fail(USAGE)
  }
  // 两个开关一起给是自相矛盾的意思（一个要改引用、一个不许改）；原来的单参数契约也不接受两个参数。
  if (push && dryRun) fail(USAGE)
  return { push, candidatePath }
}

const args = process.argv.slice(2)
if (args[0] === '--notify-only' && args.length === 2) {
  notifyPublishedTag(run, args[1])
  console.log('[release-dist] notification retried after verifying the remote tag SHA')
  process.exit(0)
}
const options = parseArgs(args)
const push = options.push
const source = requireCleanSource(run)
if (push) requireVerifiedSource(path.join(ROOT, 'node_modules/.cache/dsh-verify-last.json'), source)
// 版本只读一次：门禁要按「本版」去找清单票，标签也按它命名。放在构建之前读，版本号写错时不必先等一次构建。
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package/package.json'), 'utf8'))
const version = String(manifest.version || '')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('package/package.json has invalid version ' + version)
console.log('[release-dist] mode: ' + (push ? 'push' : 'dry-run') + ' version=' + version + ' source=' + source)

// 门禁在构建之前跑：清单票没关闭时不该先花一分钟构建，结论也不该埋在构建输出后面。
// 它自己按 HEAD 取发布提交，而 requireCleanSource 已经保证 HEAD 不会在构建期间移动、已跟踪文件不会再被改，
// 所以这里检查的就是随后要被打标签的那个提交。判定本身在 release-dist-safety.mts，这里只转发结论。
const gate = await runPreflightGate({ version, candidatePath: options.candidatePath })
try {
  requireReleaseGate(gate, { push })
} catch (error) {
  // 门禁拒绝时用它自己的退出码结束（1=票面/候选要人改，2=环境或适配器缺失、未知码按环境失败），
  // 外层脚本才能照四态分流；把两者压成 1 会让「gh 没登录」看起来像「清单票没关闭」。
  if (!(error instanceof ReleaseGateRefusedError)) throw error
  fail(error.message, error.exitCode)
}

run(process.execPath, ['scripts/build.mts', '--force'], { stdio: 'inherit' })
requireCleanSource(run, source)
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
requireCleanSource(run, source)
const commit = run('git', ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Publish built package ' + version + ' from source commit ' + source + ' as the installable dist tree'])
console.log('[release-dist] version=' + version + ' tree=' + tree + ' commit=' + commit + ' parent=' + (parent || '(none)') + ' targets=' + targets.size)
if (!push) { console.log('[release-dist] dry-run: no ref, tag, push, or dispatch was changed'); process.exit(0) }

run('git', ['update-ref', 'refs/heads/dist', commit, parent || ''])
run('git', ['tag', '-a', tag, commit, '-m', 'Built installable release ' + version])
pushAndNotify(run, tag)
console.log('[release-dist] pushed ' + tag + ' and dispatched the plugin index')
