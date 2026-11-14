/**
 * src/shared/version-control/src/parse-refs.ts —— for-each-ref 本地分支解析
 *
 * 每行一条、字段间 %00（NUL）、行尾换行。八字段固定（#1883 在末尾追加了提交主题，前七段不动）：
 * refname / short / objectname / upstream:short / upstream:track / HEAD / committerdate:iso-strict /
 * contents:subject。
 * upstream:track 空=无上游；[ahead N]/[behind N]/[ahead N, behind M]；[gone]=上游被删（单独处理）。
 * %(HEAD) 当前分支是 `*`，其余是空格（trim 后判）。哈希 40 或 64 位十六进制，不写死 40。
 * 第八段是分支顶上那次提交的主题（git 的 %(contents:subject) 只给第一行，不含正文）。它可能为空
 * （对象不是提交这类极端情况），空串照常收下、不判坏行——界面没有主题时只画时间，不画占位。
 * 字段数不是 8 一律整份失败：命令与解析同属一个被测单元（见 commands.ts 头注释），
 * 段数对不上说明两边的口径已经错位，不能把错位的数据当半份结果交出去。
 */
import type { ParseFailure } from './ports.js'

export interface RefRecord {
  ref: string
  short: string
  oid: string
  upstream: string | null
  upstreamGone: boolean
  ahead: number
  behind: number
  current: boolean
  commitDateMs: number
  /** 这条分支顶上那次提交的主题（第一行）；读到空串表示 git 没给，不是解析失败。 */
  subject: string
}

export type RefsResult = { ok: true; refs: RefRecord[] } | ParseFailure

function fail(detail: string): ParseFailure {
  return { ok: false, error: 'refs-malformed', detail }
}

function parseTrack(track: string): { gone: boolean; ahead: number; behind: number } | null {
  if (track === '') return { gone: false, ahead: 0, behind: 0 }
  if (track === '[gone]') return { gone: true, ahead: 0, behind: 0 }
  let m = /^\[ahead (\d+)\]$/.exec(track)
  if (m) return { gone: false, ahead: Number(m[1]), behind: 0 }
  m = /^\[behind (\d+)\]$/.exec(track)
  if (m) return { gone: false, ahead: 0, behind: Number(m[1]) }
  m = /^\[ahead (\d+), behind (\d+)\]$/.exec(track)
  if (m) return { gone: false, ahead: Number(m[1]), behind: Number(m[2]) }
  return null
}

export function parseRefs(stdout: string): RefsResult {
  const text = String(stdout)
  if (text === '') return { ok: true, refs: [] }
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const out: RefRecord[] = []
  for (const ln of lines) {
    const parts = ln.split('\0')
    if (parts.length !== 8) return fail('field count is not 8')
    const [ref, short, oid, upstreamShort, trackRaw, headMark, dateRaw, subject] = parts
    if (!ref.startsWith('refs/heads/')) return fail('refname is not under refs/heads')
    if (!short) return fail('short is empty')
    if (!/^[0-9a-f]{40}$/.test(oid) && !/^[0-9a-f]{64}$/.test(oid)) return fail('objectname is not a hash')
    const track = parseTrack(trackRaw)
    if (!track) return fail('unknown upstream:track value')
    const head = headMark.trim()
    if (head !== '' && head !== '*') return fail('HEAD field is neither an asterisk nor empty')
    const ms = Date.parse(dateRaw)
    if (Number.isNaN(ms)) return fail('committerdate is not an ISO date')
    out.push({
      ref, short, oid, upstream: upstreamShort === '' ? null : upstreamShort,
      upstreamGone: track.gone, ahead: track.ahead, behind: track.behind,
      current: head === '*', commitDateMs: ms, subject: subject,
    })
  }
  return { ok: true, refs: out }
}

export const PARSE_REFS_SOURCE = 'src/shared/version-control/src/parse-refs.ts'
