// src/deck/tools/issue-patch-receipt.ts — the ticket face that a deck_issue_patch receipt carries.
//
// Why a separate, small face: the read-back that follows a write is the whole ticket (body, which
// already holds the comments, plus the comments array again). Returning all of it made every patch
// receipt about 10 KB, although the caller already knows what it sent. The receipt only needs to say
// which ticket it is about and what the backend now holds for the fields this call changed.
// Everything else stays where it was: `items` (one entry per step, the `text` step carries the new
// progress entry with the time the tool stamped), `readBack` ({ key, state, updatedAt }, enough to
// confirm the write without reading again) and `data.retry` on a status-conflict refusal.
//
// A caller that needs the body or the comments reads the ticket with deck_issue_get; this module
// never adds them back.
type UnknownRecord = Record<string, unknown>

/** Fields that identify the ticket. The work route reads key, title and effortId from this face. */
const IDENTITY_FIELDS = ['title', 'effortId'] as const

/**
 * Builds `data.ticket` for the receipt from the post-write read-back.
 *
 * Returns null when there is no read-back, never an empty object: null is how a caller tells that
 * the read-back failed (the receipt notes say why). `wants` is the same map issue-patch.ts builds
 * from the arguments; only the changed parts are looked at.
 *   - labels: `labels`, plus `status` because the triage status follows the labels;
 *   - assignees: `assignees`;
 *   - state (close): `state`, plus `status` for the same reason.
 * A field the backend did not return is left out; nothing is invented.
 */
export function receiptTicketOf(readBack: UnknownRecord | null | undefined, key: string, wants: Readonly<Record<string, boolean>>): UnknownRecord | null {
  if (!readBack) return null
  const out: UnknownRecord = { key: readBack.key === undefined || readBack.key === null ? key : readBack.key }
  for (const name of IDENTITY_FIELDS) if (readBack[name] !== undefined) out[name] = readBack[name]
  const copy = (name: string): void => { if (readBack[name] !== undefined) out[name] = readBack[name] }
  if (wants.labels) copy('labels')
  if (wants.assignees) copy('assignees')
  if (wants.state) copy('state')
  if (wants.labels || wants.state) copy('status')
  return out
}
