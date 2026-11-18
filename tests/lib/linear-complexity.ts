// tests/lib/linear-complexity.ts: an estimate of the complexity Linear gives a GraphQL query, by the rule Linear publishes.
//
// Why this exists: Linear rejects any single query above 10,000 points, and a rejected list query would blank the whole panel list.
// Pagination defaults to 50 when `first` is not written, so adding a nested connection without an explicit `first` is enough to go over.
// The rule (https://linear.app/developers/rate-limiting, section "Understanding query complexity", read 2026-11-18): each property costs
// 0.1 point, each object 1 point, and a connection multiplies the points of what is inside it by its `first`/`last` (default 50); the
// score is rounded up. The three worked examples on that page (2, 66 and 14) are checked by the gate that uses this file, so the
// estimator is calibrated against Linear's own numbers and not against this repository's reading of them.
// Scope: the subset of GraphQL the Linear room writes: one operation, named fragments and spreads, arguments with literal numbers or
// variables, no aliases, no inline fragments, no directives. It throws on anything else instead of guessing.

type Field = { name: string, args: string, sub: Field[] | null, spread?: string }

const DEFAULT_PAGE = 50

function tokenize(text: string): string[] {
  const out = text.match(/\.\.\.\s*[A-Za-z_]\w*|"[^"]*"|\$?[A-Za-z_]\w*|-?\d+(?:\.\d+)?|[{}():,!\[\]=]/g)
  if (!out) throw new Error('linear-complexity: nothing to read')
  return out.map((t) => t.replace(/^\.\.\.\s*/, '...'))
}

/** Reads one selection set starting after its `{`; returns the fields and the index after the closing `}`. */
function readSelection(tokens: string[], start: number): { fields: Field[], next: number } {
  const fields: Field[] = []
  let i = start
  while (i < tokens.length && tokens[i] !== '}') {
    const tok = tokens[i]
    if (tok.startsWith('...')) { fields.push({ name: tok, args: '', sub: null, spread: tok.slice(3) }); i += 1; continue }
    if (tok === ',' ) { i += 1; continue }
    if (!/^[A-Za-z_]/.test(tok)) throw new Error('linear-complexity: unexpected token ' + tok)
    const field: Field = { name: tok, args: '', sub: null }
    i += 1
    if (tokens[i] === '(') {
      let depth = 0
      const begin = i
      for (; i < tokens.length; i += 1) { if (tokens[i] === '(') depth += 1; else if (tokens[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break } } }
      field.args = tokens.slice(begin + 1, i - 1).join(' ')
    }
    if (tokens[i] === '{') { const inner = readSelection(tokens, i + 1); field.sub = inner.fields; i = inner.next + 1 }
    fields.push(field)
  }
  return { fields, next: i }
}

function pageOf(args: string, vars: Record<string, number>): number {
  const m = /\b(?:first|last)\s*:?\s*(\$?[A-Za-z_]?\w*)/.exec(args.replace(/:/g, ' : '))
  const raw = m ? m[1] : ''
  if (!raw) return DEFAULT_PAGE
  if (raw.startsWith('$')) { const v = vars[raw.slice(1)]; if (typeof v !== 'number') throw new Error('linear-complexity: no value for variable ' + raw); return v }
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_PAGE
}

/** The estimated complexity of `doc` when its variables have the values in `vars`. */
export function complexityOf(doc: string, vars: Record<string, number> = {}): number {
  const fragments: Record<string, Field[]> = {}
  let rest = doc
  const fragRe = /fragment\s+(\w+)\s+on\s+\w+\s*\{/
  for (let m = fragRe.exec(rest); m; m = fragRe.exec(rest)) {
    const open = m.index + m[0].length
    const inner = readSelection(tokenize(rest.slice(open - 1)), 1)
    fragments[m[1]] = inner.fields
    let depth = 0
    let end = open - 1
    for (; end < rest.length; end += 1) { if (rest[end] === '{') depth += 1; else if (rest[end] === '}') { depth -= 1; if (depth === 0) break } }
    rest = rest.slice(0, m.index) + rest.slice(end + 1)
  }
  const header = /^\s*(?:query|mutation)\b[^{]*\{/.exec(rest)
  const bodyStart = header ? header[0].length : rest.indexOf('{') + 1
  const root = readSelection(tokenize(rest.slice(bodyStart - 1)), 1).fields

  const costOf = (fields: Field[]): number => {
    let total = 0
    for (const f of fields) {
      if (f.spread) { const frag = fragments[f.spread]; if (!frag) throw new Error('linear-complexity: unknown fragment ' + f.spread); total += costOf(frag); continue }
      if (!f.sub) { total += 0.1; continue }
      const nodes = f.sub.find((s) => s.name === 'nodes')
      if (nodes && nodes.sub) {
        const others = f.sub.filter((s) => s !== nodes)
        total += pageOf(f.args, vars) * (1 + costOf(nodes.sub)) + costOf(others)
      } else {
        total += 1 + costOf(f.sub)
      }
    }
    return total
  }
  return Math.ceil(Math.round(costOf(root) * 1000) / 1000)
}
