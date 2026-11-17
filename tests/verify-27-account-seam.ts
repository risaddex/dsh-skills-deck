// tests/verify-27-account-seam.ts — the account seam a room asks for its identity (#27, used by #13)
//
// Why this gate exists: the room cannot import the host, so the account it acts as arrives through
// `ctx.accounts.resolve(alias)`, and the alias itself comes from the repository's own declaration.
// Five things would fail silently if that drifted, and each is pinned here:
//   S1  no seam means an environment gap that names the slot, and no request goes out;
//   S2  a resolved account is exactly what the request goes out as, resolved once per backend instance;
//   S3  a refused resolution keeps the account status it was given, translated to the room's kind;
//   S4  the alias comes from `docs/agents/issue-tracker.md`, and `matches` answers from it alone —
//       an unconfigured Linear workspace is claimed so the person is sent to sign in;
//   S5  the declaration parser itself: the section, the three fields, and refusing half a declaration.
//
// Usage: node --import ./scripts/ts-hook.mts tests/verify-27-account-seam.ts
import type { BackendContext, OpContext } from '../src/tracker/contract/contexts.ts'
import type { AccountSeamResult } from '../src/tracker/contract/accounts.ts'
import { createLinearBackend, linearModule } from '../src/tracker/rooms/linear/index.ts'
import { parseBinding } from '../src/tracker/rooms/linear/binding.ts'

let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 400) : '')))
  if (!ok) failed = true
}

const BINDING_DOC = '# Issue tracker: linear\n\nalias: ombrello\nteam: ENG\n'

/** A workspace whose docs hold (or do not hold) the Linear declaration. */
function workspace(doc: string | null) {
  return {
    cwd: '/repo',
    async resolve(rel: string) { return '/repo/' + rel },
    async readText() { if (doc === null) throw new Error('ENOENT'); return doc },
  }
}

/** A context whose channel answers one prepared GraphQL reply and remembers how it was called. */
function ctxWith(accounts: unknown, calls: any[], doc: string | null = BINDING_DOC) {
  return {
    http: {
      async request(req: any) {
        calls.push(req)
        return { status: 200, headers: { forEach() {} }, body: JSON.stringify({ data: { issue: { identifier: 'ENG-1', title: 'A ticket' } } }) }
      },
    },
    fs: workspace(doc),
    cwd: '/repo',
    logEvent: () => {},
    isEnabled: () => false,
    accounts,
  } as unknown as BackendContext
}

async function main(): Promise<void> {
  const handle = { cwd: '', refId: 'ENG' } as any

  console.log('S1 no seam is an environment gap that names the slot')
  {
    const calls: any[] = []
    const backend = createLinearBackend(ctxWith(undefined, calls))
    const answer: any = await backend.get(handle, 'ENG-1', {}, ctxWith(undefined, calls) as any)
    check(answer.ok === false && answer.error.kind === 'env', 'a missing seam fails as env', answer.ok ? 'ok' : answer.error.kind)
    check(String(answer.error.message).includes('ctx.accounts'), 'the message names the slot that is missing', String(answer.error.message))
    check(calls.length === 0, 'no request goes out without an account', String(calls.length))
  }

  console.log('S2 the resolved account is what the request goes out as')
  {
    const calls: any[] = []
    let resolutions = 0
    const seam = {
      resolve: async (): Promise<AccountSeamResult> => {
        resolutions += 1
        return { ok: true, alias: 'ombrello', authorization: 'Bearer tok', endpoint: 'https://api.linear.app/graphql' }
      },
    }
    const ctx = ctxWith(seam, calls)
    const backend = createLinearBackend(ctx)
    const first: any = await backend.get(handle, 'ENG-1', {}, ctx as any)
    check(first.ok === true && first.data.key === 'ENG-1', 'a resolved account lets a read through', first.ok ? first.data.key : JSON.stringify(first.error))
    check(calls.length === 1 && calls[0].headers.Authorization === 'Bearer tok', 'the request carries the resolved Authorization', calls[0] ? calls[0].headers.Authorization : '(none)')
    check(calls[0] && calls[0].url === 'https://api.linear.app/graphql', 'the request goes to the resolved endpoint', calls[0] ? calls[0].url : '(none)')
    const second: any = await backend.get(handle, 'ENG-1', {}, ctx as any)
    check(second.ok === true && resolutions === 1, 'one backend instance resolves the account once', String(resolutions))
  }

  console.log('S3 a refused resolution keeps the status it was given')
  {
    const calls: any[] = []
    const seam = { resolve: async (): Promise<AccountSeamResult> => ({ ok: false, status: 'needs_auth', message: 'the Linear account needs a new token' }) }
    const ctx = ctxWith(seam, calls)
    const backend = createLinearBackend(ctx)
    const answer: any = await backend.get(handle, 'ENG-1', {}, ctx as any)
    check(answer.ok === false && answer.error.kind === 'auth', 'needs_auth becomes the room\'s auth kind', answer.ok ? 'ok' : answer.error.kind)
    check(String(answer.error.message).includes('needs a new token'), 'the refusal keeps the reason it was given', String(answer.error.message))
    check(calls.length === 0, 'a refused account sends no request', String(calls.length))
  }

  console.log('S4 the alias comes from the declaration, and matches answers from it alone')
  {
    const seen: string[] = []
    const seam = { resolve: async (alias: string): Promise<AccountSeamResult> => { seen.push(alias); return { ok: true, alias, authorization: 'lin_api_key', endpoint: 'https://api.linear.app/graphql' } } }
    const ctx = ctxWith(seam, [])
    await createLinearBackend(ctx).get(handle, 'ENG-1', {}, ctx as any)
    check(seen.length === 1 && seen[0] === 'ombrello', 'the alias in the document is the alias asked for', JSON.stringify(seen))

    const claimed = await Promise.resolve((linearModule.matches as any)(handle, ctxWith(seam, []) as unknown as OpContext))
    check(claimed === true, 'a workspace with the declaration is claimed', String(claimed))
    const notClaimed = await Promise.resolve((linearModule.matches as any)(handle, ctxWith(seam, [], null) as unknown as OpContext))
    check(notClaimed === false, 'a workspace with no declaration is not claimed', String(notClaimed))
  }

  console.log('S5 the declaration parser refuses anything that is not a whole declaration')
  {
    const full = parseBinding(BINDING_DOC)
    check(full !== null && full.alias === 'ombrello' && full.team === 'ENG', 'the section and its fields are read', JSON.stringify(full))
    check(parseBinding('# Issue tracker: GitHub\n\nalias: x\n') === null, 'a GitHub workspace names no Linear account')
    check(parseBinding('# Issue tracker: linear\n\nteam: ENG\n') === null, 'a declaration without an alias is refused, not half-read')
    check(parseBinding('# Issue tracker: linear\n\nAlias: ombrello\n') !== null, 'the field names are case-insensitive', 'ok')
  }

  console.log('\n' + (failed ? 'FAIL' : 'PASS') + ' ' + total + ' assertions')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
