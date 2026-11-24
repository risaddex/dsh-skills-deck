// tests/verify-release-dist-bytes.ts —— #81 的端到端门禁：清单票里的差异审计真的能放行一次发布。
//
// 为什么单独一扇：判定本身（requireCandidateBytes 的三态）在 verify-release-dist-gate 里逐条钉过，
// 那段守的是「给定结论，发布脚本怎么停手」；这里守的是「结论怎么算出来、审计这条路通不通」——拿发布前
// 检查的真实输出走一遍脚本真正调用的 decideCandidateBytes。2.1.1 就断在这条缝上：清单票写了差异审计，
// 字节判定却只看到「没有审计」，发布最后只能不带 --candidate 硬走，字节证据整条丢掉。
//
// 门禁归属: scripts/release-dist.mts
// 门禁归属: scripts/lib/release-dist-safety.mts
// 门禁归属: scripts/lib/release-preflight-gate.mts
import fs from 'node:fs'
import { requireCandidateBytes, decideCandidateBytes } from '../scripts/lib/release-dist-safety.mts'
import { runPreflightGate } from '../scripts/lib/release-preflight-gate.mts'
import { CHECKLIST_TITLE_PREFIX } from '../scripts/lib/release-checklist-format.mts'
import { parseCandidateManifest } from 'dsh-featherhunter-plugin-base/real-machine-verification'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-release-dist-bytes'

/** 发布前检查组合根给出的一行输出；判定只负责把它转发给人。 */
type Line = { readonly stream: 'out' | 'err'; readonly text: string }

let assertions = 0
let failed = 0

function check(ok: boolean, message: string, detail = ''): void {
  assertions += 1
  if (ok) {
    console.log('PASS ' + message)
    return
  }
  failed += 1
  console.log('FAIL ' + message + (detail === '' ? '' : '；' + detail))
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function main(): Promise<void> {
  // ---- J. 端到端：清单票里的差异审计 → 门禁的标记行 → 发布脚本的字节判定（#81） ----
  // 为什么这一层非补不可：H 段钉的是判定的三个分支，G 段钉的是源码里调了谁，两段之间那条
  // 「门禁真的打出审计标记 → 判定真的据此放行」的缝没人守过。2.1.1 就断在这里：清单票写了审计，
  // 标记没出现，字节比对判 diff，发布最后只能不带 --candidate 硬走，字节证据整条丢掉。
  // 这里拿门禁的真实输出走一遍发布脚本真正调用的判定，断的是行为，不是源码里有没有某个字符串。
  {
    const CAND = 'a'.repeat(40)
    const REL = 'b'.repeat(40)
    const TGZ = 'd'.repeat(64)
    const FILE_DIGEST = 'e'.repeat(64)
    // 发布构建写出来的指纹；与候选不同，用来模拟「两份字节对不上」。
    const PUBLISHED = '1'.repeat(64)
    const V = '1.2.3'

    const identity = (commit: string): string =>
      '- Verification identity: batch b1; candidate commit ' + commit + '; candidate package sha256 ' + TGZ
    const bodyFor = (audit?: string): string => {
      const lines = [
        '# Real-machine verification checklist ' + V,
        '',
        '## Scenario overview',
        '| Scenario number | Source ticket | One sentence | Status | Notes |',
        '| --- | --- | --- | --- | --- |',
        '| 1600-01 | #16 | release gate | passed | |',
      ]
      if (audit !== undefined) lines.push('', '## Candidate and release difference audit', audit)
      return lines.join('\n')
    }
    const faceFor = (o: { commit: string; audit?: string; ancestry?: boolean }): any => ({
      kind: 'fake',
      async listChecklistIssues() {
        return [{ number: 69, title: CHECKLIST_TITLE_PREFIX + ' ' + V, state: 'CLOSED', body: bodyFor(o.audit) }]
      },
      async listComments() {
        return [{ body: 'Batch start:\n' + identity(o.commit) + '\nScenario 1600-01: passed\n[Ready to release] passed 1 / failed 0 / exempt 0' }]
      },
      async resolveReleaseCommit() { return REL },
      async isAncestor() { return o.ancestry ?? true },
    })
    const candidateFor = (commit: string): any => {
      const parsed = parseCandidateManifest({
        schemaVersion: 2, generatedAt: '2026-01-02T03:04:05.000Z', tool: 'fake-freeze@0.1.5', version: V,
        validity: 'release', sourceStable: true,
        git: { commit, branch: 'main', dirty: false, dirtyFiles: [] },
        package: {
          tgzPath: 'candidates/plugin-1.2.3.tgz', tgzBytes: 2048, tgzSha256: TGZ, filename: 'plugin-1.2.3.tgz',
          files: [{ path: 'package.json', bytes: 120, sha256: FILE_DIGEST }], fileCount: 1,
          fileDigest: FILE_DIGEST, manifestDigest: FILE_DIGEST,
        },
      })
      if (!parsed.ok) throw new Error('candidate fixture is invalid: ' + parsed.error.message)
      return parsed.value
    }
    const gateRun = async (o: { candCommit: string; commit: string; audit?: string; ancestry?: boolean }) =>
      runPreflightGate({ version: V, releaseCommit: REL, candidate: candidateFor(o.candCommit), ticketFace: faceFor(o) })
    const decide = (lines: readonly Line[], published: string) =>
      decideCandidateBytes({ lines, candidateFileDigest: FILE_DIGEST, publishedFileDigest: published })
    const accepts = (verdict: { verdict: string; message: string }): boolean => {
      try { requireCandidateBytes(verdict, { push: true, emit: () => {} }); return true } catch { return false }
    }

    // J1–J3：候选提交与发布提交不同、清单票写了差异审计 → 门禁打标记，判定放行（审计这条路真的通）。
    const audited = await gateRun({ candCommit: CAND, commit: CAND, ancestry: false,
      audit: '- Candidate commit ' + CAND + ' → release commit ' + REL + ': main merged the candidate after the freeze and only docs changed' })
    check(audited.exitCode === 0, 'J1 候选提交不同 + 清单票写了差异审计 → 门禁通过', show(audited.exitCode))
    check(audited.lines.some((line) => line.text.indexOf('PREFLIGHT-CANDIDATE-AUDIT') >= 0), 'J2 门禁打出差异审计标记（发布脚本据此知道差异被审计）',
      show(audited.lines.map((line) => line.text.slice(0, 32))))
    const auditedVerdict = decide(audited.lines, PUBLISHED)
    check(auditedVerdict.verdict === 'diff-audited' && accepts(auditedVerdict), 'J3 两个不同指纹 + 审计标记 → 判定放行（--push 不被拒）', auditedVerdict.verdict)

    // J4–J5：同样的提交差、清单票没写审计 → 门禁自己就拒，判定也不会放行（审计不是装饰）。
    const unaudited = await gateRun({ candCommit: CAND, commit: CAND, ancestry: false })
    check(unaudited.exitCode === 1, 'J4 没有差异审计 → 门禁拒（exit 1）', show(unaudited.exitCode))
    check(!unaudited.lines.some((line) => line.text.indexOf('PREFLIGHT-CANDIDATE-AUDIT') >= 0) && decide(unaudited.lines, PUBLISHED).verdict === 'diff',
      'J5 没有审计时既没有标记、判定也判 diff', decide(unaudited.lines, PUBLISHED).verdict)

    // J6–J7：候选提交就是发布提交、两份字节却不同 → 停手。同一提交的字节不一致是构建不可复现，
    // 不是「提交差异」那种可以写一行审计放行的事；#81 的失败模式就长这样，修好之后它必须判红。
    const sameCommit = await gateRun({ candCommit: REL, commit: REL })
    check(sameCommit.exitCode === 0, 'J6 候选提交等于发布提交 → 门禁通过', show(sameCommit.exitCode))
    const sameCommitVerdict = decide(sameCommit.lines, PUBLISHED)
    check(sameCommitVerdict.verdict === 'diff' && !accepts(sameCommitVerdict), 'J7 同一提交但字节不同 → 判定停手（构建不可复现）', sameCommitVerdict.verdict)

    // J8：修好之后的正路——两条路径产出同样的字节，判定判 same 并放行。
    const equalVerdict = decide(sameCommit.lines, FILE_DIGEST)
    check(equalVerdict.verdict === 'same' && accepts(equalVerdict), 'J8 字节与候选一致 → 放行（发布路径回到「验过的就是发出去的」）', equalVerdict.verdict)

    // J9：盘上的打包产物首行就是身份横幅。freeze 读的是第一处 legal comment，横幅缺了它就读错包；
    // 这一条让「构建不写横幅」这种回退在门禁里当场变红，而不是等到下一次发布才发现。
    const pkgJson: any = JSON.parse(fs.readFileSync('package/package.json', 'utf8'))
    const firstLine = fs.readFileSync('package/lib/client.js', 'utf8').split('\n')[0]
    check(firstLine === '/*! ' + pkgJson.name + ' v' + pkgJson.version + ' */',
      'J9 package/lib/client.js 首行是身份横幅（验证路径与发布路径同一个构建，字节因此一致）', firstLine.slice(0, 60))
  }
}

main()
  .then(() => {
    console.log('共有 ' + assertions + ' 条断言，' + (failed === 0 ? '全部通过' : '存在 ' + failed + ' 条失败'))
    printGateResult(GATE, assertions, failed)
    if (failed !== 0) process.exit(1)
  })
  .catch((error: unknown) => {
    console.error('门禁运行出错：' + ((error as { stack?: string }).stack ?? String(error)))
    printGateResult(GATE, assertions, failed + 1)
    process.exit(1)
  })
