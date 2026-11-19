/**
 * src/tracker/rooms/linear/binding-write.ts — build and merge the `# Issue tracker: linear` section (#65)
 *
 * The plugin never writes the binding file itself (the repository's "no write-back" rule stays). This file is
 * the pure core of option C: it renders the exact section text for a chosen alias and computes what
 * `docs/agents/issue-tracker.md` has to contain afterwards. The setup prompt hands that exact text to the
 * agent, and the gate runs every result back through `parseBinding`, the same reader the room uses.
 *
 * Three rules that must not change:
 *  1. Optional `team:` and `project:` lines are left out when empty. The repository template writes the
 *     literal `(optional)` after `project:`, and `parseBinding` would read that as a project called "(optional)".
 *  2. Everything outside the Linear section stays byte for byte as it was (including CRLF line endings).
 *  3. A result that `parseBinding` does not read back with the chosen alias is an error, never a result.
 */
import { parseBinding } from './binding.js'

/** What the section is made of: the alias is required, the other two are optional. */
export interface BindingSectionInput {
  alias: string
  team?: string
  project?: string
}

/** The alias shape the account listing already enforces (see listConfiguredAccounts): lower-case start, then letters, digits and hyphens. */
const ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/

/** The heading text `parseBinding` recognises, written the way the repository template writes it. */
export const BINDING_HEADING = '# Issue tracker: linear'

/** One optional value: trimmed; empty means "leave the line out"; a line break would break the section apart, so it is refused. */
function optionalValue(name: string, value: string | undefined): string {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (/[\r\n]/.test(text)) throw new Error('the Linear binding ' + name + ' must be a single line')
  return text
}

/**
 * The exact section text for a chosen alias, always ending with one line break.
 * Refuses an alias outside the account-name pattern and values that span several lines.
 */
export function renderBindingSection(input: BindingSectionInput): string {
  const alias = String(input && input.alias !== undefined && input.alias !== null ? input.alias : '').trim()
  if (!ALIAS_PATTERN.test(alias)) throw new Error('the Linear binding alias must be an account name: lower-case letters, digits and hyphens, starting with a letter')
  const team = optionalValue('team', input.team)
  const project = optionalValue('project', input.project)
  const lines = [BINDING_HEADING, '', 'alias: ' + alias]
  if (team) lines.push('team: ' + team)
  if (project) lines.push('project: ' + project)
  return lines.join('\n') + '\n'
}

/** A line of the existing file with its offsets, so the text outside the section can be copied by slicing, not by re-joining. */
interface FileLine { start: number; end: number; text: string }

function linesOf(text: string): FileLine[] {
  const out: FileLine[] = []
  let pos = 0
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    const end = nl < 0 ? text.length : nl + 1
    out.push({ start: pos, end, text: text.slice(pos, end).replace(/\r?\n$/, '') })
    pos = end
  }
  return out
}

/** Heading title in the same normal form `parseBinding` compares, or null when the line is not a heading. */
function headingTitleOf(line: string): string | null {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  return heading ? heading[2].replace(/\s+/g, ' ').trim().toLowerCase() : null
}

/**
 * What `docs/agents/issue-tracker.md` has to contain after the Linear section is written.
 *
 * - `existing` is null or blank (no file yet): the file is just the section.
 * - No Linear heading: the section is appended after one blank line; every existing byte stays.
 * - A Linear heading (case-insensitive, like `parseBinding`): only that section is replaced, from its heading
 *   up to the next heading of any level (the same boundary `parseBinding` stops at). Counter-example: replacing
 *   up to the next heading of the same level would swallow a `## sub-heading` that `parseBinding` already treats
 *   as the end of the section.
 * Line endings follow the existing file: if it uses CRLF the section is written with CRLF.
 */
export function mergeBinding(existing: string | null, section: string): string {
  const wanted = parseBinding(section)
  if (!wanted) throw new Error('the section to write is not a valid Linear binding')
  const base = existing === null || existing === undefined ? '' : String(existing)
  const eol = base.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const block = (section.endsWith('\n') ? section : section + '\n').replace(/\r?\n/g, eol)
  let out: string
  if (!base.trim()) {
    out = block
  } else {
    const lines = linesOf(base)
    const first = lines.findIndex((l) => headingTitleOf(l.text) === 'issue tracker: linear')
    if (first < 0) {
      const endsBlank = /(\r?\n){2}$/.test(base)
      const endsLine = /\n$/.test(base)
      out = base + (endsLine ? '' : eol) + (endsBlank ? '' : eol) + block
    } else {
      const next = lines.findIndex((l, i) => i > first && headingTitleOf(l.text) !== null)
      const before = base.slice(0, lines[first].start)
      const after = next < 0 ? '' : base.slice(lines[next].start)
      out = before + block + (after ? eol + after : '')
    }
  }
  const back = parseBinding(out)
  if (!back || back.alias !== wanted.alias) throw new Error('the merged file does not read back as the chosen Linear binding')
  return out
}
