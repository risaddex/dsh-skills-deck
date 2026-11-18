# ADR 20261118 · Linear is a built-in room speaking native GraphQL, bound by a repository declaration and acting through credential records

> Date: recorded 2026-11-18. The decisions were taken between 2026-11-13 and 2026-11-17, in the design session (grilling rounds 1–5) and on tickets #12, #13, #19, #24, #27 and #33.
> Status: accepted. This document is the single source for "what the Linear backend is, how it maps the deck's model onto Linear, and how it holds credentials", and it is the second of the three founding ADRs named by the fork map.
> Related: [Wayfinder: dsh-skills-deck — English-first hard fork with a native Linear backend](https://github.com/risaddex/dsh-skills-deck/issues/1); `docs/adr/20261113-hard-fork-dsh-skills-deck.md` (the first founding ADR) and `docs/adr/20261113-english-first.md` (the third); `docs/adr/20261116-room-http-channel.md` and `docs/adr/20261117-room-account-seam.md` (the two boundary decisions this one builds on and does not repeat); #12 (accounts), #13 (the room), #14 (account reads in the deck tools), #19 (sign-in), #33 (creating containers); `research/12-linear-accounts-facts.md`, `research/12-linear-signin-protocol.md` and `research/13-linear-write-mutations.md` (the facts, each with its source).

## 1. Background: one deck, four trackers, and a plugin to retire

The fork's destination is a native Linear backend next to GitHub, GitLab and local Markdown, which also retires `dsh-plugin-linear`. That plugin offered Linear as a separate set of `linear_*` tools and a separate sidebar, kept one default account, and cached the identity check for a fixed ten minutes. The deck already routes every ticket operation through the Tracker contract and one room per backend, so the question was not whether Linear fits that shape but how much of the old plugin's shape to carry into it.

Two questions had to be settled before any Linear code could act, and each has its own ADR: how a room reaches an HTTP-only API (`20261116-room-http-channel.md`) and how a room gets the account it must act as (`20261117-room-account-seam.md`). This ADR records everything else: what the backend is, what each deck concept becomes in Linear, where the credentials live, and how a person signs in.

## 2. Decision

**Linear is the fourth built-in room, `src/tracker/rooms/linear/`. It speaks native GraphQL through the injected HTTP channel, it is bound to a workspace by a declaration in the repository, and the account it acts as is a metadata record plus a secret held in the DSH credential store.**

### 2.1 A room, not a plugin, and one tool surface

The Linear room is registered like the other three: a fourth id in `BUILTIN_ROOM_IDS`, the same position in `MULTI_CLAIM_ORDER`, and a row in the rooms README, all held together by `tests/verify-20-room-list-sync.ts`. The deck has **no `linear_*` tools**. A Linear workspace is read and written with the same `deck_*` tools as any other backend. Reading across accounts is folded into two existing tools: `deck_issue_list` accepts an `account` selector (an alias, or `*` for every account reachable from the project) and `scope: assigned | review`, and `deck_issue_get` takes an account-qualified key such as `alias:ENG-123`; a bare key keeps the bound backend. There is no separate Linear inbox screen: the deck tab's list over the bound backend covers it, and it is relative to the open project only (the maintainer's decision on #14, 2026-11-16).

### 2.2 Native GraphQL, through the channel the room is given

There is no Linear command-line tool to start through `ctx.exec`, and a room may not use the global `fetch`. Every request therefore goes through `ctx.http` with `service: 'linear'`, and the credential comes from `ctx.accounts` (the two ADRs above). Each request leaves one debug-only `linear.request` log line (operation, bucket, outcome, duration, account alias) and never a header, a body, a variable or a full address.

### 2.3 The binding is a repository declaration

A workspace says its tracker is Linear with a `# Issue tracker: linear` section in `docs/agents/issue-tracker.md`, carrying `alias`, `team` (the team key tickets are created in) and an optional `project`. The room reads that section and nothing else: `matches` claims a workspace from it alone, and the alias is what the room hands to the account seam. A section with no alias is not a declaration, so the room treats the workspace as not Linear rather than guessing an account. A workspace without the section never sees the room.

### 2.4 What each deck concept becomes in Linear

| Deck concept | In Linear |
| --- | --- |
| Map | An issue carrying the team label `wayfinder:map`, attached in the same `issueCreate` call, so there is never a moment when it is an ordinary issue. |
| Spec | An ordinary issue whose body header carries `<!-- DSH-ISSUE-KIND: spec -->`. A spec has no label of its own and must never carry `wayfinder:map`; the three other rooms read it through the same shared function, so Linear reads it that way too. |
| Ticket under a map or a spec | A sub-issue. `parentId` is the only way Linear lets a parent be set; children are read through `Issue.children`. |
| Blocked by | Linear's single `blocks` relation, read from two directions. "A blocks B" is written as an `issueRelationCreate` from A to B; "blocked by" is read from `inverseRelations` filtered to `blocks`. Writing an edge that would close a cycle is refused. |
| Labels | Team labels, created on demand. A label belonging to another team is never attached. A label write replaces the whole set through `labelIds`. |
| Close and reopen | There is no close mutation: the room reads the team's workflow states and writes `stateId` with `issueUpdate`. Close is the first `completed` state, reopen is the first `unstarted` state. The states that read as closed are `completed`, `canceled` and `duplicate`. |
| Progress and the maintainer's words | Body sections, exactly as on the other backends. |
| Retry-safe create | The create anchor is the first line of the body. Before creating, the room searches the bound team for open tickets whose description contains the key, and decides only from the anchor read back from each ticket's own text. The server-side `contains` narrows the candidates and is never evidence, because a key `a1` would match a ticket that says `a12`. A look-up that cannot be sure fails with `error.stage = 'anchor-lookup'` and creates nothing. |

### 2.5 Two stores for one account

An account is split by what is secret:

- **Metadata** (alias, label, auth type, the pinned organization id and URL key, team filters, the review-state pattern and scope) lives in its own file, `~/.dsh/mattskillsdeck/linear-accounts.yaml`. It is a file of its own because `settings.yaml` is the strict store of view preferences and cannot hold a list of records; a malformed alias there would also take every preference down with it.
- **The secret** lives in the DSH credential store as the record `skills-deck/linear-<alias>`, of kind `api-key` or `grant`, written only through `modifyRecord`. The record scope is `skills-deck`, not `dsh-skills-deck`, because the platform asks for the plugin's registered name with the `dsh-` prefix removed.

For one account the resolver reads, in order: the stored record, then the environment variable `LINEAR_KEY_<ALIAS>` (kept from the old plugin so an existing setup keeps working), and otherwise reports `needs_auth`. A stored record outranks the environment, which is the platform's own rule for references. The account statuses are the fixed set `ok`, `needs_auth`, `identity_mismatch`, `error` and `unconfigured`; no token value ever appears in a message, a status or an error.

Each account is **pinned to one Linear organization**. The identity check asks which organization a token answers for and compares it with the pin, so a token pasted into the wrong record is refused with `identity_mismatch` instead of silently returning another workspace's issues. The account file also has a `defaultAccount`; the room does not use it. The workspace's own binding names the alias, so that the alias is a fact about the project and not about the machine. There is **no import from the old plugin**: its registry at `~/.config/dsh-linear/accounts.yml` stays on disk, read by nothing, and signing in to the fork starts from scratch.

### 2.6 Three ways to authenticate, one scope

| Auth type | How it signs in | What is kept | What renewal looks like |
| --- | --- | --- | --- |
| `api_key` | A personal API key, sent in `Authorization` bare. | The key, in an `api-key` record. | None: there is no renewal step. |
| `oauth_user` | Authorization code with PKCE S256 and `prompt=consent`. A loopback listener on a port the plugin owns receives the redirect, and the person pastes the code instead when the port is taken. | A `grant` record with the access and refresh tokens. | Single-flight per alias; the rotated grant is saved before it is used; renewal also runs when a request was just refused. |
| `oauth_app` | The client-credentials grant: one secret prompt and one POST, no browser. The agent acts as the installed Linear app. | A `grant` record with the client id and secret and the current token. | There is no refresh token: a new token is requested when the old one nears its 30-day expiry. |

Every OAuth token is sent with `Bearer`; the account side builds the header, never the room. The scope is `read,write` for all of them, with no assignable or mentionable bot.

`oauth_app` uses client credentials rather than the `actor=app` authorization code because the mode exists for an agent with nobody at the keyboard, which is the case Linear's own documentation gives for client credentials. The costs were accepted knowingly:

- Rotating the client secret revokes every token issued, so the account is signed out.
- The token reaches all public teams of the workspace unless access is trimmed on the app page in Linear.
- Every machine using one app must request the identical scope set. Requesting a different one revokes the app's existing tokens in that workspace, which is also why adding a bot scope later would sign both accounts out.
- A person must switch on "client credentials tokens" for the app in Linear once; otherwise the token request is refused and the error says so.

The authorization-code route stays possible later as a second method on the same flow, so choosing client credentials now closes nothing.

## 3. Why not the alternatives

| Option | Why it was not chosen |
| --- | --- |
| Keep `dsh-plugin-linear` as a separate plugin next to the deck | The fork's destination is one deck with Linear inside it, and the map says the fork absorbs and retires the old plugin. It was removed from the monorepo, the index and the profile (#16). |
| Linear as a host-side backend instead of a room | It contradicts the map's decision that Linear is a native backend behind the Tracker contract, and it would move a twenty-four-operation surface outside the room architecture that keeps the deck tools free of per-backend branches (argued on #24, recorded in `docs/adr/20261116-room-http-channel.md`). |
| One default account for the whole machine, as the old plugin did | It makes multi-workspace setups ambiguous: the alias stops being a fact about the project and every workspace acts as the same organization. |
| Metadata and secrets in one place | The platform's credential store is the one holder of a token. Metadata is non-secret and needs a list, which `settings.yaml` cannot hold. |
| A `wayfinder:spec` label for specs | It would make Linear the only room with a different spec rule. The other three read the body marker, and a spec must never carry a map label. |
| Keep refusing the idempotency anchor, as a first draft of the room did | The deck always sends an anchor, so every `deck_issue_create` on Linear would have failed, not only maps. |
| `oauth_app` through the `actor=app` authorization code | A browser step, a loopback listener and a rotating refresh token, duplicating the `oauth_user` machinery for a mode meant to run unattended. |
| Import the old plugin's account registry | Decided against in the design session and restated on #12: there is no import. The old registry stays on disk, read by nothing. |

## 4. Consequences

- A workspace uses Linear exactly when its `docs/agents/issue-tracker.md` says so and a credential resolves for its alias; everything else about the deck's tools is unchanged.
- The credential never crosses into the room: the room receives a ready header or a classified failure. Everything that holds a token lives in `src/host/` and `src/shared/linear-accounts/`.
- The module declares a requests-only budget, and `readBudget` answers `known: false`: Linear limits a single query to 10,000 complexity points, and the room does not account for them. Nothing here pretends to have measured it.
- `create` refuses `assignees` instead of dropping them: resolving them to Linear users is not implemented in the create path, and creating the ticket without them would be a guess.
- The marketplace listing of `dsh-skills-deck` 2.0.0 names the Linear backend, and the old plugin's capability is covered by the deck tools, not by a successor plugin.

## 5. What is not proven

This ADR records decisions and what was built. The following were **not** shown to work, and nothing above should be read as claiming they were:

1. **A real renewal.** The stored tokens last about 30 days, so a renewal against Linear can only be watched near the end of that window. It was tested against stand-ins only.
2. **Writing in more than one workspace.** A real create, comment and close worked in one workspace, as the app user. In the other workspace, the maintainer sent a comment from the panel on 2026-11-18 and the host answered ok (#45), which shows Linear accepted the ticket identifier as `issueId`; the comment itself was not seen inside Linear, and nothing else was written there.
3. **The anchor search against the real API.** The `description contains` filter is documented by Linear but was not run against the real API when the look-up was written (#33).
4. **The `deck_*` agent tools end to end with Linear selected.** The maintainer opened Linear tickets in the live panel on 2026-11-18 and they drew their title, state, labels and description (#45), so the panel path has been seen working; the agent tools have not. #14 delivered the account reads with real-Linear verification unperformed. In the code on `main`, an account-qualified read (`alias:ENG-123`) still does not fetch comments or reverse dependencies and says so in its receipt; the end-to-end behaviour was not re-checked here.
5. **The organization pin is written by hand.** When #19 closed, nothing wrote the pin back into the accounts file after a first successful identity check, and an empty pin cannot produce `identity_mismatch`.
6. **A person starting sign-in.** `oauth_app` sign-in runs from `scripts/linear-app-signin.mts` (see `docs/runbooks/linear-oauth-app-signin.md`). The flows are registered on the DSH authorization seam, but it has not been shown that a person can start them from the panel.
