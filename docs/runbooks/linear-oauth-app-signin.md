# Runbook: signing an `oauth_app` Linear account in (ticket #19)

Written 2026-11-16 for the maintainer's machine. It is a procedure for a person, not a description of the code.
Everything marked **checked** was run against the real code with stand-ins; everything marked **not checked** has
never touched `api.linear.app`.

## Read this first: two facts that change the steps

1. **The plugin installed in the `desktop` profile must contain the sign-in code.** On 2026-11-16 the profile
   linked `~/.dsh/profiles/desktop/node_modules/dsh-skills-deck` to the worktree `fix-22-repo-identity`, which
   does not have `src/host/linearSignin.ts` (zero occurrences of `registerLinearFlows` in its build). Linked
   to `main` at `c2c56899` or later it does. Check which one you have before step 3 (see "Is the code installed?").
2. **No screen in DSH starts a third-party sign-in flow.** The Account settings page only handles the DeepSeek
   account, and `cordis_inspect` only reads. The flow is registered on `ctx.authorization`, but nothing calls
   `begin()` until the Linear inbox in the deck tab exists (ticket #14). So today the way in is to write the
   credential record yourself (step 3, done by a script), which the credential store explicitly supports.

## What you need before starting

- Node 24.15 or newer (the script uses the built-in `fetch`).
- The Linear OAuth application's **client id** and **client secret** (Linear → Settings → API → OAuth applications).
- On that application: **"Client credentials tokens" switched on**. If it is off, the token request fails with
  `Client does not support the client_credentials grant type`.
- Workspace-admin rights were needed to create the app; nothing else needs them.
- The redirect URI `http://127.0.0.1:8791/callback` is registered on the app, but `oauth_app` never uses it.

## Steps

### 1. Is the code installed?

```sh
ls -ld ~/.dsh/profiles/desktop/node_modules/dsh-skills-deck | sed 's/.*-> //'     # where the profile links to
grep -rl registerLinearFlows ~/.dsh/profiles/desktop/node_modules/dsh-skills-deck/package/lib | head -1
```

The second command must print a path (it looks in `package/lib`, which is what the plugin loads; searching `.build` finds nothing even on a correct install, because that directory holds intermediate output). On 2026-11-16 it printed nothing: the profile was linked to the worktree
`fix-22-repo-identity`, a branch of ticket #22 that has no sign-in code. Reinstalling re-linked the same tree, so it
changed nothing. `main` at `c2c56899` already contains everything that branch had, so the branch is obsolete and the
profile should point at a tree that contains `c2c56899` or later.

To fix it, in the tree you will link (for example the main checkout, with its own dependencies installed):

```sh
node scripts/build.mts          # the profile loads the build output, not the sources
```

then redeploy with `plugin_manager` `remove_bundle` followed by `install_bundle` pointing at that tree (the `desktop`
profile is managed by the Electron app and the CLI refuses it), restart DSH, and run the `grep` again: it must now
print a path. A correct link does not prove the running DSH loaded it: the host reads the code at start, so restart DSH after re-linking. **Not checked:** I could not run `plugin_manager` from here, so the exact bundle path to give it is
yours to confirm.

### 2. Add the account

Create `~/.dsh/mattskillsdeck/linear-accounts.yaml` with exactly this (**checked**: it parses and registers one flow,
`skills-deck/linear-ombrello`, method `oauth_app`):

```yaml
version: 1
defaultAccount: ombrello
accounts:
  - alias: ombrello
    label: Ombrello
    authType: oauth_app
    orgId: ""
    urlKey: ""
    teams: []
    reviewPattern: review|revisando|revisão|revisao|qa
    reviewScope: subscribed
    previousAliases: []
```

`orgId` and `urlKey` start empty. **Nothing fills them in for you**: the plugin never writes the organization back to this
file (`writeLinearAccounts` has no caller), and while `orgId` is empty the wrong-workspace check cannot fire. After the
first sign-in (step 3), fill both in by hand from the identity query: ask Linear who the token is
(`{ viewer { name } organization { id urlKey } }` with `Authorization: Bearer <token>`), then put `organization.id` in
`orgId` and `organization.urlKey` in `urlKey`. With that done, a token pasted into the wrong account's record resolves
as `identity_mismatch` instead of returning another workspace's issues (**checked** with two real accounts on
2026-11-16). Until the plugin restarts or reloads, the flow is not registered.

### 3. Sign in (outside the chat)

Run this in **your own terminal**, not through an agent, so the client secret never enters a conversation or a log:

```sh
cd ~/Work/Projects/dsh-skills-deck
node scripts/linear-app-signin.mts ombrello
```

It asks for the client id, then the client secret (not echoed), asks Linear for an app token with the fixed scope
`read,write`, and writes the grant record `skills-deck/linear-ombrello` into `~/.dsh/.credentials.yaml`
(`$DSH_HOME/.credentials.yaml` when that is set). It prints only whether it worked: neither the token nor the secret
is ever printed or written anywhere else. The file keeps mode `0600`, and every other record and key in it is kept.
Running it again replaces the record instead of adding a second one. The store reloads the file by itself within
about 100 ms.

What the record holds, and why each field is there:

| Field | Why |
|---|---|
| `accessToken`, `expiresAt` | the 30-day app token and when it stops working |
| `clientId`, `clientSecret` | Linear's client-credentials tokens have **no refresh token**, so these are the only way to ask for the next one. Without them the token still works, but when it expires renewal answers `needs_auth` and you would sign in by hand every month (**checked**) |
| `mode: oauth_app`, `scope` | which renewal path to use, and the one scope set (`read,write`) Linear requires every process to share: a request with a different scope set **revokes the app's existing tokens in the workspace** |

Consequences to accept knowingly:

- The client secret sits in that file in plain text, protected only by the `0600` mode. That is the cost of a mode
  with no refresh token.
- Rotating the client secret in Linear **revokes every issued token**. Run the script again with the new secret.
- If it prints `FAILED`, the message says why. Two you can expect:
  `Client does not support the client_credentials grant type` (switch "Client credentials tokens" on in the app) and
  `invalid_client` (wrong id or secret, or the secret was rotated). On any failure the credentials file is left
  untouched.

**What was tested.** The script was run against a local stand-in for the token endpoint and a throwaway credentials
file: it stores the record, keeps the mode at `0600`, keeps other records and refs, replaces on a second run, leaves
the file untouched on a refused request, and prints no secret or token. Its output parses with DSH's own
credentials parser (`parseCredentialsDocument`) in three cases: an existing file, no file, and an empty `records:`
block. **Not tested: a real request to `api.linear.app`.** The first time you run it is that test.

### 4. Check it

Ask the account for its identity. When a Linear room or tool exists it will do this on its own; until then the only
check is the one the resolver already does. In a session on this repo:

- the account should read `ok`. It only checks the organization once you filled `orgId` in (step 2); until then any
  workspace's token reads `ok`;
- if it reads `needs_auth`, the token was rejected (HTTP 401/403): repeat step 3;
- if it reads `identity_mismatch`, the token belongs to a different workspace than the one pinned: use the right app.

**Not checked:** no real identity query has run yet. This step is the first time it will.

## Why this is not the flow from the code

The flow in `src/host/linearSignin.ts` (id prompt, masked secret prompt, one POST, commit) is what ticket #14's screen
will call. It is registered, but nothing starts it yet. Step 3 does by hand what that flow does, and writes the same record. When #14 lands this runbook reduces to: install, add the account (step 2), press sign in.

## Undoing it

Delete the entry `skills-deck/linear-ombrello` from `~/.dsh/.credentials.yaml`. The account then reads `needs_auth`,
which is the correct state, not an error. To also revoke at Linear, in the app's page use "Revoke" or rotate the
client secret.
