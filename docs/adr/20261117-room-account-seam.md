# ADR 20261117 · A room asks a host seam for its account, using the alias its own declaration names

> Date: decided 2026-11-17 on ticket #27; this document records that decision as one page.
> Status: the single source for "how a room learns which account it acts as, and why that way".
> Related: #27 (the decision and its closing record), #13 (the Linear room that needs it), #19 (sign-in),
> `src/tracker/contract/accounts.ts` (the shape), `src/host/linearAccounts.ts` (the implementation),
> `src/tracker/rooms/linear/binding.ts` (who names the account), `tests/verify-27-account-seam.ts`.

## 1. The gap

Credential resolution lives in the host: `src/host/linearAccounts.ts` reads the account document and
asks the credential store for the token. A room may not import the host, and `BackendContext` had no
member that hands a room an account, so the Linear room answered every operation with an environment
gap while knowing perfectly well how to speak GraphQL.

## 2. The decision

`BackendContext` gains an optional `accounts: AccountSeam`; its shape lives in
`src/tracker/contract/accounts.ts`, beside `outbound.ts`, so the contract keeps one home per capability:

```ts
interface AccountSeam { resolve(alias: string, signal?: AbortSignal): Promise<AccountSeamResult> }
type AccountSeamResult =
  | { ok: true; alias: string; authorization: string; endpoint?: string }
  | { ok: false; status: 'needs_auth' | 'identity_mismatch' | 'error' | 'unconfigured'; message: string }
```

Five properties are deliberate:

- **A ready header crosses the boundary, never a token.** The room puts `authorization` in a request
  and never learns where it came from. Renewal is the host's and the sign-in flow's business.
- **The room names the account and the host resolves it.** Which account a workspace uses is the
  repository's declaration (`docs/agents/issue-tracker.md`, `# Issue tracker: linear`, with an
  `alias:` line), not host configuration. The room reads its own declaration and passes the alias.
- **Failure speaks the account's four statuses**, because the next action differs per status: sign
  in, confirm the organization, read the error, or configure one. The room translates that to its
  own `auth` / `env` kinds for the layer above.
- **Resolution is per call and cached by (alias, token).** A value handed over once in `create()`
  would age: OAuth tokens expire, and an expired token looks to the room exactly like a revoked one.
- **The identity probe runs once per process per (alias, token) through `ctx.http` with bucket
  `probe`, never the global `fetch`, and runs again when the token changes** — which is what a
  sign-in produces. Without it, a token pasted from another organization returns that organization's
  issues and looks like success.

## 3. Where the implementation sits

`createLinearAccountSeam` lives in `src/host/linearAccounts.ts`, beside the reader and resolver it
uses: a separate host module would add two `same-layer-import-host` edges that
`tests/verify-dependency-rules.ts` only lets decrease. It is injected at the same assembly points as
the HTTP channel, through `src/refresh/rooms/host/room-host-services.ts`, and it reuses the room's
channel for the probe so the outbound gate accounts for it.

## 4. What the room does with it

`createLinearBackend(ctx)` reads the declaration, resolves the named alias lazily, and remembers the
result for the lifetime of that backend instance. `matches` answers from the declaration alone: a
workspace that declares Linear but has no usable account is claimed, then fails with the sentence
that sends the person to sign in, instead of looking like a repository that is not Linear.

## 5. What this decision does not cover

Several accounts in one workspace (the seam already takes an alias, so choosing a different one is a
caller change), and the metadata #14 needs (`teams`, `reviewPattern`, `reviewScope`), which arrives
as an added field on the success shape rather than a change of shape.

## 6. How it is held in place

`tests/verify-27-account-seam.ts` pins the five silent failures: no seam means `env` with no request;
a resolved account is what the request goes out as, resolved once; a refusal keeps its status and
sends nothing; the alias comes from the declaration and `matches` answers from it alone; and the
parser refuses half a declaration.
