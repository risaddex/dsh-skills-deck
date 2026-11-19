// src/refresh/rooms/host/linear-binding-phone.ts — the host phone `wf.linearBindingPrompt` (#65, option C)
//
// What it answers: the banner of a Linear workspace without a binding asks "what should I inject?". This phone lists the
// accounts configured on this machine through the account seam (`AccountSeam.list()`, never `resolve`, so no token is
// ever read), keeps only alias / label / teams of each, and returns the finished prompt text built by the Linear room.
//
// Why a host phone and not a field of the panel snapshot (the choice the ticket asked to state): the alias list is only
// needed at the moment of the click, and it reads a file on this machine. A snapshot field would put the account names into
// every snapshot, every cache copy and every log of the snapshot path, for a hint most sessions never open; the client
// would also need a new snapshot slot and a new assembly step. A phone keeps the boundary where it already is: the client
// sends nothing but a language, the host reads the seam and returns text. The prompt text is built on the host side so that
// the client never sees the account list, only the finished sentence.
//
// Rules that must not change:
//  1. Only `alias`, `label` and `teams` leave the seam (the room's `publicAliasesOf` is the single filter).
//  2. A listing failure, a thrown error or a missing seam never blocks the banner: the answer is still the prompt that
//     tells the agent to ask the maintainer, and the seam's own message text is dropped (it could carry anything).
//  3. The room code is reached through the assembly point (src/tracker/registry/builtins.ts) via the `extras` loader
//     the wiring passes in; this file imports nothing at all (the seam and the extras both arrive through deps), which also
//     keeps the host entry file from gaining a same-layer import edge (tests/same-layer-baseline.json only shrinks).
//  4. Log fields follow docs/design/335-logging-contract.md: the existing resident events host.call / host.call.fail, with
//     fields from their allowlist only; account names are never logged.

/** What the phone needs from the Linear room (loaded through the assembly point). */
export interface LinearPromptExtras {
  publicAliasesOf(entries: unknown): Array<{ alias: string; label: string; teams: string[] }>
  buildBindingPrompt(input: { aliases: Array<{ alias: string; label: string; teams: string[] }>; listFailed?: boolean; lang?: string }): string
}

/** The seam shape this file reads: only `list`. */
type ListingSeam = { list?: (signal?: AbortSignal) => Promise<unknown> } | null | undefined

export interface LinearBindingPhoneDeps {
  /** The account seam, or null when this composition has none. Called on every request: nothing is cached across workspaces. */
  seam: () => ListingSeam
  extras: () => Promise<LinearPromptExtras>
  logCtx?: { fire(level: string, event: string, fields?: unknown): void } | null
}

export interface LinearBindingPhoneReply {
  ok: true
  aliases: Array<{ alias: string; label: string; teams: string[] }>
  text: string
}

function hash8(s: unknown): string { try { const t = String(s || ''); let h = 5381; for (let i = 0; i < t.length; i++) h = (((h << 5) + h + t.charCodeAt(i)) >>> 0); return ('0000000' + h.toString(16)).slice(-8) } catch { return '00000000' } }

export function createLinearBindingPhone(deps: LinearBindingPhoneDeps): { handle(args?: { lang?: unknown } | null): Promise<LinearBindingPhoneReply> } {
  const METHOD = 'wf.linearBindingPrompt'
  function fire(level: string, event: string, fields: unknown): void { try { if (deps.logCtx) deps.logCtx.fire(level, event, fields) } catch { /* logging must never break the phone */ } }
  return {
    async handle(args) {
      const t0 = Date.now()
      const lang = args && args.lang === 'zh' ? 'zh' : 'en'
      const room = await deps.extras()
      let entries: unknown = []
      let listFailed = false
      // The reason of a failed listing is recorded as a short code only: the seam's message text is never read.
      let why = ''
      try {
        const seam = deps.seam()
        if (!seam || typeof seam.list !== 'function') { listFailed = true; why = 'no-seam' } else {
          const res = await seam.list() as { ok?: boolean; accounts?: unknown; status?: unknown } | null
          if (res && res.ok === true) entries = res.accounts
          // `unconfigured` means "this machine has no Linear account file", which is the empty list, not a failure.
          else if (res && res.status === 'unconfigured') entries = []
          else { listFailed = true; why = 'status-' + String((res && res.status) || 'unknown').slice(0, 24) }
        }
      } catch { listFailed = true; why = 'threw' }
      const aliases = room.publicAliasesOf(entries)
      const text = room.buildBindingPrompt({ aliases: aliases, listFailed: listFailed, lang: lang })
      // Conclusion line: which way the prompt went, never which accounts. kind carries the branch: one-alias / many / none / list-failed.
      const branch = listFailed ? 'list-failed' : (aliases.length === 1 ? 'one-alias' : (aliases.length > 1 ? 'many-aliases' : 'no-alias'))
      if (listFailed) fire('warn', 'host.call.fail', { method: METHOD, kind: 'linear-binding-list', errorHash: hash8(why) })
      fire('info', 'host.call', { method: METHOD, latencyMs: Date.now() - t0, ok: true, kind: 'linear-binding-' + branch })
      return { ok: true, aliases: aliases, text: text }
    },
  }
}
