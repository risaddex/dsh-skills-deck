# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues.

## How to do it (read this section first)

**Tickets in this repository are read and written with the tools that ship inside the plugin; do not hand-type tracker commands.** These tools sit on top of the plugin's contract layer: a tool gets the job done against whichever backend is current and then reads back to check it, and the same tool still works when the backend is not GitHub, which is why the normal path in this document writes no commands.

**What these tools hand back comes in three parts**: a plain-language summary, a block headed `Notes for this call:` (the tool's honest warning about whether this call got everything — it only appears when something was degraded, for example when reading by section heading returned only one part of the body), and then the detail under the heading `Detail (JSON):`. The detail holds what was really fetched this time — the ticket body, comments, labels, child tickets, the map's five sections, and, when you add an edge, the evidence of which column each edge landed in — as much as the call asked for. When the total would exceed the cap, what gets cut is the tail entries, and the cut is written in place as `... (N more items were not carried back)`, so you cannot take something with pieces missing as complete. If you want a smaller but complete chunk, call that tool's own parameters (how many comments to read for one ticket, how many tickets to list, only the pickable child tickets) rather than waiting on the big response.

- Create a ticket → `deck_issue_create`
- Read one ticket → `deck_issue_get`
- See which maps exist and which tickets are open → `deck_context`
- See one map's child tickets and its progress → `deck_map_snapshot`
- List thin rows by state, label and assignee → `deck_issue_list`
- Create a whole map in one go (the map itself + its child tickets + the edges between them) → `deck_map_plan_create`
- Add one edge (a parent-child edge or a blocking edge) → `deck_map_link`
- Change one ticket (comment / labels / claim / close / body) → `deck_issue_patch`
- Look up what is active in this workspace (who is handling which ticket, which session really has a turn open at this moment, whether two sessions are colliding) → `deck_work_route` (write receipts no longer carry the table; call it whenever you want to see what is active; `running: true` on a session group means the host reports that session has a turn open right now, and an absent mark only means the question cannot be answered)

Only two things are left outside the tools' reach, and both happen outside the tracker:

- **Signing in**: run `gh auth login` and finish the authorization in the browser as prompted, then confirm you are signed in with `gh auth status`.
- **Creating the repository**: use `gh repo create` to create the remote repository and push to it. The "Create & publish" wizard on the panel does this one thing for you, so under normal circumstances you do not need to type it by hand.

Apart from those two things, the normal path writes no `gh` command at all. When the tools themselves go wrong, or right after the plugin was upgraded, follow the next section, "Tool failures".

### Tool failures

This section is only for when the tools themselves go wrong or the plugin was just upgraded; the normal path still goes through the tools above and does not hand-type tracker commands.

**Self-check after an upgrade or when a tool misbehaves**: call `deck_context`, then `deck_issue_list` (`limit: 3`), then `deck_issue_get` (reading the most recent ticket). If any one of them reports an error, stop and investigate; do not go on working with a broken tool. But if what it reports is the known regression described in the next point, just work around it with the fallback commands and do not re-diagnose. Run this once per upgrade, not every round (the three calls together do not spend many points, but do not run them every round).

**It reports `gh not found` but `gh --version` prints output**: gh is installed; its directory is just not on the PATH that DSH inherited when it started (the deck tools and the plugin resolve gh only from that PATH and do not probe the known installation directories). First restart DSH Desktop, starting it from the Start menu, the desktop or File Explorer (do not start it from an old terminal or an old IDE session; their process environment may still be the old one). If it still fails after the restart, then before starting DSH add gh's directory to the user-level or system-level PATH, or set `DSH_GH_PATH` — which this plugin reads — to the absolute path of the gh executable (on Windows the default installation location is `C:\Program Files\GitHub CLI\gh.exe`). Do not simply suggest reinstalling gh.

**A known regression that expires by version**: with an installed version ≤ `1.9.0-beta.26`, `deck_issue_list` reporting `ToolOutputError` / `value is not lossless JSON` is a known regression (the receipt's `data` carried an `undefined`; the fix is #1559, the code is already on main but not released yet), so do not re-diagnose it; once npm publishes a version containing the fix and the installed version moves past it, this point expires on its own.

**Fallback commands** (for emergencies, not for the daily routine): list tickets `gh issue list --state open --label bug --limit 200 --json number,title,labels,updatedAt`; read back `gh api repos/{owner}/{repo}/issues/{n}`; close `gh api -X PATCH repos/{owner}/{repo}/issues/{n} -f state=closed`; remove a label `gh api -X DELETE repos/{owner}/{repo}/issues/{n}/labels/{name}`. The same set of actions is also wrapped in `scripts/issue-emergency.ps1` (`-Action read|close|unlabel|body`, add `-DryRun` to only print the commands that would run): all four actions read back first, then write, then check after writing, and when a write fails they read back again to confirm whether it had in fact landed.

The emergency path carries two more hard rules. **Confirm the target repository before creating a ticket**: first use `gh repo view --json nameWithOwner` to see clearly which repository this write would go to, and confirm it is the maintainer's own repository; if it is not the maintainer's own repository (for example the upstream repository of the bundled skills, `mattpocock/skills`, unless the maintainer owns it), stop — never create a ticket in it. **To close a ticket, comment first, then close**: post the comment as its own entry, then run the close command separately; do not attach the comment to the close command (the reason is in the section "Closing a ticket always means commenting first, then closing" below).

**The three-version check**: which version is installed on this machine — `(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dependencies.'dsh-mattpocock-skills-deck'`; the version in the workspace `package.json`; the newest remote version from `npm view dsh-mattpocock-skills-deck version`. Look at all three numbers together: the workspace version is the version being developed, not the version running on this machine.

**How to read a failure receipt**: both `status` and `reason` sit in the receipt's `Detail (JSON):` block. `status` has three values (`ok` / `partial` / `unsupported`); `reason` answers "what the person holding this receipt should do next", not "what this error is called", and the next step falls into four tiers — retryable (`backend-threw` and the like) / wait for quota (`ai-tool-refused`) / the backend cannot do it (`backend-unsupported`) / timed out (`backend-timeout`); the other, rarer reason codes (`gate-defer` / `bad-args` / `no-backend`) are read straight from the explanatory text in the receipt when you meet them. Be especially careful when a write reports `backend-timeout`: it means the request went out and no receipt came back, so the write may already have taken effect — read back to confirm before deciding whether to retry. To see the failure details, look at the entry in `items` that carries the same code as the top-level `reason` (when several things failed, the top level carries the one the person most needs to be told first, which is not necessarily the first one in execution order) — it carries `code` (the reason code for the next step); when the failure came from the backend it also carries `errorKind` and `stage`, keeping the original error classification and the stage that failed, while failures local to deck (locks, quota, read-back checks) do not have these two fields and carry `local` instead (the local source of the failure); if `notes` says `This list may be incomplete`, narrow the conditions and ask again. When the whole receipt is judged invalid (it reports `invalid output`), first use the self-check above to confirm which of the tools is broken, then work around it with the fallback commands.

**A receipt for a state conflict (local Markdown)**: on the local Markdown backend the triage state is written in a visible `Status:` line in the ticket file, and the `DSH-LABELS` hidden in the file header keeps only the non-triage labels. When the visible line and the hidden triage label of an old file genuinely conflict, `deck_issue_get` / `deck_issue_list` carry `statusConflict`; `deck_issue_patch` writes nothing at all for the whole call, answering `status:'unsupported'`, `reason:'bad-args'`, and it puts ready-made retry arguments carrying `resolveStatus` into `data.retry.args`. Resend with `data.retry.args`; do not retry unchanged. When there is no conflict, passing `resolveStatus` runs as an ordinary call.

**The hard rule**: after a write times out or errors (network drop, EOF, a receipt judged failed), always read the current state back first; never resend straight away. A timeout or an error often means the write did in fact land, and resending would produce a duplicate comment or a duplicate close. A retry is only allowed once reading back confirms that nothing landed.

### Closing a ticket always means commenting first, then closing

Closing a ticket is always two steps: first post the conclusion as a comment, then change the state to close it. The tools' normal path follows the same order — when one `deck_issue_patch` call carries both `comment` and `close`, the tool posts the comment first and then closes.

**This cannot be squeezed into one step.** Closing with an attached comment has a known trap: closing an already-closed ticket "with a comment" loses the comment while the call still returns success — it looks done, but not a single word of the conclusion was kept. So post the comment on its own and do the close on its own; only when both land does the conclusion survive. `/wayfinder`'s Resolve follows this order too (write the conclusion as a comment first, then close, and finally go back to the map and add the pointer).

### Saving context when reading a ticket (fetch body and comments on demand)

By default `deck_issue_get` gives only enough to locate the ticket and does not pour the whole ticket into the context at once: the body comes back only for the first 2000 characters (the receipt also tells you how long the whole body is and what its fingerprint is), and no comment text comes back at all — only how many comments there are. The reverse blocking edges and the defaults of the map snapshot are unchanged (no argument means the full set).

- The body appears in the receipt in exactly one place (#1828): the summary tier puts it in `data.body.text`, the full-document tier in `data.body.chunks`, and when you read one section (`section`) the raw text is in `data.section.text`, while `data.body` then reports only the tier `section` together with the full-text length and fingerprint (when `body: 'full'` is sent together with `section`, it returns only the section name and the full text is still in `data.body.chunks`). The ticket face `data.ticket` holds no body, and there is no second summary at the top level of the receipt either — one fact is not copied twice.
- To read the whole body: call again with `body: 'full'`. The full body comes back in chunks of 7000 characters (each chunk leaves enough room to render), carrying the SHA-256 fingerprint of the whole body; put the chunks back together in order and you have the original text, not a byte short. Before writing a whole body back, read it once in this tier and note down the fingerprint you got.
- To read comment text: call again with `comments: N` (at most 200). The total count was already given by that earlier call; this call only fills in the text.
- To write a whole body: you must also pass `bodyDigest` (the fingerprint you got from the previous `body: 'full'` read). The tool first reads the current body and computes its fingerprint, and when they do not match it refuses without touching a single character — this is what keeps the later of two people editing the body at the same time from overwriting the earlier one. It is not needed when you only change comments, labels, claim, progress or original words.
- Read the full body only once per ticket per round: note down the body and the fingerprint you got the first time with `body: 'full'`; when you later only need to check whether a write went in, read labels, state and fingerprint in the default tier and check those, rather than pulling the whole body again.

### One general rule for writing a body

Write the body into a file first (the file must contain real line breaks: every section heading — `##` plus the section name — on a line of its own, and one blank line between paragraphs), then hand it to the tool to write back; do not paste the body into a command line, do not write line breaks as the two literal characters `\n`, and do not let the body start with an invisible character (a BOM). After writing, read it back and check it once. This rule holds for all three backends; it is not specific to GitHub.

Order the body as follows. The sections near the top are rarely touched once written, while the ones further down keep growing, so the ones that will keep growing go last.

| Order | Section | What goes in it |
| --- | --- | --- |
| 1 | `## Purpose`（`## 目的`） | What problem this ticket solves and what change it brings to whom. One sentence, no implementation plan. |
| 2 | `## The maintainer's own words`（`## 维护者原话`） | The words the maintainer themselves said, verbatim (only when there are some; otherwise the whole section does not appear). How to write it: see "How to write the original-words section" below. |
| 3 | `## Boundaries`（`## 边界`） | How far this goes and what it does not do; say up front what could easily sprawl past the line. |
| 4 | `## Done when`（`## 做完`） | How we know it is done: acceptance conditions that can be checked one by one. |
| 5 | On-demand sections | Investigation, discussion conclusions, wrap-up steps and the like, only when needed; each `##` heading gets a line of its own. |
| 6 | `## Progress`（`## 进度`） | The log of how far it has got; always the last section of the body, with no other section after it. How to write it: see "How to write the progress section" below. |

**How to write the progress section**

The heading is always written as `## Progress`（`## 进度`）, with no percentage in the heading. One record per line, **the newest one on top**, so a reader looks at the first line and knows how far this ticket has got right now.

A record is always written like this (the line begins with the literal prefix `进度：`, "progress:"):

- 进度：{percentage}%（{ISO 8601 time, with time zone}）：{one sentence saying how far it got}

For example:

- 进度：90%（2026-10-21T20:15:32+08:00）：finished the read side, running the gates now
- 进度：40%（时间未记录）：the percentage carried over from the old ticket's heading

A few rules:

- **The note is required**; an update that gives only a percentage is refused and not written: the percentage answers "how much is done", while the note answers "how far it got", and the latter is what the reader wants.
- **The tool stamps the time**; the person writing does not make one up. When an old record has no time, write `时间未记录` ("time not recorded") instead of guessing.
- The number of records is unlimited; old records stay exactly as they are, neither deleted nor moved away.
- When the whole ticket body goes past 60KB, writing progress is refused, and the tool will not move old records away on its own; a person decides how to shorten the body first, and only then does the write happen.
- Old tickets are not migrated in bulk; they switch to the new form naturally the next time progress is written into them.

To write progress, use the `progress: {percent, note}` parameter of `deck_issue_patch`: `percent` is an integer from 0 to 100, and `note` is a required sentence (it cannot contain a line break). The tool stamps the time, writes the body back, and then reads the body back to check it once.

**How to write the original-words section**

The heading is always written as `## The maintainer's own words`（`## 维护者原话`）, right after `## Purpose`（`## 目的`） (when there is no purpose section, it goes at the very front of the body). It is part of the body, not a comment.

One set of original words is made of two parts, a source line and a quote block:

- **The source line**: a line of its own outside the quote block, starting with `出处：` ("source:"), saying where this sentence came from, so that a reader can go and check it. For something said on a ticket, write the full link; for something said in this session, write `本会话（时间）` ("this session (the time)"); for something written in a file, write `path:line`; for something said in a commit, write the short hash.
- **The quote block**: right below the source line, holding the words themselves: every line gets a `>` in front, and a blank line inside the original words becomes a line of its own holding just `>`.

For example (write the whole block into the body in the shape below):

```text
## 维护者原话

出处：本会话（2026-10-21T20:05+08:00）
> 第一段原话，一个字都不改地抄在这里。
>
> 第二段原话；原话里本来有空行的地方，保留成单独一行 `>`。
```

A few rules:

- **Every sentence the user typed by hand is worth recording**: what they type themselves is not much to begin with, so do not judge for them which sentences matter, and do not wait for them to say "record this" explicitly.
- **The original words are the highest requirement on this ticket**: in every later decision, when they conflict with anything else the ticket says, the original words win; when it truly cannot be decided, tell the user there is an obvious conflict here instead of ruling on it yourself.
- **Not one character changes**: no polishing, no punctuation changes, no translating, no summarising, no merging. Put explanations in another section; the quote block stays exactly as it was.
- **Append only**: no editing, no deleting, no reordering, no merging; when the same sentence with the same source has already been recorded, skip it and do not record it a second time.
- The number of entries is unlimited, and they share the one 60KB ceiling with the body.

To write this section, use the `originalWords: {text, source}` parameter of `deck_issue_create` and `deck_issue_patch` (#1091 landed it): `source` is required; the tool appends by the rules above (append only), skips idempotently when the same original words come with the same source, and after writing reads the body back and checks it character by character.

There are two entry points for reading this section (#1092 landed them):

- `deck_issue_get` returns `originalWords: [{text, source, recordedAt}]`: `text` is character-for-character the same as the quote block (only the one `>` prefix on each line is removed; blank lines inside the original words stay blank lines, with no trim); `source` is the source line as written; `recordedAt` only recognises an ISO 8601 time containing a `T` inside the source text and returns it as-is, and is `null` when the source gives no time (the ticket's modification time is not used as a stand-in). When there are original words, `notes` adds one reminder: the original words are the highest requirement on this ticket. When you only want the raw text of the whole section (with the `>` prefixes), pass `section: '维护者原话'` ("the maintainer's own words") to the same tool.
- The thin rows of `deck_issue_list` do not read the body, but a ticket that has original words carries `hasOriginalWords: true` on its row, so you can tell in a list which tickets hold words the user typed themselves, and then read `deck_issue_get` ticket by ticket for the raw text.
- The full rows of `deck_map_snapshot` carry the same `originalWords`, while the thin rows deliberately do not (anyone who wants the original words reads `deck_issue_get` ticket by ticket).

Parsing is implemented in exactly one place: `parseOriginalWords` in `src/shared/issue-file/src/original-words.ts`, and the read tools and the write side share the same line-by-line scan.

**How these two sections are written follows the settled text of #1089**: the section order above and the rules of the two sections come from the section "讨论结论（2026-10-21 定稿）" ("discussion conclusions, settled 2026-10-21") of the body of ticket [#1089 地图15讨论：进度写哪、原话区的写法](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck/issues/1089); why it was settled this way, and which primary sources were consulted, are in `research/1089-progress-and-user-voice.md` (every conclusion there cites its source). To change this way of writing in the future, first change the settled text in that ticket, then change this document — do not let the rules live only in word of mouth.

### The fallback when the native capability is not available

The tools first use the backend's own native capability (on GitHub that is native sub-issues and native dependency edges). Only when it truly cannot be had do they fall back to writing a `Blocked by: #n` line as the first line of the child ticket's body (several blocking ticket numbers are separated by commas). This line is the fallback shared by all three backends; it must not be used as the default way.

## Mandatory label set

The actual practice in this repository when creating a ticket is **adding labels by position**: see which of the six positions this ticket occupies, and add the one or two labels it should carry; not every new ticket is required to carry a triage label. This table corresponds entry by entry with the position table in the code (`OBJECT_KIND_RULES` in `src/deck/rules/object-kind.ts`):

| Position | Labels added when creating |
| --- | --- |
| Exploration map (`kind: map`) | `wayfinder:map` |
| Map ticket (`kind: map-ticket`) | the one `wayfinder:<type>` given in `label` at call time (one of `research` / `prototype` / `grilling` / `task`) |
| Spec (`kind: spec`) and its implementation tickets (`kind: spec-ticket`) | no type label; when no triage state is given explicitly, the default is `ready-for-agent` |
| Bug ticket (`kind: bug`) | the type label `bug`; when no triage state is given explicitly, the default is `needs-triage` |
| Plain ticket (`kind: issue`) | none of them: it carries whatever labels the caller gives |

**A triage state is at most one per ticket at any moment** (one of `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`), and changing the state replaces rather than stacks: when creating a ticket, if `labels` carries a state explicitly, the caller's choice stands (the position default is not stacked on top); when changing labels, if `addLabels` carries one state, the tool first strips the state the ticket had and then swaps in the new one, and it writes into the receipt which ones it stripped; giving two or more states at once (creating or changing labels) rejects the whole call, and not a single label on the ticket moves. The program keeps exactly one list for the state vocabulary: `src/tracker/contract/triage-states.ts` (`canonical-labels.ts` also takes the names from there); the local Markdown backend has a second configuration source, `status.triage-roles` in `original-skills.yaml`, and `tests/verify-md-format-config.ts` compares the two item by item, so changing the list means changing both places together.

`deck_issue_create` adds whatever is missing by this table and writes into the receipt which ones it added; change labels with `deck_issue_patch`. The local Markdown backend lands the triage role as a visible `Status:` line in the ticket file rather than writing it into the hidden `DSH-LABELS`; spec and exploration-map containers have no visible status line and still use a hidden `DSH-STATUS`. The read side folds the visible state back into a triage label, so filtering `deck_issue_list` by `labels` still works.

**A wayfinder map and its map tickets carry only wayfinder labels, and do not have triage labels such as `ready-for-agent` stacked on top.** The reason: they are decisions, not implementation work; stacking triage labels on them would mix them into the filters for "can be handed straight to an agent to do", and treat something still under discussion as settled work.

The three labels `bug` / `needs-triage` / `wayfinder:grilling` still have to exist in the tracker: they are the entry points of the three actions on the panel, "fix", "diagnose" and "discuss" (matching the BUG / TRIAGE / discuss filters). But they are no longer the hard requirement of "every new ticket carries at least one of them"; when creating a ticket, just add labels by the position table above.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

Once this item is set to `yes`, pull requests go through the same set of labels and state transitions as issues, and PRs are read and written the way the current backend does it (on this backend, that means swapping the issue family of subcommands in the command line for the PR family). GitHub numbers issues and PRs in one shared sequence, so `#42` in a body alone does not say which of the two it is — with such a number, either look up both or simply ask the user which one it is.

## When a skill says "publish to the issue tracker"

Create a ticket with `deck_issue_create`.

## When a skill says "fetch the relevant ticket"

Read that ticket with `deck_issue_get` (together with its comments and labels).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. All of the operations below go through the tools; not one of them is done by hand-typing commands.

- **Map**: a ticket labelled `wayfinder:map`, with Notes / Decisions-so-far / Fog in its body. Create it with `deck_map_plan_create` (it writes the destination, the Notes and the plan as one map).
- **Child ticket**: a child ticket hung under this map. Create this parent-child edge with `deck_map_link` by passing `parentKey`; the tool lands it according to the current backend's capability and honestly reports which column the edge landed in (a native edge, or the task list plus an ownership marker in the ticket body; the GitLab room lands it in the hidden marker `<!-- DSH-PARENT: <map> -->` in the file header). The label is `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`); carry only that one and do not stack triage labels such as `ready-for-agent` on top (they are decisions, not implementation work — see the `## Mandatory label set` section). Once the ticket is claimed, the assignee is the developer driving this piece of work (claim it with `deck_issue_patch`).
- **Blocking**: blocking relations land as the backend's own native dependency edges first (on GitHub these are native issue dependencies, visible in the interface). Pass `blockedBy` to `deck_map_link`; the tool decides for itself whether a native edge can land, falls back to the blocking notation in the body when it cannot (the GitLab room degrades as a pair: a visible `Blocked by: #n` line plus a hidden machine table `<!-- DSH-BLOCKED-BY: … -->`), and tells you which column it landed in. What `blockedBy` lists is **the tickets that block this one** (they have to be closed first before this one's turn comes); the receipt names it explicitly — "ticket #A's blockedBy has #B, that is, #A is blocked by #B" — and you check in that direction when reading the receipt. A ticket only becomes unblocked once every ticket blocking it is closed.
- **Frontier query**: read this map's open child tickets with `deck_map_snapshot`, drop the ones that can still be blocked (dependency edges pointing at tickets not yet closed, or tickets not yet closed left in the body's `Blocked by` line) and the ones already claimed; take the first of what remains, in the order the map lists them.
- **Claim**: point this ticket at the current user with `deck_issue_patch` — this is the first write operation of the session.
- **Resolve**: with `deck_issue_patch`, first post a comment stating the conclusion, then close this ticket; then go to the map's Decisions-so-far and add a line pointing at it (a one-sentence conclusion plus a link). Neither the order nor its reversal may be skipped: comment first, close second (the reason is in the section "Closing a ticket always means commenting first, then closing" above).
