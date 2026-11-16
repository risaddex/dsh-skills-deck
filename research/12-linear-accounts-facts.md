# Linear accounts — facts (map ticket #12, accounts half)

Serves map ticket #12 of "Wayfinder: dsh-skills-deck — English-first hard fork with a native Linear
backend": the account registry, credential records, settings seam and identity pinning. The sign-in and
Linear-API half is the sibling `research/12-linear-signin-protocol.md`. Ranges are 1-based lines.

`CR`=`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-credentials`,
`CRL`=`…/dsh-credentials-local`,
`DSH`=`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`,
`L`=`/Users/danilo/Documents/deepseek-harness/default-workspace/dsh-plugins/packages/dsh-plugin-linear/lib`,
`SET`=`src/shared/config-store/src/settings.ts`, `CS`=`src/host/configStore.ts`.
Tags: `CID`=CR/lib/types/index.d.ts, `CTY`=CR/lib/types/types.d.ts,
`CIJ`=CR/lib/types/index.js, `CLR`=CRL/README.md, `Ln`=L/registry-normalize.js,
`Lc`=L/credentials.js, `Lg`=L/gateway.js, `Lr`=L/registry.js,
`Lrf`=L/registry-file.js, `Lq`=L/queries.js, `Lcf`=L/config.js,
`Lse`=L/service-error.js, `Lsl`=L/service-login.js, `Lsa`=L/service-account.js,
`Lgr`=L/grants.js.

## A. The DSH credentials seam (records)

- **Key.** `<scope>/<id>`, both segments `/^[a-z][a-z0-9-]*$/` (`CIJ:14`);
  `credentialKey` throws `TypeError` on a bad segment, `parseCredentialKey` needs exactly
  two, `credentialKeyScope` / `credentialKeyId` split one (`CID:39-69`). References are
  the disjoint POSIX space `/^[A-Za-z_][A-Za-z0-9_]*$/` (`CIJ:12`; `CTY:13-25`).
- **Scope a plugin passes.** "the owning plugin's registered name, such as `llm-pi-ai`"
  (`CID:39-43`), because payloads are owner-format and orphan records must stay recognisable
  (`CTY:15-25`); nothing verifies the scope is mounted (`CR/README.md:178`). Shipped plugins
  drop the `dsh-` prefix: `client-connection` (`DSH/dsh-client-connection/lib/index.js:273`),
  `llm-pi-ai` (`DSH/dsh-llm-pi-ai/lib/index.js:2040`), `deepseek-account-platform`
  (`DSH/dsh-deepseek-account-platform/lib/types/index.js:13-14`). This repo's package is
  `dsh-skills-deck`, so the convention gives `skills-deck`; `dsh-skills-deck` is also
  legal.
- **Kinds — exactly two** (`CTY:33-54`). `'api-key'`: optional `key` (non-empty secret) and
  optional `env` mapping POSIX names to values, so environment values can ride in a record; neither
  field means the owner confirmed ambient auth (`CTY:26-39`). `'grant'`: `payload: unknown`,
  opaque, must survive a JSON round trip (`CTY:41-52`). Presence is the whole fact — the reference
  empty-value rule does not apply and a payload returns exactly as written (`CR/README.md:116,127`).
- **Ops** (`CID:120-191`). `readRecord` → record or `undefined`; `describeRecord` →
  `{configured,kind?,writable}`; `listRecords` → `{key,kind}[]`; `deleteRecord`
  no-op when absent; `modifyRecord(key,mutate)` is the only write path — `mutate` sees the
  record as of the exclusive write, returning `undefined` writes nothing, and the call returns the
  stored record; a commit fires `credentials/record-updated(key)` (`CTY:68-92`).
- **File.** `<harness home>/.credentials.yaml`, home = `$DSH_HOME` or `~/.dsh`; the base
  composition passes no `path`; one document holds `refs:` and `records:`
  (`CLR:42-47,84-107`; `DSH/dsh-base/cordis.patch.yml:125-126`). Here:
  `/Users/danilo/.dsh/.credentials.yaml`, mode `0600` (observed).
- **Absence.** A missing record reads `undefined` / `configured:false` and `modifyRecord`
  may create it; a missing file is not an error, an untrusted file refuses to load, and a failed live
  reload keeps the last good snapshot (`CLR:109-121`).
- **Per machine, not per profile:** the path hangs off the harness home, not
  `~/.dsh/profiles/<profile>` (`CLR:44-45`).
- **Two processes, one record.** Safe: `modifyRecord` is a serialized read-modify-write under the
  cross-process writer lock (`CLR:149-151,198`) — the refresh-token case (`CR/README.md:127`).
  Two writers on one *reference* are last-write-wins; a same-UID process can read the file
  (`CLR:198-199`).

## C. The old plugin's registry, credentials, pinning and errors

- **Document.** `version:1`, `defaultAccount`, `accounts[]` (`Ln:280-304`); a wrong
  version or missing `accounts` is an error, an unmatched `defaultAccount` only warns
  (`Ln:26,290-302`). Account:
  `{alias,displayName,orgId,urlKey,teams,auth:{type,tokenRef},previousAliases}` (`Ln:255-266`).
- **Alias.** `^[a-z][a-z0-9-]{1,15}$`, lowercased, unique (`Ln:20,54-65,232-242`); two aliases on
  one `orgId` → `duplicate_org`, never a merge (`Ln:243-251`).
  `previousAliases:[{alias,until}]` drops bad or expired entries with a warning and resolves a live
  one with a warning (`Ln:146-173,332-341`).
- **`tokenRef` forms.** `env:NAME` (POSIX name), `file:PATH` (`~` expanded; wider
  than `0600` warns but passes; missing file → `NEEDS_AUTH`), `plain:TOKEN`
  (`apikey:`/`api_key:` synonyms; a bare `apiKey:` becomes `plain:`); anything else →
  `UNSUPPORTED_CREDENTIAL` naming the three (`Lc:8-16,118-129,185-259`; `Ln:194-203`).
- **Precedence.** Accounts: inline `accountsYaml` → accounts file → `LINEAR_KEY_<ALIAS>`
  environment accounts (`Lr:64-66,141-185`). Path: `registryPath` setting →
  `DSH_LINEAR_REGISTRY` → `~/.config/dsh-linear/accounts.yml` (`%APPDATA%` on Windows)
  (`Lcf:31,52-55,184-191`). The environment convention only creates accounts when no document
  exists, so it is never a per-account fallback; its suffix becomes the alias lowercased with
  `_`→`-`, invalid ones skipped (`Lcf:194-214`; `Lr:181-185`). OAuth settings
  override from `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`,
  `LINEAR_OAUTH_REDIRECT_PORT` (`Lcf:41-50,301-316`).
- **Auth types.** Only `AUTH_TYPES=['api_key','oauth_user']` (`Ln:24`); `oauth` reads as
  `oauth_user` and everything else as `api_key`, and a `tokenRef` on an
  `oauth_user` account is ignored with a warning because those tokens live in the grant store
  (`Ln:73-76,188-192`).
- **Pinning and mismatch.** The probe is
  `viewer{id name displayName email organization{id name urlKey}}` (`Lq:48-56`), cached ten
  minutes (`Lg:44-45,317-342`). With no `orgId` the host writes the probed `orgId` and
  `urlKey` back (atomic, `0600`, file-backed registries only) (`Lr:274-287`;
  `Lrf:228-322`; `Lsa:323-325`). A pinned `orgId` answered differently raises
  `IDENTITY_MISMATCH` with expected and actual ids and status `identity_mismatch`, and its
  issues are never returned (`Lg:334-340`); login repeats both checks plus `duplicate_org`
  before writing a grant (`Lsl:310-324`).
- **`teams` and review metadata.** `teams:[KEY]` uppercased and deduplicated, a non-list dropped
  with a warning, narrowing only the `team` and `subscribed` queries (`Ln:119-136`;
  `Lq:104-125`). "Needs review" is a case-insensitive match on workflow state names, default
  `review|revisando|revisão|revisao|qa`, excluding completed/canceled/duplicate state types;
  `reviewScope` is `subscribed` (default), `team` or `assigned` (`Lq:18-24`;
  `Lcf:87-91`).
- **Statuses and errors to preserve.** `ok|needs_auth|identity_mismatch|error|unconfigured`, mapped by
  `statusForError` (`NEEDS_AUTH`/`needs_auth`→`needs_auth`,
  `MISSING_CREDENTIAL`→`unconfigured`, `IDENTITY_MISMATCH`→`identity_mismatch`, else
  `error`) (`Lse:15-22,52-58`). Gateway
  `RATE_LIMITED|NEEDS_AUTH|IDENTITY_MISMATCH|TIMEOUT|UPSTREAM_ERROR`, treating
  `200`-with-`errors[]`, `401/403`, `429`+`Retry-After` and network failures as
  typed errors and capturing `X-RateLimit-*` (`Lg:13-19,50-52`). Credential
  `NEEDS_AUTH|MISSING_CREDENTIAL|UNSUPPORTED_CREDENTIAL` (`Lc:46-52`); registry
  `duplicate_alias|duplicate_org|invalid_alias|invalid_registry|unsupported_version|registry_read|registry_parse|unknown_account`
  (`Ln:28-32`). Messages pass `redactSecrets`, masking `lin_api_*`, `lin_oauth_*` and
  `Bearer *`, and no token reaches a tool or RPC payload (`Lc:39-44,78-88`; `Lr:19-21`).

## E. The deck's own settings seam

- **File.** `<home>/.dsh/mattskillsdeck/settings.yaml`, `version:1`, in pure functions that never
  touch the filesystem; `SETTINGS_KNOWN_VERSION=1` and `SETTINGS_REL_SEGMENTS` =
  `['.dsh','mattskillsdeck','settings.yaml']`; the host adapter is the only entry point
  (`SET:4-8,32-35`; `CS:22,267-307`).
- **Strictness.** `TOP_KEYS=['version','ui','workspaces','debug','templates']`; any other top-level
  name fails the whole read as `unknown-keys`, naming the keys, and each section has its own
  whitelist failing the same way; types are checked and YAML scalars such as `yes`/`on` are
  rejected rather than coerced; a version above 1 reads as `readonly` with a `version-newer`
  warning and any other version is `bad-shape`; `stringifySettings` refuses unknown names,
  re-validates through `parseSettings` and writes the complete template
  (`SET:58-70,120-134,184-231,262-290`).
- **Adding a top-level section** — three edits in that one file: add the name to `TOP_KEYS`; validate
  it in `parseSettings` with its own key whitelist and return the normalized value; emit it from
  `stringifySettings` (`SET:58,233-256,286`). Consequence to decide deliberately: because
  `version` must be exactly `1` and unknown names are rejected, a file written with a new
  section is rejected by an older build as `unknown-keys`, and the adapter surfaces that failure
  rather than falling back to defaults (`CS:278-279`).
- **Gates.** `tests/verify-config-store-core.ts` is the schema gate — its header pins six things,
  including "C3 unknown keys … names the keys" and "C1 round trip", through the frozen facade
  `parseConfig`/`stringifyConfig`; neighbours include `tests/verify-config-store-*.ts` and
  the `verify-settings-*` family. A new gate must be registered in the stage list and shown red then
  green, and `scripts/verify-stages.json` has a catch-all `behavior` stage
  (`tests/verify-config-store-core.ts:1-11,24-29`; `docs/adr/20261021-config-ownership.md:60-65`;
  `scripts/verify-stages.json:24-28`).
- **Ownership rule.** One value, one definition; it moves into a data file only when the compiler cannot
  connect the two copies, decided by three questions — who edits it, are there already two drifting
  copies, does moving it lose a compile-time guarantee. A Linear account section in `settings.yaml` is
  therefore data-file territory (`docs/adr/20261021-config-ownership.md:22-39`).
- **`ctx.credentials` from host code today: unused, available.** The entry types its context as
  `HostCtx {get(key: string): any; inject(keys, fn)}` and calls
  `ctx.get('subprocess'|'timer'|'fs')`. A search of `src/` for `ctx.credentials` finds
  only locale keys plus the deck's promise that it holds no credentials — "Credentials held by the panel:
  none" — and the ledger records authentication as external and read-only, with tokens used only by
  running `gh` and git as subprocesses. The seam is declared on the cordis `Context` and the
  local provider is mounted by the base composition, so `ctx.get('credentials')` is usable once this
  fork uses it (`src/host/index.ts:11-12,23-25`; `src/client/kernel/locale-data.ts:5006`;
  `src/shared/version-control/src/capability-ledger.ts:1837-1852`;
  `src/refresh/rooms/host/gh-execution.ts:6-8,31-37`; `CID:98-102`;
  `DSH/dsh-base/cordis.patch.yml:125-126`).

## Facts ticket 13 depends on

- `import { credentialKey, credentialKeyScope, credentialKeyId, credentialRef } from '@deepseek-ai/dsh-credentials'` (`CID:11-69`).
- One key per account from `credentialKey('skills-deck', <id>)`, `<id>` matching
  `/^[a-z][a-z0-9-]*$/` — a Linear `orgId` UUID cannot be the id; a lowercased
  `urlKey`-shaped id can.
- Writes only through
  `ctx.credentials.modifyRecord(key, async (current) => ({ kind: 'grant', payload }))`; reads via
  `readRecord`, enumeration via `listRecords`; never `set()` for tokens.
- Grant payload fields the old plugin proved sufficient and that survive JSON (`Lgr:56-93`):
  `alias`, `orgId`, `urlKey`, `accessToken`, `refreshToken`,
  `expiresAt`, `scope: string[]`, `obtainedAt`, `clientId`.
- The status and error vocabulary of C unchanged, plus the identity probe and pinning rule, so the
  resolver returns token and identity.
- Settings: `TOP_KEYS`/`parseSettings`/`stringifySettings`/`SETTINGS_REL_SEGMENTS`
  (`SET`), `readLocalSettings`/`writeLocalSettings` (`CS:267-307`), gate
  `tests/verify-config-store-core.ts`. Room registration: `BackendModule`
  (`src/tracker/contract/backend-module.ts:145`),
  `BUILTIN_ROOM_IDS`/`BuiltinRoomId='github'|'gitlab'|'markdown'`
  (`src/tracker/registry/builtins.ts:22,32`).

**Not verified from primary sources.** (1) The `Organization` field `urlKey`: Linear's schema
file exceeds one fetch and Apollo Studio renders it in JavaScript, so that field set comes from the old
plugin's query; the root fields `viewer`/`organization` are documented, their subfields are
not. (2) The old plugin's architecture docs beyond §3 and §10 were not read, so nothing is claimed about
its RPC or panel contract. The sibling note carries one further unverified point on app-actor permissions.
