// tests/verify-85-label-step-receipt.ts — the create receipt says which step failed when a label cannot be created (#85)
//
// Why this gate exists: in a Linear workspace whose app token may not create labels, `deck_issue_create` answered
// "not allowed to take action" with an empty `stage` and the reason `backend-unsupported`, so nobody could tell
// that the label step had failed, which labels were missing, or what to do. The room now marks that failure with
// the step `label-create` and writes the missing names into its message. Four things are checked at the receipt:
//   R1  the receipt text carries the whole message of the room (every missing name), not a 300-character cut of it;
//   R2  the failure evidence carries the step marker next to the kind, and the reason is still one of the eight codes;
//   R3  the step marker does not change what the reason table answers for any kind (the vocabulary stays at eight);
//   R4  every other failure is reported exactly as before (still cut at 300 characters, no step marker).
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-85-label-step-receipt.ts
import { backendCreateFailure } from '../src/deck/tools/issue-create-failure.ts'
import { reasonForFailure } from '../src/deck/shell/receipt-reason.ts'
import { REFUSAL_REASONS } from '../src/deck/shell/call-shell.ts'
import { TRACKER_ERROR_STAGE } from '../src/tracker/contract/results.ts'
import { ERROR_KIND } from '../src/tracker/contract/vocabulary.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

// Ten names is more than the old 300-character cut can hold, and a workspace that lacks the whole wayfinder set
// plus `bug` is exactly the case that happened: the message has to survive with every name in it.
const NAMES = ['bug', 'wayfinder:map', 'wayfinder:research', 'wayfinder:prototype', 'wayfinder:grilling', 'wayfinder:task', 'ready-for-agent', 'ready-for-human', 'needs-triage', 'needs-info']
const LABEL_MESSAGE = 'The step of creating a label failed: Linear did not create "bug" (Linear said: not allowed to take action). '
  + 'Missing labels that could not be created: ' + NAMES.map((n) => '"' + n + '"').join(', ') + '. '
  + 'No ticket was created or changed. Create them once in Linear (Settings, Labels, team GUE) and retry.'

function main(): void {
  check(LABEL_MESSAGE.length > 300, 'the probe message is longer than the old 300-character cut', String(LABEL_MESSAGE.length))

  console.log('R1 the receipt text keeps the whole label-step message')
  {
    const out = backendCreateFailure({ error: { kind: 'auth', message: LABEL_MESSAGE, stage: TRACKER_ERROR_STAGE.LABEL_CREATE } }, false, [])
    const value: any = out.value
    check(String(value.text).indexOf('This ticket was not created') === 0, 'the receipt still opens with "This ticket was not created"', value.text)
    check(NAMES.every((name) => String(value.text).indexOf('"' + name + '"') >= 0), 'every missing name is in the receipt text', value.text)
    check(String(value.text).indexOf('not allowed to take action') >= 0 && /Settings, Labels/.test(value.text), "Linear's words and the place to create the labels are in it", value.text)
    check(String(value.data.error.message).indexOf('"' + NAMES[NAMES.length - 1] + '"') >= 0, 'the failure evidence keeps the whole message too', value.data.error.message)
    check(String(value.text).indexOf('retry exactly as it is') < 0, 'no "retry as it is" advice is added: retrying cannot help until the labels exist', value.text)
  }

  console.log('R2 the evidence carries the step marker next to the kind, and the reason stays one of the eight codes')
  {
    const value: any = backendCreateFailure({ error: { kind: 'auth', message: LABEL_MESSAGE, stage: TRACKER_ERROR_STAGE.LABEL_CREATE } }, false, []).value
    check(value.data.error.stage === 'label-create', 'data.error.stage is the label-create marker', JSON.stringify(value.data.error))
    check(value.data.error.kind === 'auth', 'data.error.kind is still the room kind', JSON.stringify(value.data.error))
    check(value.reason === REFUSAL_REASONS.BACKEND_UNSUPPORTED && value.data.error.code === REFUSAL_REASONS.BACKEND_UNSUPPORTED, 'the reason is still backend-unsupported (the next step is to stop)', JSON.stringify({ reason: value.reason, code: value.data.error.code }))
    check(Object.keys(REFUSAL_REASONS).length === 8, 'the vocabulary still has eight codes', String(Object.keys(REFUSAL_REASONS).length))
  }

  console.log('R3 the step marker changes no answer of the reason table')
  {
    const kinds = ['env', 'auth', 'rate-limit', 'conflict', 'unsupported', 'not-found', 'network', 'parse', 'timeout', 'aborted', 'over-budget', 'backend-threw']
    for (const kind of kinds) {
      const bare = reasonForFailure({ phase: 'write', kind })
      const marked = reasonForFailure({ phase: 'write', kind, stage: TRACKER_ERROR_STAGE.LABEL_CREATE })
      check(marked === bare, 'write phase, kind ' + kind + ': the same code with and without the marker', bare + ' vs ' + marked)
    }
    check(Object.values(ERROR_KIND).length === 8, 'the error kinds are still the eight of the contract', String(Object.values(ERROR_KIND).length))
  }

  console.log('R4 every other failure is reported as before')
  {
    const long = 'x'.repeat(500)
    const plain: any = backendCreateFailure({ error: { kind: 'auth', message: long } }, false, []).value
    check(String(plain.text).length < 400, 'a failure without the marker is still cut at 300 characters', String(plain.text.length))
    check(plain.data.error.stage === '', 'and its stage stays empty', JSON.stringify(plain.data.error))
    const lookup: any = backendCreateFailure({ error: { kind: 'unsupported', message: 'lookup failed', stage: TRACKER_ERROR_STAGE.ANCHOR_LOOKUP } }, true, []).value
    check(String(lookup.text).indexOf('can retry exactly as it is') >= 0, 'the anchor-lookup advice is unchanged', lookup.text)
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main()
