// tests/verify-92-label-step-log.ts — the two log lines of the label step (#92)
//
// Why this gate exists: #85 fixed the behaviour (a label name matches ignoring case, a refused label creation is
// explained) but left the step silent in the log, so after the fact nobody could tell from the local logs whether
// the case-insensitive match had actually worked — the very case that caused #85. Two lines are now written, both
// on disk with the debug switch off:
//   L1  `label.resolve.match` (info): one line per resolution saying how many names were asked for, how many were
//       satisfied by a differently spelled label, a hash of those pairs, how long it took, and which operation it
//       belonged to. A resolution where nothing folded still writes the line with `folded: 0`.
//   L2  `label.resolve.fail` (warn): the step that creates a missing label was refused — the error kind, how many
//       names are still missing, a hash of them, and the duration.
//   L3  label names never reach the log as text: only counts and a short hash, the same rule `labelColors.listed`
//       follows. The names themselves stay in the receipt message, which is read once, not kept on disk.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-92-label-step-log.ts
import type { OpContext } from '../src/tracker/contract/contexts.ts'
import { resolveLabelIds } from '../src/tracker/rooms/linear/labels.ts'
import type { LinearAccount } from '../src/tracker/rooms/linear/client.ts'
import type { WantedLabel } from '../src/tracker/rooms/linear/label-match.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 600) : '')))
  if (!ok) failed = true
}

const ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_key' }
const OP_ID = 'op-92-label-step'

/** One logged line, as the caller of the tool would have it: level, event name and the fields. */
interface Line { level: string; event: string; fields: Record<string, unknown> }

/**
 * A context whose channel answers prepared replies and which records every log line it is asked to write.
 * `isEnabled` always answers false: the debug switch is off, which is the state both lines have to survive.
 */
function ctxAnswering(replies: any[]): { ctx: OpContext; calls: any[]; lines: Line[] } {
  const calls: any[] = []
  const lines: Line[] = []
  const ctx = {
    opId: OP_ID,
    http: {
      async request(req: any) {
        calls.push(req)
        const reply = replies[calls.length - 1] || replies[replies.length - 1]
        const body = reply && reply.__errors ? { errors: reply.__errors } : { data: reply }
        return { status: 200, headers: { forEach() {} }, body: JSON.stringify(body) }
      },
    },
    logEvent: (level: string, event: string, fields: Record<string, unknown>) => { lines.push({ level, event, fields }) },
    isEnabled: () => false,
  } as unknown as OpContext
  return { ctx, calls, lines }
}

const wanted = (...names: string[]): WantedLabel[] => names.map((name) => ({ name, color: '', description: '' }))
const FORBIDDEN = { __errors: [{ message: 'not allowed to take action', extensions: { type: 'forbidden' } }] }
const HEX8 = /^[0-9a-f]{8}$/

async function main(): Promise<void> {
  console.log('L1 a request satisfied by a differently spelled label writes one info line')
  {
    const one = ctxAnswering([{ issueLabels: { nodes: [{ id: 'lbl-Bug', name: 'Bug', team: null }], pageInfo: { hasNextPage: false } } }])
    const answer = await resolveLabelIds(one.ctx, ACCOUNT, wanted('bug'), 'GUE')
    check(answer.ok === true, 'the request is satisfied (fixture)', answer.ok ? 'ok' : JSON.stringify(answer.error))
    check(one.lines.length === 1, 'exactly one line is written for one resolution', JSON.stringify(one.lines))
    const line = one.lines[0] || { level: '', event: '', fields: {} }
    check(line.event === 'label.resolve.match', 'the event is label.resolve.match', line.event)
    check(line.level === 'info', 'it is an info line (resident, so it lands with the debug switch off)', line.level)
    check(line.fields.requested === 1, 'requested says how many names were asked for', JSON.stringify(line.fields))
    check(line.fields.folded === 1, 'folded says one name was satisfied by a differently spelled label', JSON.stringify(line.fields))
    check(HEX8.test(String(line.fields.namesHash)), 'namesHash is a short hash of the pairs', JSON.stringify(line.fields))
    check(typeof line.fields.latencyMs === 'number' && (line.fields.latencyMs as number) >= 0, 'latencyMs is a number', JSON.stringify(line.fields))
    check(line.fields.opId === OP_ID, 'opId ties the line to this operation', JSON.stringify(line.fields))
  }

  console.log('L1b one line per resolution, and a resolution where nothing folded still writes it')
  {
    const two = ctxAnswering([{ issueLabels: { nodes: [{ id: 'lbl-bug', name: 'bug', team: null }, { id: 'lbl-Docs', name: 'Docs', team: null }], pageInfo: { hasNextPage: false } } }])
    await resolveLabelIds(two.ctx, ACCOUNT, wanted('bug', 'docs'), 'GUE')
    check(two.lines.length === 1, 'two names still make one line, not one line each', String(two.lines.length))
    check(two.lines[0] && two.lines[0].fields.requested === 2 && two.lines[0].fields.folded === 1, 'requested counts both names, folded counts only the one whose spelling differed', JSON.stringify(two.lines[0] && two.lines[0].fields))

    const exact = ctxAnswering([{ issueLabels: { nodes: [{ id: 'lbl-docs', name: 'docs', team: null }], pageInfo: { hasNextPage: false } } }])
    await resolveLabelIds(exact.ctx, ACCOUNT, wanted('docs'), 'GUE')
    check(exact.lines.length === 1 && exact.lines[0].event === 'label.resolve.match', 'an exact match writes the line too', JSON.stringify(exact.lines))
    check(exact.lines[0] && exact.lines[0].fields.folded === 0, 'and folded is 0, which says "looked, nothing folded" rather than "never got here"', JSON.stringify(exact.lines[0] && exact.lines[0].fields))
  }

  console.log('L2 a refused label creation writes one warn line')
  {
    const refused = ctxAnswering([
      { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } },
      { teams: { nodes: [{ id: 'team-1', key: 'GUE', name: 'Guedder' }] } },
      FORBIDDEN,
    ])
    const answer = await resolveLabelIds(refused.ctx, ACCOUNT, wanted('bug', 'wayfinder:map'), 'GUE')
    check(answer.ok === false && answer.error.stage === 'label-create', 'the call fails at the label step (fixture)', answer.ok ? 'ok' : JSON.stringify(answer.error))
    const warn = refused.lines.filter((l) => l.event === 'label.resolve.fail')
    check(warn.length === 1, 'exactly one refusal line', JSON.stringify(refused.lines))
    const line = warn[0] || { level: '', event: '', fields: {} }
    check(line.level === 'warn', 'it is a warn line, so it is flushed straight to disk', line.level)
    check(line.fields.kind === 'auth', 'kind keeps the error kind the receipt reports', JSON.stringify(line.fields))
    check(line.fields.missing === 2 && line.fields.requested === 2, 'missing counts every name still missing, requested counts what was asked for', JSON.stringify(line.fields))
    check(HEX8.test(String(line.fields.namesHash)), 'namesHash is a short hash of the missing names', JSON.stringify(line.fields))
    check(line.fields.opId === OP_ID && typeof line.fields.latencyMs === 'number', 'the line carries the operation and the duration', JSON.stringify(line.fields))
    check(refused.lines[0] && refused.lines[0].event === 'label.resolve.match' && refused.lines[0].fields.folded === 0, 'the resolution line was written first, so the run shows the lookup happened before the refusal', JSON.stringify(refused.lines))
  }

  console.log('L3 label names never reach the log as text')
  {
    const upper = ctxAnswering([{ issueLabels: { nodes: [{ id: 'lbl-Bug', name: 'Bug', team: null }], pageInfo: { hasNextPage: false } } }])
    await resolveLabelIds(upper.ctx, ACCOUNT, wanted('bug'), 'GUE')
    const refused = ctxAnswering([
      { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } },
      { teams: { nodes: [{ id: 'team-1', key: 'GUE', name: 'Guedder' }] } },
      FORBIDDEN,
    ])
    await resolveLabelIds(refused.ctx, ACCOUNT, wanted('wayfinder:map'), 'GUE')
    const payload = JSON.stringify(upper.lines.concat(refused.lines))
    check(payload.toLowerCase().indexOf('bug') < 0, 'the spelling that was asked for is not in the log', payload)
    check(payload.indexOf('wayfinder:map') < 0, 'nor is a missing name', payload)
    check(upper.lines.concat(refused.lines).every((l) => HEX8.test(String(l.fields.namesHash)) || !('namesHash' in l.fields)), 'names are only ever a hash, never text', payload)
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
