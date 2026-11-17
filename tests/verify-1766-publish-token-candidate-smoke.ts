// tests/verify-1766-publish-token-candidate-smoke.ts —— the PowerShell half of the #1766 release audit.
//
// Why this is its own gate: `scripts/publish-token.ps1` can only be exercised by a real `pwsh`, and function
// definition order mistakes only show up when PowerShell actually runs the script; the pure-function tests in
// `tests/verify-1766-release-audit.ts` cannot see them. That gate is held to an exact assertion count by the
// completion-evidence rule (#1158), so an assertion that exists only on machines with `pwsh` cannot live there:
// it would make the count differ from machine to machine.
//
// Missing `pwsh` is not a failure and is not a silent pass either. The gate prints one INFO line that says
// what was skipped and where to run it, the same wording convention as `tests/verify-1646-publish-token-file.ts`.
// `publish-token.ps1` is the npm publishing flow inherited from upstream; this fork publishes through
// `scripts/release-dist.mts` and never runs it, so a machine without `pwsh` loses no release evidence.
//
// The token is deliberately withheld. If the candidate check really runs, the script prints CANDIDATE-VALID first and
// then exits 2 at the step that reads the token. If the call goes back to a function that is not defined yet, the output
// carries CommandNotFound and the exit code is not 2.
//
// Run: node --import ./scripts/ts-hook.mts tests/verify-1766-publish-token-candidate-smoke.ts
// 门禁归属: scripts/publish-token.ps1
// 门禁归属: scripts/release-candidate-check.mts

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RELEASE = 'a'.repeat(40)
const DIGEST = 'd'.repeat(64)
const PWSH = (process.env.PWSH || '').trim() || 'pwsh'

let total = 0
let failed = false

function check(ok: boolean, message: string): void {
  total += 1
  if (!ok) failed = true
  console.log((ok ? '  PASS ' : '  FAIL ') + message)
}

console.log('[publish-token.ps1 -Candidate smoke]')

const probe = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000 })
const hasPwsh = !probe.error && probe.status === 0

if (!hasPwsh) {
  console.log(
    '  INFO ' + PWSH + ' is not available: the 3 PowerShell assertions were skipped. ' +
      'Run this gate on a machine with pwsh 7 (set PWSH to its path if it is not on PATH).',
  )
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-1766-smoke-'))
  try {
    const candidate = path.join(dir, 'candidate.json')
    fs.writeFileSync(
      candidate,
      JSON.stringify({
        validity: 'release',
        sourceStable: true,
        git: { commit: RELEASE },
        package: { fileDigest: DIGEST, tgzSha256: DIGEST, tgzPath: 'candidate.tgz' },
      }),
    )
    const run = spawnSync(
      PWSH,
      [
        '-NoProfile',
        '-File',
        'scripts/publish-token.ps1',
        '-Candidate',
        candidate,
        '-DryRun',
        '-SkipGate',
        '-TokenEnv',
        'VERIFY_1766_TOKEN_THAT_DOES_NOT_EXIST',
        '-LogPath',
        path.join(dir, 'publish-token.log'),
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    const output = String(run.stdout || '') + String(run.stderr || '')
    check(run.status === 2, 'with -Candidate and no token the script exits 2 (actual code=' + String(run.status) + ')')
    check(
      output.includes('CANDIDATE-VALID commit=' + RELEASE),
      'the script really ran the candidate check and printed CANDIDATE-VALID before reading the token',
    )
    check(
      !/Invoke-CandidateCheck|Write-ToolOutput|CommandNotFound|不支持.*cmdlet|不被识别/u.test(output),
      'the candidate check did not fail with "command not found" because of function definition order' +
        (output ? ' (output=' + JSON.stringify(output.slice(0, 200)) + ')' : ''),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failed ? '\nFailures present (' + total + ' assertions run)' : '\nAll passed (' + total + ' assertions run)')
if (failed) process.exitCode = 1
