# ADR 20261117 · A room gets the account it acts as through one injected account seam

> Date: decided 2026-11-17, after the maintainer answered five questions on ticket #27.
> Status: this document is the single source for "how does a tracker room get the account it must act as, and why that way".
> Related: #27 (the decision), #13 (the Linear room that needed it), #14 (the account mode that reads the same metadata), #19 (sign-in, which writes the credential this seam reads), #24 and `docs/adr/20261116-room-http-channel.md` (the sibling decision this one copies the shape of), #12 and `research/12-linear-accounts-facts.md` (the resolver this seam wraps).

## 1. Background: the room knows how to talk and nothing to talk as

Credentials live behind the host. A room may not import the host — the dependency rules under `docs/adr/20261014-tracker-room-boundary.md` allow only `src/tracker/contract/`, `src/tracker/kernel/` and `src/shared/`. The DSH credential store is not a file a room can open: a record is read through the host's `ctx.get('credentials')`, and the token behind it has exactly one holder.

The Linear room landed (pull request #26) with that gap open on purpose: `createLinearBackend(ctx, account)` already takes an account, `src/tracker/rooms/linear/client.ts` already types it as `{alias, endpoint, authorization}` and states that the account layer assembles the header — but nothing ever calls the factory with one, so `resolveAccount()` returns `null` and every operation fails as an environment gap.

That was not theoretical. While this ticket was being decided, the maintainer pinned this workspace to the Linear backend (`docs/agents/workspace.yaml`, `backendId: linear`, `source: user`) and every operation that resolves a tracker session stopped working: `deck_map_snapshot` and `deck_issue_get` on that workspace answered "the Linear account is not wired yet" while GitHub tickets kept reading fine through the paths that do not resolve a session. A pinned backend does not consult `matches`, so the room is used whether or not it can claim anything — which makes "fail legibly when no account resolves" a present requirement rather than a future one.

## 2. Decision

**A room gets the account it acts as from one capability on `BackendContext`, `accounts`, which the host implements and injects at the same three points as the other process-level capabilities.**

The decision has five parts, and each one was a question on the ticket.

1. **The seam is a method, not a value resolved at creation.** `ctx.accounts.resolve(request)` is called when an operation needs an account. A value handed over in `create()` would age: an OAuth access token expires mid-session, and a token that expired is indistinguishable, at the room, from a token that was revoked. The method also keeps `create()` uniform across rooms.

2. **The room names the account; the host never learns about project bindings.** The binding is a repository declaration — `docs/agents/issue-tracker.md` with an `# Issue tracker: linear` heading and alias / team / optional project lines (#13) — so the room reads it with the file service it already has, and asks the seam to resolve *that alias*. The format of the declaration is the room's own contract; the host stays free of per-repository knowledge, and #14's "accounts reachable from this project" is a read of the same declaration rather than a second source.

3. **What crosses the boundary is a ready header, never a token.** A successful resolution gives `{ok: true, alias, authorization, endpoint?}` — the value the room's own `LinearAccount` already expects. A failed one gives `{ok: false, status, message}` using the statuses the account layer already speaks (`ok`, `needs_auth`, `identity_mismatch`, `error`, `unconfigured`). Building the header (a personal API key bare, every OAuth token with `Bearer`) stays on the account side, where the auth type is known; the room never assembles it and never sees the token. The account metadata #14 will need (`teams`, `reviewPattern`, `reviewScope`) is not in this shape yet: it arrives later as an added `payload` field, so the contract grows one optional field instead of changing shape.

4. **`matches` answers from the declaration alone.** A workspace with an `# Issue tracker: linear` declaration is Linear's, even when no credential can be resolved; the operation then fails with the sentence that sends the person to sign-in (#19). `src/tracker/contract/backend-module.ts` describes `matches` as a heuristic over files and configuration, with a timeout and "when unsure answer false", so it is not the place to resolve a credential or reach the network. The alternative — refusing to claim until a credential resolves — is what the room does today, and it makes an unconfigured workspace look like a repository that is not Linear at all.

5. **The identity probe runs once per process and per (alias, token), through the room's HTTP channel.** Resolving the token is local and cheap, so it happens on every call. The identity probe is a network request, so its result is kept in the host for the life of the process, keyed by the alias and a hash of the token: when the token changes — which is what happens after a sign-in — the probe runs again. The probe goes through the injected `HttpChannel` with bucket `probe` instead of the global `fetch` the host uses today, so it counts against the outbound gate and the cooldown like every other outbound call. The probe is not optional: without it, a token pasted from another Linear workspace returns issues from that other workspace and looks like success, which is exactly the failure the pinned-organization rule from #12 exists to catch.

## 3. Why not the alternatives

| Option | Why it was not chosen |
| --- | --- |
| The assembly point resolves the account and passes it to `create(ctx, account)` (option B on the ticket) | No contract change, but it carries the same ageing problem as a value at creation, and it ends with the registry knowing that Linear authenticates differently from GitHub and GitLab — the per-backend branch the contract exists to avoid. |
| The room reads the account document and resolves the token itself (option C) | The credential store is not a file the room may read; only `LINEAR_KEY_<ALIAS>` lives in the environment, and that covers one of the three auth types. This route would also put a token inside the room, where nothing else has one. |
| The host decides which account this workspace uses | It would put the format of a repository file inside the host, duplicate a read the room already does, and make a binding change require a host release. |
| One global default account, as the plugin this fork replaces does | It is what makes multi-workspace setups ambiguous: with one `defaultAccount`, the alias stops being a fact about the project and every workspace acts as the same organization. |
| No identity probe on the data path at all | Zero extra requests, but a token from another organization would silently act on the wrong workspace. The probe is what makes the pinned-organization rule real rather than aspirational. |
| Probe on every resolve | The simplest rule to state, and the wrong cost: a single read becomes two requests, and the outbound gate fills with probes. |
| A fixed ten-minute probe cache, as the plugin this fork replaces does | Bounded staleness and no per-token key, so a fresh sign-in can sit behind a stale probe result for up to ten minutes. Keying on (alias, token) refreshes exactly when something changed. |

## 4. Consequences

- The contract gains one required member, `accounts`, on `BackendContext`. Its shapes (`AccountRequest`, `AccountResolution`) live in a new `src/tracker/contract/accounts.ts`, following `src/tracker/contract/outbound.ts`, so the type-only rule for the contract layer holds and `contexts.ts` grows one import line and one member rather than a block of new types.
- A missing seam is a wiring mistake and fails loudly, like a missing `http` or `outbound`.
- The seam is injected at the same three points as the HTTP channel — `src/host/platformChannel.ts`, `src/refresh/registry/deck-tool-bridge.ts` and `src/refresh/rooms/host/refresh-runtime.ts` — and all three import it from `src/refresh/rooms/host/room-host-services.ts`. Those three files sit at the effective-line ceiling `tests/verify-file-granularity.ts` enforces, which is why a capability is added through the re-export module and not by growing them.
- `createLinearBackend` loses its second parameter: the binding is read once when the room is created, and each operation resolves the credential through the seam. The call site in `src/tracker/registry/builtins.ts` therefore stops knowing anything about accounts.
- The host's probe helper (`probeLinearIdentity` in `src/host/linearAccounts.ts`) keeps its injectable transport so a gate can run without a network, but the production path becomes the injected channel instead of the global `fetch`.
- One new gate, `tests/verify-27-account-seam.ts`, mirroring `tests/verify-24-http-channel.ts`: the seam is injected at all three points from the re-export module; the room never imports the host; what the room receives carries no token; a failed resolution is classified rather than thrown; the probe cache re-probes when the token changes and does not re-probe when it does not; the seam reaches the network only through the channel; and `matches` makes no network call.
- Any future backend with accounts reuses this seam with its own alias instead of opening a second road to the credential store.
