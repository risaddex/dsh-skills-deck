# Linear sign-in and API protocol — facts (map ticket #12, protocol half)

Serves map ticket #12 of "Wayfinder: dsh-skills-deck — English-first hard fork with a native Linear
backend": the DSH authorization seam, Linear's OAuth and GraphQL contract, and the sign-in behaviour of
the plugin this fork replaces. The account registry, credential records and settings seam are in the
sibling `research/12-linear-accounts-facts.md`. Ranges are 1-based lines.

`AZ`=`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-authorization`,
`AZR`=`AZ/README.md`,
`L`=`/Users/danilo/Documents/deepseek-harness/default-workspace/dsh-plugins/packages/dsh-plugin-linear/lib`,
`DSH`=`~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`.
Tags: `Lo`=L/oauth.js, `Lat`=L/oauth-attempts.js, `Lol`=L/oauth-loopback.js,
`Lc`=L/credentials.js, `Lg`=L/gateway.js, `Lgr`=L/grants.js, `Lcf`=L/config.js,
`Ln`=L/registry-normalize.js, `Lq`=L/queries.js, `Lsl`=L/service-login.js.

## B. OAuth infrastructure inside DSH

- **A flow seam exists; a protocol helper does not.** `ctx.authorization` registers one flow per
  credential record, keyed by that record's `<scope>/<id>`, with a label and ordered methods;
  `run(session)` talks to the human (one-way `notify`, questions of kind
  `text|secret|select`) and must commit through `ctx.credentials` before resolving, else
  `NOT_COMMITTED` (`AZR:34-65,113`). One attempt per key (`ALREADY_IN_FLIGHT`),
  `NO_FLOW`, `UNKNOWN_METHOD`, a declined prompt settles `cancelled` (`AZR:71-77`);
  the seam "owns the conversation, never the protocol" (`AZR:91`). Attempts are not resumable and
  die with the starting process, and nothing revokes — sign-out is
  `ctx.credentials.deleteRecord(key)` (`AZR:148-150`).
- **No loopback/OAuth utility is installed.** The only auth-named package is `AZ`; the redirect and
  PKCE machinery that exists is provider-specific inside `dsh-deepseek-account-platform`
  (`DSH/dsh-deepseek-account-platform/lib/index.js:490,1023,1059`). The old plugin records the same
  constraint: DSH exposes no generic third-party OAuth redirect endpoint and the Web GUI port changes on
  every launch, so the redirect URI registered in a Linear OAuth application can only be a port the plugin
  owns (`Lol:4-6`).
- **The consumer shape to copy** is `dsh-llm-pi-ai`: sign-in through the authorization seam, the
  result stored at `llm-pi-ai/<provider id>`, refreshed under the credential store's cross-process
  lock (`DSH/dsh-llm-pi-ai/README.md:95`). So the protocol side stays ours: authorize URL with PKCE,
  a loopback listener with a paste fallback, the form-encoded code exchange, single-flight refresh, and
  revoke.

## The old plugin's OAuth-as-user protocol (behaviour reference)

- **Authorize request.** `GET https://linear.app/oauth/authorize` carrying
  `response_type=code`, `client_id`, `redirect_uri`, `scope` (default
  `read` — the plugin never writes), a 32-byte hex `state`, `code_challenge` with
  `code_challenge_method=S256`, `prompt=consent` — deliberate, because without it Linear
  reuses the browser's previous consent and a token can land in the wrong workspace — and
  `actor=user` by default (`Lo:52-56,67-90`).
- **Callback.** A loopback server binds `127.0.0.1:<oauthRedirectPort>/callback`
  (`Lcf:47-50,235-237`; `Lol:16,77`). When the port is taken the attempt continues in paste
  mode, and `parseCallback` accepts a full callback URL, a query string, or the bare code Linear
  shows (`Lol:20-30`; `Lsl:93-106`).
- **Attempts.** One attempt per key, a single-use `state`, a 180-second deadline, and exactly one
  settle path — loopback redirect, pasted code, cancel or timeout (`Lat:26-33`; `Lol:16-18`).
- **Token exchange.** `POST https://api.linear.app/oauth/token` as a form body with
  `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
  `client_secret` and `code_verifier`; a reply without an access token is
  `OAUTH_BAD_RESPONSE`, and a non-2xx answer is `OAUTH_HTTP_ERROR` carrying the status and the
  provider's `error` string (`Lo:101-131,142-190`).
- **Where the token lives.** `$DSH_HOME/plugins/linear/auth.json` (or `DSH_LINEAR_AUTH_FILE`),
  mode `0600`, written with a temporary file and a rename, one grant per Linear organization keyed
  by `orgId`, re-read from disk before every merge, with a token-free projection for anything
  outward-facing (`Lgr:26-46,56-113,243-314`).
- **Refresh and replay.** A grant inside a five-minute window, or one a `401` rejected, is refreshed
  before use, single-flight per organization so Linear's refresh-token rotation never races itself; the
  rotated grant is persisted before the shared promise resolves, so a failed write fails the refresh
  instead of losing the new refresh token; the gateway then replays the rejected request exactly once
  (`Lo:41-42,240-244`; `Lc:262-275,350-421`; `Lg:15-17`).
- **Revoke.** `POST https://api.linear.app/oauth/revoke` with the token in the `token` field;
  the plugin derives the revoke URL from the configured token URL so a self-hosted or test origin keeps
  both endpoints on one host, and logout removes the local grant whatever the endpoint answers
  (`Lo:221-232`; `Lcf:245-251`).
- **What the human does by hand.** Register the OAuth application with its redirect URI, set
  `oauthClientId` and `oauthClientSecret` (overridable as `LINEAR_OAUTH_CLIENT_ID`,
  `LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_OAUTH_REDIRECT_PORT`), click sign in, and paste the
  code when the loopback port is busy (`Lcf:41-50,301-316`; `Lsl:46-106`).
- **The third mode is absent.** `buildAuthorizeUrl` accepts `actor:'user'|'app'` and sends it
  (`Lo:74,88`), but no call site passes `app`; `AUTH_TYPES` is only
  `['api_key','oauth_user']` (`Ln:24`). The upstream facts an installed-app mode needs follow
  in D.

## D. Linear's API contract

From Linear's own pages, fetched as plain markdown (`https://linear.app/developers/<page>.md`).

- **Authorization headers.** The GraphQL endpoint is `https://api.linear.app/graphql`. A personal API
  key is sent as `Authorization: <API_KEY>` — the bare key, no scheme word. An OAuth access token is
  sent as `Authorization: Bearer <ACCESS_TOKEN>`. Errors arrive in the standard `errors[]`
  array and can accompany HTTP `200`, so the array must be checked before treating a response as
  success (`graphql.md`, "Authentication" and "Error handling").
- **Authorize endpoint.** `GET https://linear.app/oauth/authorize` with `client_id`,
  `redirect_uri`, `response_type=code`, `scope`, `state` (optional but
  recommended), optional `prompt=consent` and optional `actor`; PKCE adds
  `code_challenge` and `code_challenge_method` (`plain` or `S256`)
  (`oauth-2-0-authentication.md`, "Redirect user access requests to Linear", "PKCE").
- **Scopes.** `scope` is a comma-separated list: `read` (the default, and "will always be
  present"), `write`, `issues:create`, `comments:create`, `timeSchedule:write`,
  `admin`. The page's own examples use `scope=read,write`, so `read,write` is the
  correct read-and-write spelling. Agent scopes `app:assignable` and `app:mentionable`, and
  `customer:read`/`customer:write`, are documented on `agents.md`.
- **Token, refresh and revoke endpoints.** `POST https://api.linear.app/oauth/token` with
  parameters in the body as `application/x-www-form-urlencoded`. For an authorization code:
  `code`, `redirect_uri`, `client_id`, `client_secret`,
  `grant_type=authorization_code`; under PKCE `client_secret` becomes optional and
  `code_verifier` is added. The response carries `access_token`, `token_type: Bearer`,
  `expires_in` (about 86 399 seconds), `scope` and `refresh_token`. Refresh is the same
  URL with `grant_type=refresh_token` and `client_id`/`client_secret` either as
  parameters or as HTTP Basic `client_id:client_secret`. Revoke is
  `POST https://api.linear.app/oauth/revoke` with the token in the `token` form field
  (optionally `token_type_hint`), answering `200`, `400` or `401`
  (`oauth-2-0-authentication.md`, "Exchange code for an access token", "Refresh an access token",
  "Revoke an access token").
- **Lifetimes.** Authorization-code access tokens live 24 hours and are renewed by exchanging the refresh
  token; client-credentials access tokens live 30 days with no refresh token, so a new one is requested
  before expiry using `expires_in`. A refresh token expires 30 days after issuance, every refresh
  returns a new pair with a new 30-day refresh lifetime, and if a successful refresh response is lost the
  same refresh token can be retried within 30 minutes of that successful refresh. All OAuth2
  applications were migrated to the refresh-token system on 1 April 2026
  (`oauth-2-0-authentication.md`).
- **What `actor=app` changes.** It becomes an app installation rather than a user login: every
  mutation runs as the app itself, the mode intended for agents and service accounts, tied to that
  authorization and its access token (`oauth-actor-authorization.md`). Renewal does not change —
  authorization-code installs still need the refresh token, client-credentials installs have none.
  Changing an installation's scopes means repeating authorization with
  `update_scopes_on_existing_token=true` and the full scope set, and the exchange replaces the
  installation's access and refresh tokens; removing scopes requires revoking and authorizing again, and
  the ordinary flow without that flag does not update an installation. `actor=application` is the
  deprecated earlier spelling that still works. `createAsUser` and `displayIconUrl` on
  `issueCreate`/`commentCreate` set the display name and avatar an app-written issue shows
  (`oauth-actor-authorization.md`, "Changing an installation's scopes").
- **Client credentials.** `grant_type=client_credentials` with `scope` plus
  `client_id`/`client_secret` (parameters or HTTP Basic) yields an `app`-actor token
  valid 30 days with no refresh token; the app must have client-credentials tokens toggled on. Such a
  token "has access to all public teams in the workspace", its team access is editable on the app details
  page, and rotating the client secret invalidates these tokens but not authorization-code pairs
  (`oauth-2-0-authentication.md`, "Client credentials tokens", "Rotating your client secret").
  Two more rules from the same page's "When credentials become invalid" (re-fetched 2026-11-16, ticket #19):
  a client-credentials request **replaces** an existing authorization-code installation of the same app in
  that workspace, and switching back needs that authorization revoked first; and requesting a **different
  scope set** revokes the app's existing app-actor tokens in that workspace, so every process sharing the app
  must request identical scopes (`oauth-2-0-authentication.md`, "When credentials become invalid", "Switching
  grants", "Client-credentials scope changes"). An app without client credentials enabled answers
  `Client does not support the client_credentials grant type` (same page, "Client credentials tokens").
- **What a non-admin app actor lacks.** Installation is workspace-scoped and "admin permissions are
  required to complete the installation"; with `app:assignable` the app is set as the issue's
  delegate, not its assignee, and agents "cannot be added as project members or set as project leads, even
  with the `app:assignable` scope"; customer entities need `customer:read`/
  `customer:write` (`agents.md`, "Authentication"). Admin-level endpoints need `admin`,
  which "should never" be requested (`oauth-2-0-authentication.md`, scope list).
- **Identifying the viewer and its organization.** The root query fields are `viewer` and
  `organization`: "`const me = await linearClient.viewer; const org = await
  linearClient.organization;`" (`sdk-fetching-and-modifying-data.md`, "Queries"), and the OAuth
  page validates a token with `{viewer{id name}}`. The field set the old plugin pins `orgId`
  with is `viewer{id name displayName email organization{id name urlKey}}` (`Lq:48-56`).
- **Rate limits.** API-key requests: 2 500 per hour per user; OAuth app requests: 5 000 per hour per user
  or app user; unauthenticated: 600 per hour per IP. Response headers are
  `X-RateLimit-Requests-Limit|Remaining|Reset` (UTC epoch milliseconds), `X-Complexity` and
  `X-RateLimit-Complexity-*`, plus endpoint-specific `X-RateLimit-Endpoint-Requests-*` and
  `X-RateLimit-Endpoint-Name` (`rate-limiting.md`).

## Facts ticket 13 depends on

- Constants: `https://linear.app/oauth/authorize`, `https://api.linear.app/oauth/token`,
  `https://api.linear.app/oauth/revoke`, `https://api.linear.app/graphql`; scope
  `read,write`; PKCE `S256`; `actor=user|app`;
  `grant_type=authorization_code|refresh_token|client_credentials`.
- Header shapes: bare key for a personal API key, `Bearer <token>` for every OAuth token.
- Sign-in surface: `ctx.authorization.registerFlow({key, label, methods, run})` with an
  `AuthorizationSession` (`notify`/`prompt`/`signal`) and commit-before-resolve, on
  the same credential record key the resolver reads (`AZR:46-65,113`).
- The identity probe query and the pinned-organization rule, so the resolver returns both the token and
  the identity the room pins (`Lq:48-56`; `Lg:317-342,334-340`).
- A grant payload that survives JSON: `alias`, `orgId`, `urlKey`, `accessToken`,
  `refreshToken`, `expiresAt`, `scope: string[]`, `obtainedAt`,
  `clientId` (`Lgr:56-93`).

**Not verified from primary sources.** Whether a non-admin app-actor token is refused for any specific
GraphQL operation beyond the documented installation-time admin requirement and the
project-member/project-lead restriction; Linear's docs name those restrictions and nothing further. The
sibling note lists two more unverified points — the `Organization.urlKey` subfield, and the old
plugin's architecture sections that were not read.
