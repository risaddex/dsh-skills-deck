# Linear GraphQL write surface — facts (tracker-adapter half)

The mutation and write-path facts a Linear tracker adapter must implement, checked against primary sources only. Sibling notes: `research/12-linear-signin-protocol.md` (OAuth, DSH authorization seam) and `research/12-linear-accounts-facts.md` (accounts, credentials). Each claim carries the tag of the source it came from; the tag table holds the URL. Schema claims are cited as `S2 <TypeName>` — the descriptions inside `S2` are Linear's own field documentation, so a quote from them is a primary claim rather than an inference.

## Sources

| Tag | URL | What it is |
| --- | --- | --- |
| S1 | https://linear.app/developers/graphql.md (HTML: https://linear.app/developers/graphql) | Endpoint, authentication, error handling, create/update examples |
| S2 | https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql | The published schema shipped inside `@linear/sdk`; fetched at commit `87d638c0b151575505d36822839324d2287f2e06` (2026-11-11), 46 122 lines, released as `@linear/sdk` 102.0.0 (S8) |
| S3 | https://linear.app/developers/pagination.md | Cursor pagination, defaults, ordering |
| S4 | https://linear.app/developers/rate-limiting.md | Limits, response headers, 429 handling |
| S5 | https://linear.app/developers/sdk-errors.md | Error classes |
| S6 | https://linear.app/developers/advanced-usage.md | Raw client; `headers: { Authorization: apiKey }` |
| S7 | https://github.com/linear/linear/tree/master/packages/sdk/src (`types.ts`, `error.ts`, `client.ts`) | SDK source: error wire shape, `LinearErrorType`, auth header |
| S8 | https://registry.npmjs.org/@linear/sdk/latest | SDK 102.0.0 metadata; `bugs.url` = github.com/linear/linear confirms the repo is Linear's own |
| O1 | This pass, 2026-11-19: read-only calls to https://api.linear.app/graphql with the workspace's OAuth application token, and reads of the GitHub REST API for `ombrello-seguros/ombrellosolar-backend` | First-hand observation, not documentation. It records what one real workspace does, so it is evidence about behaviour rather than a rule that must hold in every workspace |

The generated schema and the "published GraphQL schema" are the same artefact here: S2 lives in `@linear/sdk` next to `schema.json` and `_generated_sdk.ts` (S7 directory listing). Linear also serves every developer page as Markdown at `<page>.md`, which is what was fetched; the HTML page is the same content.

## 1. `issueCreate`

- Signature: `issueCreate(input: IssueCreateInput!): IssuePayload!` (S2 Mutation). "Creates an issue in the chosen team and returns it with its
  assigned identifier." (S2 Mutation.issueCreate)
- `IssueCreateInput` has 31 fields and **only `teamId` is non-null**. The nine this question names (S2 IssueCreateInput):
  - `teamId: String!` — required.
  - `title: String` — optional in the schema (`String`, not `String!`), although every documented example passes it (S1).
  - `description: String` — "The issue's description in Markdown."
  - `parentId: String` — "The UUID or identifier of an existing parent issue, such as ENG-123. Setting this makes the new issue a sub-issue; the
    parent can belong to another team if you can access it."
  - `assigneeId: String` — "The UUID of the user responsible for the issue."
  - `labelIds: [String!]` — "The UUIDs of labels to apply. Labels must be available to the issue's team."
  - `stateId: String` — "UUID of a status in the issue's team. Defaults to the team's initial status, or an unstarted status when cycleId is set."
  - `priority: Int` — "0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low."
  - `projectId: String` — project UUID.
- The other 22 optional fields: `completedAt`, `createAsUser`, `createdAt`, `cycleId`, `delegateId`, `displayIconUrl`, `dueDate`, `estimate`, `id`,
  `lastAppliedTemplateId`, `preserveSortOrderOnCreate`, `prioritySortOrder`, `projectMilestoneId`, `referenceCommentId`, `releaseIds`, `slaType`,
  `sortOrder`, `sourceCommentId`, `subIssueSortOrder`, `subscriberIds`, `templateId`, `useDefaultTemplate` (S2).
- Payload: `IssuePayload { issue: Issue, lastSyncId: Float!, success: Boolean! }` (S2 IssuePayload); the documented example selects `success` and
  `issue { id title }` (S1).
- **`ENG-123` comes back on the issue itself**, not from a separate payload field: `Issue.identifier: String!` — "The issue's current human-readable
  identifier, such as ENG-123. It changes when the issue moves to another team; use id when you need a stable identifier." (S2 Issue.identifier).
  `Issue.number: Float!` is "the issue's number within its current team. Combine it with the team key to form an identifier such as ENG-123, or read
  the identifier field directly" (S2 Issue.number), and `Team.key: String!` is "the team's unique key, used as a prefix in issue identifiers (e.g.,
  'ENG' in 'ENG-123')" (S2 Team.key). An adapter stores `id` (stable) and displays `identifier`.
- Default status without `stateId`: "the team's first state in the Backlog workflow state category. If the 'Triage' feature is turned on for the team,
  then the issue will be assigned to the Triage workflow state." (S1)

## 2. `issueUpdate`

- Signature: `issueUpdate(id: String!, input: IssueUpdateInput!): IssuePayload!` (S2 Mutation). `id` accepts "UUID or human-readable identifier":
  "Updates an issue by UUID or human-readable identifier and returns its resulting values. Omitted fields keep their values; list inputs replace their
  existing lists unless an add/remove field is used." (S2 Mutation.issueUpdate). S1 shows `issueUpdate(id: "BLA-123", ...)`.
- All six inputs asked for exist (S2 IssueUpdateInput): `title: String`; `description: String`; `parentId: String` — "The UUID or identifier of the
  new parent issue, such as ENG-123. Pass null to make this a top-level issue, or omit it to keep the current parent. An issue cannot be its own
  ancestor."; `assigneeId: String`; `stateId: String` — "UUID of a status in the issue's team. A status change updates lifecycle times and may change
  cycle membership. Moving to the reserved duplicate status requires an existing duplicate relation"; `labelIds: [String!]` — "Replacement list of
  label UUIDs. An empty list removes all labels. Cannot be combined with addedLabelIds or removedLabelIds."
- Also present: `addedLabelIds`, `removedLabelIds`, `priority`, `projectId`, `projectMilestoneId`, `dueDate`, `estimate`, `cycleId`, `delegateId`,
  `subscriberIds`, `teamId`, `sortOrder`, `subIssueSortOrder`, `trashed`, `snoozedById`, `snoozedUntilAt`, `slaType`, `autoClosedByParentClosing`,
  `inheritsSharedAccess`, `lastAppliedTemplateId`, `releaseIds`, `addedReleaseIds`, `removedReleaseIds`, `prioritySortOrder` (S2).

## 3. Comments

- Signature: `commentCreate(input: CommentCreateInput!): CommentPayload!` (S2 Mutation): "Creates a comment on one resource, or a reply when parentId
  is supplied."
- `CommentCreateInput` (S2): `body: String` — "The comment's message in Markdown. **Required for public API creation.**"; `issueId: String` — "The
  issue to associate the comment with. Can be a UUID or issue identifier (e.g., 'LIN-123')."; plus `parentId`, `doNotSubscribeToIssue`, `quotedText`,
  `projectId`, `projectUpdateId`, `initiativeId`, `initiativeUpdateId`, `documentContentId`, `postId`, `createAsUser`, `displayIconUrl`, `createdAt`,
  `createOnSyncedSlackThread`, `id`. Neither `issueId` nor `body` is non-null in the schema; the "required for public API creation" rule for `body`
  exists only in that description.
- Payload: `CommentPayload { comment: Comment!, lastSyncId: Float!, success: Boolean! }` (S2 CommentPayload).
- Listing goes through the issue's connection: `Issue.comments(after, before, filter: CommentFilter, first, last, includeArchived, orderBy) :
  CommentConnection!` (S2 Issue.comments), with `CommentConnection { edges: [CommentEdge!]!, nodes: [Comment!]!, pageInfo: PageInfo! }` and
  `CommentEdge { cursor: String!, node: Comment! }` (S2).
- Pagination: the standard connection arguments — `first`/`after` forward, `last`/`before` backward, "Between 1 and 250. Defaults to 50 when neither
  first nor last is supplied" (S2 arg descriptions; S3). Ordering defaults to `createdAt`, with `orderBy: updatedAt` available (S3).
- Threading: `Comment.parent: Comment` and `Comment.children: CommentConnection!`; replies "point directly to the root rather than nesting under other
  replies" (S2 Comment.children). A flat `Issue.comments` list therefore contains replies too.

## 4. Labels

- Signature: `issueLabelCreate(input: IssueLabelCreateInput!): IssueLabelPayload!` (S2 Mutation), payload `IssueLabelPayload { issueLabel:
  IssueLabel!, lastSyncId: Float!, success: Boolean! }`.
- `IssueLabelCreateInput` (S2): `name: String!` — "Label name, from 1 to 80 characters. Emoji are not allowed."; `color: String` — "Hex color, such as
  #EB5757. Defaults to the parent group's color, or #4EA7FC without a parent. Null is not accepted."; `teamId: String` — "UUID of the team whose
  issues can use the label. **Omit for a workspace label.**"; plus `description`, `parentId`, `isGroup`, `groupType`, `retiredAt`, `id`.
- **No `organizationId` field exists**, neither on `IssueLabelCreateInput` nor on `IssueLabelUpdateInput` (S2). The workspace-versus-team distinction
  is the team: `IssueLabel.team: Team` is nullable and `IssueLabel.organization` is deprecated with the reason "Workspace labels are identified by
  their team being null." (S2 IssueLabel).
- Attach and detach, both routes exist:
  - `issueUpdate` with `labelIds` (replacement; "An empty list removes all labels"), or `addedLabelIds` / `removedLabelIds` (cannot be combined with
    `labelIds`) (S2 IssueUpdateInput).
  - dedicated mutations `issueAddLabel(id: String!, labelId: String!): IssuePayload!` — "Add a label without replacing the issue's existing labels" —
    and `issueRemoveLabel(id: String!, labelId: String!): IssuePayload!` (S2 Mutation).
- Label pagination: `Query.issueLabels(after, before, filter: IssueLabelFilter, first, last, includeArchived, orderBy) : IssueLabelConnection!`, and
  the same for `Team.labels` and `Issue.labels` (S2); standard `edges`/`nodes`/`pageInfo`, 1–250 per page, default 50.
- Lifecycle: `issueLabelUpdate`, `issueLabelRetire` ("Retires a label so it cannot be newly assigned, while keeping it on issues that already use
  it"), `issueLabelRestore`, `issueLabelDelete` (S2 Mutation).

## 5. Blocking relations

- Signature: `issueRelationCreate(input: IssueRelationCreateInput!, overrideCreatedAt: DateTime): IssueRelationPayload!`. Description: "Creates a
  relationship between two issues, replacing any conflicting relation between the pair and reusing an identical one. A duplicate relation closes the
  source as a duplicate of the target... You must have access to both issues and any permissions required for the merge." (S2
  Mutation.issueRelationCreate)
- `IssueRelationCreateInput` (S2): `issueId: String!` — "UUID or identifier of the source issue, such as ENG-123. For duplicate, this is the duplicate
  issue."; `relatedIssueId: String!` — "UUID or identifier of the target issue. Must differ from issueId. For duplicate, this is the original issue.";
  `type: IssueRelationType!` — "How issueId relates to relatedIssueId: blocks, duplicate, related, or the deprecated similar."; `id: String`.
- `enum IssueRelationType { blocks duplicate related similar }` (S2).
- Object: `IssueRelation { id, issue: Issue!, relatedIssue: Issue!, type: String!, createdAt, updatedAt }` (S2) — note the asymmetry, `type` is an
  enum in the input and a plain `String!` on the object.
- Direction, quoted from the schema (this is the whole blocks/blocked-by semantics):
  - `Issue.relations` — "Relations **whose source is this issue**. For a blocks relation, this issue blocks relatedIssue; also read inverseRelations
    to find relations pointing to this issue." (S2 Issue.relations)
  - `Issue.inverseRelations` — "Relations **whose target is this issue**. For a blocks relation, the source issue blocks this issue; combine these
    with relations to read all links involving the issue." (S2 Issue.inverseRelations)
- So there is one relation type (`blocks`), not two: `issueRelationCreate({issueId: A, relatedIssueId: B, type: blocks})` means "A blocks B", appears
  in `A.relations` (with `issue = A`, `relatedIssue = B`) and in `B.inverseRelations`. To render "blocked by X" on B, read `B.inverseRelations` and
  take `relation.issue` for entries whose `type == "blocks"`. Removal is `issueRelationDelete(id: String!): DeletePayload!` (S2 Mutation).

## 6. Sub-issues

- Children: `Issue.children(after, before, filter: IssueFilter, first, last, includeArchived, orderBy) : IssueConnection!` — "The issue's direct
  sub-issues that you can access. Use each child's children field to read deeper levels of the hierarchy; **this connection does not flatten the full
  tree**." (S2 Issue.children)
- Parent: `Issue.parent: Issue` — "The parent issue. Null if this is a top-level issue or the parent is inaccessible." (S2 Issue.parent)
- Setting the parent: `parentId` exists on `IssueCreateInput` and `IssueUpdateInput` and nowhere else. The `Mutation` type has 335 fields and none of
  them sets a parent except through these inputs (`issueCreate`, `issueUpdate`, `issueBatchCreate`, `issueBatchUpdate`, which reuse the same input
  types) (S2 Mutation, S2 IssueCreateInput, S2 IssueUpdateInput). `parentId` in create/update is therefore the only way; there is no dedicated parent
  mutation.
- Sibling ordering is separate: `subIssueSortOrder: Float` on both inputs (S2).

## 7. Workflow states

- Query: `workflowStates(after, before, filter: WorkflowStateFilter, first, last, includeArchived, orderBy) : WorkflowStateConnection!`; also
  `workflowState(id: String!): WorkflowState!` and `Team.states(...) : WorkflowStateConnection!` (S2 Query, S2 Team.states).
- `WorkflowState`: `id: ID!`; `name: String!` ("e.g., 'In Progress', 'Done', 'Backlog'"); `type: String!`; `position: Float!` — "The status's display
  position within its type group, with lower values first. The type determines the group; changing position does not move a status from one type to
  another."; `team: Team!`; plus `color`, `description`, `inheritedFrom`, `archivedAt`, `createdAt`, `updatedAt` (S2 WorkflowState).
- Allowed `type` values: **there is no `WorkflowStateType` enum in the schema** (the name does not exist in S2). The values are stated in the field
  description: "One of \"triage\", \"backlog\", \"unstarted\", \"started\", \"completed\", \"canceled\", \"duplicate\"." (S2 WorkflowState.type)
- Filtering: `WorkflowStateFilter { team: TeamFilter, type: StringComparator, position: NumberComparator, name: StringComparator, id: IDComparator,
  and, or }` (S2), so `{ team: { id: { eq: $teamId } }, type: { eq: "completed" } }` is expressible.
- "First completed state" to close and "first unstarted state" to reopen: fetch the team's states, keep those whose `type` equals `completed` (or
  `unstarted`), pick the **lowest `position`**, and pass that id as `stateId` to `issueUpdate`. That follows the two descriptions quoted above, and
  matches S1's wording for the create-time default ("the team's first state in the Backlog workflow state category"). `completed` and `canceled` are
  different types, so reopening a canceled issue still needs an `unstarted` state.
- `Team.defaultIssueState: WorkflowState` exists (S2 Team), but since S1 documents the create default as the first Backlog state, an explicit
  `stateId` is safer than relying on it.

## 8. Teams and projects

- Team by id: `team(id: String!): Team!` — "Fetches a specific team by its ID" (S2 Query.team). `Team.id: ID!`, `Team.key: String!`, `Team.name:
  String!` (S2 Team); all `TeamFilter` comparators are on the plural connection.
- **Team by key** (the `ENG` of `ENG-123`): `teams(filter: TeamFilter, first, ...) : TeamConnection!` with `TeamFilter.key: StringComparator` (S2
  Query.teams, S2 TeamFilter), and `StringComparator` offers `eq`, `neq`, `in`, `nin`, `contains`, `startsWith`, `endsWith` and ignore-case variants
  (S2 StringComparator). So `teams(filter: { key: { eq: "ENG" } })` resolves a key to a team. Whether `team(id:)` also accepts a key is not stated, so
  the adapter should not rely on it.
- **Project by name**: `projects(filter: ProjectFilter, first, ..., sort: [ProjectSortInput!]) : ProjectConnection!` with `ProjectFilter.name:
  StringComparator` (S2 Query.projects, S2 ProjectFilter). `project(id: String!)` takes "The project UUID, slug ID, or human-readable identifier" — a
  *name* is not in that list, so a name lookup must go through `projects(filter: { name: { eq: "..." } })` and take `nodes[0].id` (S2 Query.project,
  S2 Project).
- Since `parentId` and `commentCreate.issueId` accept identifiers while `teamId`/`projectId` take UUIDs, the adapter resolves team and project to ids
  once and writes with ids (S2 IssueCreateInput, S2 CommentCreateInput).

## 9. Pagination, errors and rate limits

- **Cursor style**: Relay — `first`/`after` forward, `last`/`before` backward; `pageInfo` is `{ endCursor: String, hasNextPage: Boolean!,
  hasPreviousPage: Boolean!, startCursor: String }`, cursors are opaque strings and `endCursor` is "Null for an empty page" (S2 PageInfo, S3). Both
  `edges { cursor node }` and the `nodes` shortcut work (S3).
- Page sizes: "Between 1 and 250. Defaults to 50 when neither first nor last is supplied" (S2 arg descriptions on every connection); S3: "The first 50
  results are returned by default". Ordering defaults to `createdAt`, `orderBy: updatedAt` for most-recently-changed first (S3, S2 PaginationOrderBy).
- **Errors with HTTP 200**: yes — "Always check for the errors array before assuming success—GraphQL queries can partially succeed with a 200 HTTP
  status, returning some data while including errors for failed fields." Each error carries `message`, `path`, and `extensions` that "may contain
  additional context such as error codes or validation details" (S1, "Error handling").
- **`extensions` contents**, from the SDK that parses them: `extensions.type` (mapped to `LinearErrorType`), `extensions.userError: Boolean`,
  `extensions.userPresentableMessage: String` (S7 `types.ts`, `LinearGraphQLErrorRaw`). The mapped types are `FeatureNotAccessible`, `InvalidInput`,
  `Ratelimited`, `NetworkError`, `AuthenticationError`, `Forbidden`, `BootstrapError`, `Unknown`, `InternalError`, `Other`, `UserError`,
  `GraphqlError`, `LockTimeout`, `UsageLimitExceeded` (S7 `types.ts`), matched against lower-case wire strings such as `"ratelimited"`, `"invalid
  input"`, `"authentication error"` (S7 `error.ts`). The docs separately show `extensions.code: "RATELIMITED"` for the rate-limit case (S4), so the
  wire carries both a `code` and a `type`; only `RATELIMITED` is documented by name.
- **429 and `Retry-After`**: "GraphQL requests that exceed a rate limit return HTTP status code 429. You can catch these by inspecting the errors
  field in the response body, which contains the RATELIMITED error code. The Retry-After header gives the number of seconds to wait before retrying."
  (S4, "Handling rate limit errors")
- **Headers** (S4): `X-RateLimit-Requests-Limit` / `-Remaining` / `-Reset` (UTC epoch **milliseconds**), `X-Complexity`,
  `X-RateLimit-Complexity-Limit` / `-Remaining` / `-Reset`, and for endpoint-specific limits `X-RateLimit-Endpoint-Requests-*` plus
  `X-RateLimit-Endpoint-Name`. The SDK reads exactly these names into `retryAfter`, `requestsLimit`, `requestsRemaining`, `requestsResetAt`,
  `complexityLimit`, `complexityRemaining`, `complexityResetAt` (S7 `error.ts`, `RatelimitedLinearError`).
- **Limits** (S4): requests — API key 2,500/h per user, OAuth app 5,000/h, unauthenticated 600/h per IP; complexity — API key 3,000,000 points/h,
  OAuth app 2,000,000/h, unauthenticated 100,000/h; a single query is rejected above **10,000 points**. Plans multiply: Business 2x, Enterprise 5x.
  Complexity counts 0.1 per property, 1 per object, and a connection multiplies its children by its pagination argument (default 50), rounded up.

## 10. Authentication

- **Personal API key: bare, no scheme word.** "To authenticate your requests, you need to pass the API key with header: `Authorization: <API_KEY>`"
  (S1, "Personal API Keys"). The SDK does the same — `accessToken ? "Bearer " + accessToken : apiKey` — the api key goes into the header unchanged (S7
  `client.ts`, `parseAuth`), and S6's custom-client example passes `headers: { Authorization: apiKey }`.
- **OAuth access token: `Authorization: Bearer <ACCESS_TOKEN>`** (S1, "OAuth"). The same `parseAuth` adds the bearer prefix for an access token and
  refuses a DPoP signer whose token already starts with "Bearer " (S7 `client.ts`).
- What else differs besides the prefix: an OAuth token expires and is refreshed (the sibling note records 24 h for authorization-code tokens), it
  carries a `scope` list (`read`, `write`, `issues:create`, `comments:create`, ...), and it can act as the app (`actor=app`), which changes what a
  mutation does — `createAsUser`/`displayIconUrl` on `issueCreate` and `commentCreate` are "Available only to OAuth applications using actor=app" (S2
  IssueCreateInput.createAsUser, S2 CommentCreateInput.createAsUser). Some operations are OAuth-only: agent activities "Use the agent app's OAuth or
  workload identity token; **personal API keys cannot publish agent activities**" (S2 Mutation). Both header forms target the same endpoint
  `https://api.linear.app/graphql` (S1).

## 11. Observation from a real workspace: creating an issue in Linear also opens a GitHub issue

Settled by reading, never writing (O1), on 2026-11-19, against the team `OMB` ("Engarde/Ombrello DEV"), the team where the deck's Linear room was about to be tried.

- **The workspace runs Linear's GitHub integration.** `Query.integrations` answered with the services `github` and `githubCommit`, alongside `mcpServer`, `slack`, `slackPost`, `slackProjectPost`, `figma` and `sentry` (O1, S2 Query.integrations).
- **Every recent issue carries a GitHub attachment, and no label predicts it.** All 40 of the 40 most recently created `OMB` issues (newest `OMB-927`, 2026-11-19T16:00:26Z; oldest of that set `OMB-886`, 2026-11-05T15:56:13Z) have an `Attachment` whose `sourceType` is `"github"` and whose `url` points into `ombrello-seguros/ombrellosolar-backend`. Three of the 40 carry no label at all (`OMB-927`, `OMB-926`, `OMB-925`), so a label is not what turns the copy on; the label names seen on the other rows are the deck's own vocabulary (`wayfinder:map`, `wayfinder:research`, `needs-triage`, `backend`, ...) (O1).
- **The direction is Linear to GitHub, by about one second.** The GitHub issue is always created after the Linear issue, and usually by the integration's own bot account:
  - `OMB-886` created 2026-11-05T15:56:13.885Z; GitHub issue `#755` created 2026-11-05T15:56:15Z, author `linear-code[bot]`.
  - `OMB-916` created 2026-11-18T14:57:45.383Z; GitHub issue `#819` created 2026-11-18T14:57:46Z, author `linear-code[bot]`.
  - `OMB-923` created 2026-11-18T21:32:47.585Z; GitHub issue `#834` created 2026-11-18T21:32:48Z, author `risaddex`, followed one second later by a `linear-code[bot]` comment.
  - `OMB-927` created 2026-11-19T16:00:26.722Z; GitHub issue `#840` created 2026-11-19T16:00:28Z, author `risaddex` (O1).
- **What the two sides hold.** The GitHub issue of `OMB-927` repeats the Linear description byte for byte and carries a `linear-code[bot]` comment holding `<!-- linear-linkback -->` and a link to the Linear issue. The Linear issue in turn carries a comment written by no user (`user: null`) that reads "This comment thread is synced to a corresponding [GitHub issue](...). All replies are displayed in both locations.", created 1.6 s after the issue itself. `Attachment.creator` is `null` on these attachments, so no member wrote them (O1).
- **Consequence for any test that writes to Linear here.** "Create one test issue" is not a Linear-only operation in this workspace: it also opens an issue in a GitHub work repository about a second later, and deleting the Linear issue afterwards does not necessarily delete that GitHub issue. A test written to Linear needs a workspace whose GitHub integration does not cover the team.

Two API details exercised along the way:

- `issues(orderBy: createdAt)` returns the **newest first**: the first 100 rows came back `OMB-927` (2026-11-19) down to `OMB-826` (2026-11-04) (O1). The schema never says which direction `createdAt` means (S2 PaginationOrderBy), so this is an observation, not a rule to build on.
- `IssueFilter` has **no `identifier` field**: passing `identifier: { eq: "OMB-927" }` failed with `BAD_USER_INPUT` and the message `Field "identifier" is not defined by type "IssueFilter"`. A single issue is read by passing the identifier to `Query.issue(id:)`, which accepted `"OMB-927"` and returned the issue. The `description: { contains: ... }` form of `IssueFilter` was exercised too and answered an empty list rather than an error for text that exists nowhere (O1).

## Final evidence: can an issue or a label be deleted?

- **Issue deletion exists**: `issueDelete(id: String!, permanentlyDelete: Boolean): IssueArchivePayload!` (S2 Mutation). "Moves an issue to the trash
  and trashes its unarchived sub-issues that you can access. Trashed issues can be restored during the **30-day grace period**; permanentlyDelete
  skips that period and requires workspace entity-management permission." The argument repeats it: "Delete immediately, skipping the 30-day grace
  period. Requires workspace permission to manage entities and access to the issue's team." Payload: `IssueArchivePayload { entity: Issue, lastSyncId:
  Float!, success: Boolean! }`.
- So yes, Linear supports deleting issues — as a **soft delete with a 30-day grace period**, with permanent removal behind the opt-in
  `permanentlyDelete` flag. Archiving is the separate reversible operation `issueArchive(id: String!, trash: Boolean): IssueArchivePayload!` —
  "Archives an issue and its sub-issues... Pass trash only when you want the deletion grace period to apply instead." — with `issueUnarchive` as its
  counterpart (S2 Mutation).
- **Label deletion exists too**: `issueLabelDelete(id: String!): DeletePayload!`, `DeletePayload { entityId: String!, lastSyncId, success }` —
  "Deletes a label and its inherited copies. Assignments to that label are removed from issues in the background... **Retire a label instead if you
  want to preserve its existing assignments**"; the alternatives are `issueLabelRetire` and `issueLabelRestore` (S2 Mutation).
- Other deletes a tracker adapter may need: `commentDelete(id)` and `issueRelationDelete(id)`, both returning `DeletePayload` (S2 Mutation).

## Unverified

- **No complete list of `extensions` codes from Linear's own documentation.** S1 says only that `extensions` may contain "error codes"; S4 names only
  `RATELIMITED`; the rest of the vocabulary in this note comes from the SDK's `LinearErrorType` mapping (S7), which is the client's reading of the
  wire, not a published enumeration. Treat `extensions.type`/`code` as advisory strings, not a closed set.
- **Tie-break when two states of the same type share a `position`.** The schema says position is the display position "with lower values first" but
  never says positions are unique within a type group, and documents no secondary sort key (S2 WorkflowState.position). Choosing the lowest position
  is the best available rule.
- **Whether `title` is really optional server-side.** The schema types it `String` (not `String!`) and says nothing more, and every documented example
  supplies one (S1). Not verified whether a title-less issue is accepted.
- **Whether `team(id:)` accepts a team key** as well as a UUID; the description only says "by its ID" (S2 Query.team). The `teams(filter: {key: ...})`
  path is the safe one.
- **`lastSyncId` semantics**: present on every payload as `Float!` but described nowhere in S1–S8, so no sync logic should be built on it. Likewise,
  **what "replacing any conflicting relation" means exactly** in `issueRelationCreate` (which relations count as conflicting, and whether the replaced
  relation is returned) is not stated in the schema.
- **Whether the first-line anchor comment survives a write to `description`, and whether a search finds it.** The schema calls the description "the issue's description in Markdown" and says nothing about HTML comments (S2 IssueCreateInput.description). The attempt to test it (ticket #44) was stopped before its first write, because creating an issue in the team that was available for the test also opens a GitHub issue in a work repository (section 11). Nothing was written to Linear, so the anchor, the search for it, the spec marker on the second line, the rewriting of a bare identifier or URL into a Markdown link, the survival of a checklist, a table and a block quote, and the effect of a person editing one word in the Linear app are all **still unverified**.
- **The maximum length of a description and of a comment through the API**, and whether an excess is an error or a silent cut: unverified, for the same reason.
- **Whether a workspace label's colour can be changed by the token in hand.** Unverified. One extra caveat is now known (O1): the token stored for this workspace is an **OAuth application** token (the `viewer` query answers with the app's own identity, an `@oauthapp.linear.app` address, not a member), which is not the normal member key that the question about label colours asks about, so a result from this token would not settle it either way.
- **What a safe experiment needs**: a workspace with no GitHub integration covering the team, or an integration scoped to a project the team's test issues do not use. `OMB` is not such a place: it is the only team of that workspace, and its issues are mirrored to `ombrellosolar-backend`.

