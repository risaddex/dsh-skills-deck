// tests/verify-20-room-list-sync.ts — the built-in room list must read the same everywhere (#20)
//
// The same fact (which rooms are built in) is written in four places. This gate compares them and names
// the id that is missing from which list, so adding a room cannot leave one list behind:
//   R1  BUILTIN_ROOM_IDS (src/tracker/registry/builtins.ts) and MULTI_CLAIM_ORDER
//       (src/tracker/detection/backendDecision.ts) hold the same ids in the same order.
//   R2  every id in BUILTIN_ROOM_IDS has a directory under src/tracker/rooms/, and every room directory is in
//       the list (directories that hold no room, such as a README, are not directories and are ignored).
//   R3  src/tracker/rooms/README.md has one row in its table of built-in rooms for every id, and no row for a
//       room that does not exist. The README stays the only place that holds the table: this gate reads it,
//       it never copies it.
//   R4  the comparison itself is proved able to fail: each rule is run against a deliberately broken input
//       and must report a problem.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-20-room-list-sync.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_ROOM_IDS } from '../src/tracker/registry/builtins.ts'
import { MULTI_CLAIM_ORDER } from '../src/tracker/detection/backendDecision.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const ROOMS_DIR = 'src/tracker/rooms'
const README = ROOMS_DIR + '/README.md'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

/** R1: the two lists must hold the same ids in the same order; returns one sentence per difference. */
export function orderProblems(registry: readonly string[], claim: readonly string[]): string[] {
  const out: string[] = []
  for (const id of registry) if (!claim.includes(id)) out.push('"' + id + '" is in BUILTIN_ROOM_IDS but missing from MULTI_CLAIM_ORDER')
  for (const id of claim) if (!registry.includes(id)) out.push('"' + id + '" is in MULTI_CLAIM_ORDER but missing from BUILTIN_ROOM_IDS')
  if (out.length === 0 && registry.join(',') !== claim.join(',')) {
    out.push('both lists hold ' + registry.length + ' ids but in a different order: registry ' + registry.join(' > ') + ', claim ' + claim.join(' > '))
  }
  return out
}

/** R2: ids against the room directories; returns one sentence per difference. */
export function directoryProblems(ids: readonly string[], dirs: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) if (!dirs.includes(id)) out.push('"' + id + '" is in BUILTIN_ROOM_IDS but has no directory under ' + ROOMS_DIR + '/')
  for (const d of dirs) if (!ids.includes(d)) out.push('directory ' + ROOMS_DIR + '/' + d + '/ is not in BUILTIN_ROOM_IDS')
  return out
}

/**
 * Reads the room directory column of the README table: a row counts as a room row when its directory cell is a
 * single backticked name ending in a slash, such as `github/`. Cells with a path (for example the
 * third-party example `examples/demo-mini/`) or extra words are not rooms of this directory and are skipped.
 */
export function readmeRoomRows(markdown: string): string[] {
  const rows: string[] = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    const m = /^`([a-z][a-z0-9-]*)\/`$/.exec(cells[2] || '')
    if (m) rows.push(m[1])
  }
  return rows
}

/** R3: ids against the README rows; returns one sentence per difference. */
export function readmeProblems(ids: readonly string[], rows: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) if (!rows.includes(id)) out.push('"' + id + '" is a built-in room but ' + README + ' has no table row for it')
  for (const r of rows) if (!ids.includes(r)) out.push(README + ' has a table row for "' + r + '" which is not in BUILTIN_ROOM_IDS')
  return out
}

function roomDirectories(): string[] {
  const base = join(repoRoot, ROOMS_DIR)
  return readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory()).sort()
}

function main(): void {
  console.log('R1 registry order against claim order')
  const r1 = orderProblems(BUILTIN_ROOM_IDS, MULTI_CLAIM_ORDER)
  check(r1.length === 0, 'BUILTIN_ROOM_IDS and MULTI_CLAIM_ORDER agree (' + BUILTIN_ROOM_IDS.join(' > ') + ')', r1.join('; '))

  console.log('R2 room ids against directories')
  const dirs = roomDirectories()
  const r2 = directoryProblems(BUILTIN_ROOM_IDS, dirs)
  check(r2.length === 0, 'every id has a directory and every room directory is listed (' + dirs.join(', ') + ')', r2.join('; '))

  console.log('R3 room ids against the README table')
  check(existsSync(join(repoRoot, README)), README + ' exists')
  const rows = readmeRoomRows(readFileSync(join(repoRoot, README), 'utf8'))
  const r3 = readmeProblems(BUILTIN_ROOM_IDS, rows)
  check(rows.length > 0, 'the README table has room rows at all (a format change would otherwise pass silently)', 'no row matched the pattern')
  check(r3.length === 0, 'the README has one row per built-in room (' + rows.join(', ') + ')', r3.join('; '))

  console.log('R4 each rule can fail')
  const ids = ['github', 'markdown', 'gitlab']
  check(orderProblems(ids, ['github', 'gitlab']).length === 1, 'an id missing from the claim order is reported')
  check(orderProblems(ids, ['github', 'markdown', 'gitlab', 'linear']).length === 1, 'an extra id in the claim order is reported')
  check(orderProblems(ids, ['github', 'gitlab', 'markdown']).length === 1, 'the same ids in another order are reported')
  check(directoryProblems(ids, ['github', 'markdown']).length === 1, 'a room id with no directory is reported')
  check(directoryProblems(ids, ['github', 'markdown', 'gitlab', 'linear']).length === 1, 'a room directory with no id is reported')
  check(readmeProblems(ids, ['github', 'markdown']).length === 1, 'a built-in room with no README row is reported')
  check(readmeProblems(ids, ['github', 'markdown', 'gitlab', 'jira']).length === 1, 'a README row for a missing room is reported')
  const sample = '| Backend | Directory | Owner | CLI |\n|---|---|---|---|\n| GitHub | `github/` | x | `gh` |\n| Example | `examples/demo-mini/` (not here) | x | y |\n'
  check(readmeRoomRows(sample).join(',') === 'github', 'a row whose directory cell is a path or has extra words is not a room row', readmeRoomRows(sample).join(','))

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main()
