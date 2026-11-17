// tests/lib/release-gate-wiring.ts —— verify-release-gate 的「接线」两节：K 静态断言与 L 薄 CLI 子进程。
//
// 为什么拆出来：verify-release-gate.ts 把门禁判定（A–J、M、N，要假票面与假端口）和接线检查（K、L，只读源码与
// 起子进程）写在同一个文件里，超过了单文件体积上限。两部分共用同一个断言计数器，且 tests/gate-map.json 对这个
// 门禁记的是一个总断言数，所以不拆成两个门禁，只把后半部分搬到这里，由主文件调用、共用主文件的 check。
// 这里的断言不依赖主文件的任何夹具（假票面、假端口、候选清单都用不到），只需要几条路径与一个计数函数。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join } from 'node:path'

import {
  parseChecklistFormat,
  validateTicketFaceAdapter,
  TICKET_FACE_METHODS,
} from 'dsh-featherhunter-plugin-base/real-machine-verification'

import { CHECKLIST_FORMAT } from '../../scripts/lib/release-checklist-format.mts'

/** 主文件的断言函数：计数与打印都归主文件，这里只负责调用。 */
export type Check = (ok: boolean, message: string, detail?: string) => void

export type WiringContext = {
  check: Check
  show: (value: unknown) => string
  root: string
  /** base 的适配器形状校验要用的、verify/ticket-face.mts 的默认导出。 */
  ticketFace: any
}

function readSource(path: string): string {
  return fs.readFileSync(path, 'utf8')
}

// 只认 import 语句（含多行 import { ... }），注释里提到符号不算接线。
function importsSymbol(text: string, symbol: string): boolean {
  return new RegExp('import\\s*\\{[^}]*\\b' + symbol + '\\b', 's').test(text)
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count++
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

// 扫源码树找「谁 import 了某个符号」：只看代码扩展名，跳过 node_modules 与构建产物。
function scanImportsOf(root: string, needle: string): string[] {
  const extensions = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs'])
  const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git'])
  const hits: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!extensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue
      const path = join(dir, entry.name)
      let text = ''
      try {
        text = fs.readFileSync(path, 'utf8')
      } catch {
        continue
      }
      if (importsSymbol(text, needle)) hits.push(path)
    }
  }
  for (const sub of ['scripts', 'verify', 'tests', 'src']) walk(join(root, sub))
  return hits.sort()
}

/** K 节与 L 节。断言编号（K1…K28、L1…L8）保持原样，gate-map 里的期望数只看总数。 */
export function runWiringChecks(context: WiringContext): void {
  const { check, show, root, ticketFace } = context
  const RELEASE_PREFLIGHT = join(root, 'scripts', 'release-preflight.mts')
  const RELEASE_PREFLIGHT_GATE = join(root, 'scripts', 'lib', 'release-preflight-gate.mts')
  const TICKET_FACE = join(root, 'verify', 'ticket-face.mts')
  const PROFILE = join(root, 'verify', 'profile.ts')
  const PUBLISH_TOKEN = join(root, 'scripts', 'publish-token.ps1')
  const WIZARD_RELEASE = join(root, 'scripts', 'wizard-release.sh')
  const SCRIPTS_TSCONFIG = join(root, 'scripts', 'tsconfig.json')
  const ROOT = root

  // ---- K. 接线静态断言：两条发布路径同一份代码、没留跳过开关 ----
  {
    const cliSource = readSource(RELEASE_PREFLIGHT)
    check(cliSource.includes("from './lib/release-preflight-gate.mts'"), 'K1 薄 CLI 从组合根 import runPreflightGate', '')
    check(countOccurrences(cliSource, 'runPreflightGate(') === 1, 'K2 薄 CLI 只调一次组合根，没有第二条判定路径', show(countOccurrences(cliSource, 'runPreflightGate(')))
    check(!importsSymbol(cliSource, 'runReleaseGate'), 'K3 薄 CLI 不直接 import 门禁，规则只在组合根里接', '')
    check(!cliSource.includes("'--soft'") && !cliSource.includes('"--soft"'), 'K4 薄 CLI 不接 --soft（注释里说明为什么不传不算开关）', '')
    check(
      !cliSource.includes('--force') && !cliSource.includes('--no-verify') && !cliSource.includes('skip'),
      'K5 薄 CLI 没有 force / no-verify / skip 开关',
      '',
    )
    check(cliSource.includes('process.exitCode'), 'K6 用 process.exitCode 收尾（Node 24 Windows 上不截断 stdout）', '')
    check(!cliSource.includes('process.exit('), 'K7 不直接调 process.exit(', '')

    const gateSource = readSource(RELEASE_PREFLIGHT_GATE)
    check(countOccurrences(gateSource, 'runReleaseGate(') === 1, 'K8 组合根里 runReleaseGate 只调用一次', show(countOccurrences(gateSource, 'runReleaseGate(')))
    check(gateSource.includes('renderReleaseGateHuman'), 'K9 组合根用 base 的人类可读报告渲染', '')
    check(gateSource.includes('PREFLIGHT-CANDIDATE-AUDIT') && gateSource.includes('PREFLIGHT-CANDIDATE-OK'), 'K10 候选标记在组合根里生成', '')
    check(gateSource.includes('PREFLIGHT-BLOCKED') && gateSource.includes('PREFLIGHT-FAIL') && gateSource.includes('PREFLIGHT-OK') && gateSource.includes('PREFLIGHT-ENV'), 'K11 四类标记齐全', '')

    const importers = scanImportsOf(root, 'runReleaseGate')
    check(
      JSON.stringify(importers) === JSON.stringify([RELEASE_PREFLIGHT_GATE]),
      'K12 全仓只有组合根 import runReleaseGate（没有第二处接线，也没有第二份规则）',
      show(importers.map((path) => path.slice(ROOT.length + 1))),
    )

    const publishSource = readSource(PUBLISH_TOKEN)
    check(publishSource.includes('scripts/release-preflight.mts'), 'K13 publish-token.ps1 调发布前检查', '')
    check(!publishSource.includes('--soft'), 'K14 publish-token.ps1 不再传跳过开关', '')
    check(publishSource.includes('CHECK-BLOCKED') && publishSource.includes('CHECK-ENV'), 'K15 publish-token.ps1 接了四态（含 blocked / env）', '')

    const wizardSource = readSource(WIZARD_RELEASE)
    check(wizardSource.includes('scripts/release-preflight.mts'), 'K16 wizard-release.sh 调发布前检查', '')
    check(!wizardSource.includes('--soft'), 'K17 wizard-release.sh 不再传跳过开关', '')
    check(wizardSource.includes('PREFLIGHT_CODE') && wizardSource.includes('exit 2'), 'K18 wizard-release.sh 区分 blocked（exit 2）', '')

    const profileSource = readSource(PROFILE)
    check(profileSource.includes('ticketFace') && profileSource.includes('verify/ticket-face.mts'), 'K19 verify/profile.ts 声明票面适配器', '')

    const ticketFaceSource = readSource(TICKET_FACE)
    check(ticketFaceSource.includes('merge-base') && ticketFaceSource.includes('"unknown"'), 'K20 gh 适配器的 isAncestor 三态，不拿 false 冒充 unknown', '')
    check(ticketFaceSource.includes('ReleaseEnvError'), 'K21 环境问题抛 ReleaseEnvError（门禁归 blocked，不冒充票面失败）', '')

    const validated = validateTicketFaceAdapter(ticketFace)
    check(validated.ok === true, 'K22 verify/ticket-face.mts 的默认导出通过 base 的适配器形状校验', validated.ok ? '' : show(validated))
    check(ticketFace?.kind === 'github-gh-cli', 'K23 适配器 kind 说明协议来源', show(ticketFace?.kind))
    check(
      TICKET_FACE_METHODS.every((method: string) => typeof (ticketFace as any)[method] === 'function'),
      'K24 四个必需方法都在',
      show(TICKET_FACE_METHODS.map((method: string) => typeof (ticketFace as any)[method])),
    )

    const tsconfigSource = readSource(SCRIPTS_TSCONFIG)
    check(tsconfigSource.includes('lib/release-preflight-gate.mts'), 'K25 组合根登记进 scripts/tsconfig.json', '')
    check(tsconfigSource.includes('../verify/ticket-face.mts'), 'K26 票面适配器登记进 scripts/tsconfig.json', '')
    // #17：清单票的格式改由本仓声明（英文模板）。这两条钉住「递进去了」与「声明本身合法」——
    // 少了前者，门禁会静默退回 base 的中文模板；少了后者，写错的状态角色要等到读票时才表现为「读不出来」。
    check(
      countOccurrences(gateSource, 'format: parsedFormat.value') === 1,
      'K27 组合根把本仓声明的清单票格式递进门禁，且只有一处',
      show(countOccurrences(gateSource, 'format: parsedFormat.value')),
    )
    const declared = parseChecklistFormat(CHECKLIST_FORMAT)
    check(
      declared.ok === true,
      'K28 声明的格式通过 base 的 parseChecklistFormat（每个状态角色都在词表里）',
      declared.ok ? '' : show(declared),
    )
  }

  // ---- L. 薄 CLI 的子进程行为（--help 与参数错误，不触发网络） ----
  {
    const help = spawnSync(process.execPath, [RELEASE_PREFLIGHT, '--help'], { cwd: ROOT, encoding: 'utf8' })
    check(help.status === 0, 'L1 --help 退出码 0', String(help.status))
    check((help.stdout ?? '').includes('用法'), 'L2 --help 打印用法', (help.stdout ?? '').trim().slice(0, 80))
    check(!(help.stdout ?? '').includes('PREFLIGHT-ENV'), 'L3 --help 不冒充参数错误', '')

    const bogus = spawnSync(process.execPath, [RELEASE_PREFLIGHT, '--bogus'], { cwd: ROOT, encoding: 'utf8' })
    check(bogus.status === 2, 'L4 不认识的参数 → 退出码 2', String(bogus.status))
    check((bogus.stderr ?? '').includes('PREFLIGHT-ENV') && (bogus.stderr ?? '').includes('不认识的参数'), 'L5 参数错误走 PREFLIGHT-ENV 并点名参数', (bogus.stderr ?? '').trim().slice(0, 120))

    const soft = spawnSync(process.execPath, [RELEASE_PREFLIGHT, '--version', '1.2.3', '--soft'], { cwd: ROOT, encoding: 'utf8' })
    check(soft.status === 2 && (soft.stderr ?? '').includes('不认识的参数：--soft'), 'L8 传 --soft 直接被拒（没有跳过开关）', String(soft.status) + ' / ' + (soft.stderr ?? '').trim().slice(0, 80))

    const missingValue = spawnSync(process.execPath, [RELEASE_PREFLIGHT, '--version'], { cwd: ROOT, encoding: 'utf8' })
    check(missingValue.status === 2, 'L6 --version 缺值 → 退出码 2', String(missingValue.status))
    check((missingValue.stderr ?? '').includes('PREFLIGHT-ENV'), 'L7 缺值也是环境类错误', (missingValue.stderr ?? '').trim().slice(0, 120))
  }
}
