# Template for a release's real-machine verification checklist ticket

This ticket collects the real-machine verification a version needs: one ticket per version that is going to be released, and the title is always `[Real-machine verification] <version>`. Below it is called the **checklist ticket**. The rules are in [real-machine-verification.md](real-machine-verification.md).

## Wording the release scripts match

The release scripts and the release gate read a checklist ticket by matching some wording exactly, so write these pieces as shown, in the title, the body and the comments. The list below is the English format this repository declares in `scripts/lib/release-checklist-format.mts`; if you change one side, change the other.

| Where | Exact text | Who reads it |
| --- | --- | --- |
| Title prefix | `[Real-machine verification]` | `scripts/lib/release-checklist.mts` and the release gate |
| Placeholder title word | `Next` | the same two |
| Body placeholders the release scripts fill in | `<版本号>`, `<上一发布版本>` (see the note below) | `fillChecklistTemplate` in `scripts/lib/release-checklist.mts` |
| Scenario overview heading | `## Scenario overview` | the consistency checker and the release gate |
| Overview column names (inside the header cells) | `Scenario number`, `Source ticket`, `One sentence`, `Status`, `Notes` | the same two |
| Empty overview row | `none yet` (no parentheses) | the consistency checker skips this row |
| Status cells | `to be verified`, `already verified`, `passed`, `failed`, `exempt`, `not tested`, `blocked`, `void` | the same two; keep the status cell to the status word alone and put explanations or ticket links in Notes |
| Count sentence at the start of the overview | `N scenarios`, `M source tickets`, `K <status>` (for example `2 passed`) | the consistency checker compares them with the table |
| Batch records heading | `## Batch records` | the release gate |
| Difference audit heading and line | `## Candidate and release difference audit`, `- Candidate commit <40-char commit> → release commit <40-char commit>: <reason>` | the release gate |
| Reconciliation heading | `## Pre-release reconciliation` | the consistency checker reads counts in this section |
| Batch start comment | a first line `Batch start:` | the release gate |
| Scenario block heading in a comment | `## Scenario block: <source ticket number> <one English sentence>` | the consistency checker and the release gate |
| Batch identity and baseline lines in comments | `- Verification identity: batch …; candidate commit …; candidate package sha256 …`, `- Verification baseline: local … …; target version …` | the release gate; copy them verbatim from `batch open` |
| Scenario result line in a comment | `Scenario <id>: <result>` | the consistency checker and the release gate |
| Closing count line | `[Ready to release] passed N / failed M / exempt K` | the consistency checker and the release gate |
| Closing-only phrases | `ready to release`, `verification closed`, `closing closed`, `registered scenarios` | the consistency checker treats any comment with one of them as the closing comment |

**Records written before this page was translated stay valid.** The checker and the gate read both the English wording above and the earlier Chinese wording (`[真机验证]`, `## 场景总览`, `## 场景块：`, `通过`, `[发布就绪]` and so on), so a checklist ticket that already exists on the tracker does not need to be rewritten. Write every new ticket in English. Within one ticket, keep one language for the status words of the overview table.

**The two body placeholders are the one exception.** `<版本号>` and `<上一发布版本>` are replaced by `fillChecklistTemplate` through a literal search, and that code still looks for those exact characters. They are filled in when the ticket is created, so they never reach a reader; do not translate them in the template.

## Creating the ticket

1. **Search first**: use `deck_issue_list` to search titles for `Real-machine verification` (and, for tickets created before the translation, `真机验证`) and see whether this version's checklist ticket already exists. If it does, do not create another one; merge any duplicate into the earlier ticket.
2. **Settle the version**: if the version is settled, put it straight into the title. If it is not settled yet (early in development), create a placeholder ticket titled `[Real-machine verification] Next (since <previous released version>)` and rename it during release preparation.
3. **Create it**: use `deck_issue_create` with `kind: 'issue'`, the title in the format above, and the body template below (replace the parts in angle brackets).
4. **Labels it does not get**: this is a tracking ticket of the release process, so it does not get `bug`, `needs-triage` or `wayfinder:grilling` (it is none of those three kinds of work); it is recognised by its title prefix.

## Who creates it

- Normal path: **whoever closes the first source ticket of the version**. Before closing that ticket, search for the checklist ticket and create it if there is none.
- After a release: the post-release script `scripts/release-postflight.mts` creates the next version's placeholder checklist ticket automatically.
- Fallback: if the release owner finds no checklist ticket during release preparation, they create one and backfill the scenarios. If two people create one at the same time, the later one searches again before posting any "add scenario" comment; when an earlier ticket exists, move the content there, close their own ticket and write "duplicate, merged into #<earlier ticket>".

## Closing the ticket

- The ticket may be closed when every registered scenario is `already verified`, `passed` or `exempt` with the exemption accepted. A scenario already verified on a real machine during development is marked `already verified` with the source of the evidence, and is not scheduled into a batch.
- When closing, write one count line in the closing comment so readers see the result at a glance: `[Ready to release] passed N / failed 0 / exempt M`.
- The pre-release check verifies five things: this version has exactly one checklist ticket; it is closed; its record is internally consistent (the numbers and statuses in the body's scenario overview agree with the scenario blocks, batch results and closing counts in the comments); every batch comment carries the candidate identity line; and every candidate commit is an ancestor of the release commit (when the candidate commit and the release commit differ, the ticket has a difference audit line saying why the difference is acceptable). The counts take part in the check: the total, the per-status counts and the release counts the body states must agree with the actual tally of the overview table; where they do not, the script lists each mismatch and the release waits until it is fixed.
- After the version is really released, add one last comment (released version and time, the counts, where the evidence is, the CHANGELOG commit). The ticket stays closed.
- Post exactly one closing comment, and only when the checklist ticket really closes. Batch comments and batch result comments must not contain the four closing-only phrases (`ready to release`, `verification closed`, `closing closed`, `registered scenarios`) nor a slash count line such as `passed N / failed M`: the pre-release check would treat them as closing comments and compare their counts, and historical comments must not be rewritten. The full reason is in section 3 of [real-machine-verification.md](real-machine-verification.md).
- A comment is never edited after it is posted. To correct one, post a new comment that says which sentence of which comment it corrects and why.

## Body template

Copy everything between the two markers below and replace `<版本号>` and `<上一发布版本>` with the real values (the release scripts do this replacement themselves when they create the placeholder ticket).

<!-- checklist-template:start -->
> **This ticket is a release's real-machine verification checklist**, not a development ticket. The rules are in [docs/agents/real-machine-verification.md](https://github.com/risaddex/dsh-skills-deck/blob/main/docs/agents/real-machine-verification.md); the headings, status words and fixed lines below are matched verbatim by the release check, so keep them exactly as written.

## Purpose

Collect every scenario of this version that needs real-machine verification in this ticket, and verify them one by one here before the release. A source ticket may be closed without real-machine verification, but before it is closed its scenarios must be registered in a comment on this ticket.

## Version scope

- Version: <版本号>
- Previous released version: <上一发布版本>
- Scope: the changes merged into main after the previous released version and shipped with this version, as listed under "corresponding commits" in `CHANGELOG.md`.

## Rules (for readers of this ticket)

- Scenario details go into comments: one scenario block comment per source ticket, headed `## Scenario block: <source ticket number> <one sentence>`. The body does not hold scenario details.
- The verification facilitator maintains the three tables in the body: scenario overview, exemptions and batch records.
- Closing condition: every registered scenario is `already verified`, `passed` or `exempt` with the exemption accepted. A scenario already verified on a real machine during development is marked `already verified` with the source of the evidence, and is not scheduled into a batch.
- The pre-release check confirms that this version has exactly one checklist ticket and that it is closed, checks that the body and the comments agree (scenario numbers, each scenario's conclusion, every count), and requires every batch comment to carry the candidate identity line and every candidate commit to be an ancestor of the release commit (with a difference audit when they differ). Anything that does not agree is listed with how to fix it, and the release does not go out until it is fixed.

## Scenario overview

When the table has rows, state its totals using `N scenarios`, `M source tickets` and `K <status>` (for example `2 passed`), replacing the letters with the actual counts. Do not leave illustrative numeric counts here: the checker reads them as claims about this table.

| Scenario number | Source ticket | One sentence | Status | Notes |
| --- | --- | --- | --- | --- |
| none yet | | | | |

Status cells hold exactly one of: `to be verified` / `already verified` / `passed` / `failed` (put the `→ #<ticket>` reference in Notes) / `exempt` / `not tested` / `blocked` / `void` (with the reason in Notes). `already verified` is for a scenario that was already verified on a real machine when it was registered: write where the evidence is in Notes, and do not schedule it into a batch. Update the table once per batch and note next to the table which batch it reflects.

## Exemptions

| Source ticket | Category | Statement of the observable surface | Registered by | Accepted by the facilitator |
| --- | --- | --- | --- | --- |
| none yet | | | | |

## Batch records

| Batch | Time | Version and commit | Artifact sha256 | Passed / failed / not tested | Result comment |
| --- | --- | --- | --- | --- | --- |
| none yet | | | | | |

## Candidate and release difference audit

When the candidate commit of the last verified batch differs from the release commit, write one line here saying why the difference is acceptable (the pre-release check reads this line, and its wording is fixed):

- Candidate commit <40-char lowercase commit> → release commit <40-char lowercase commit>: <one sentence on why the difference is acceptable, for example "after the candidate there are only documentation and tooling commits; the plugin artifact did not change">

When the two are the same, write "none" and say why no audit is needed, for example "the last batch is a clean build of the release commit".

## Pre-release reconciliation

- [ ] Every row of the scenario overview is `already verified`, `passed` or `exempt` with the exemption accepted.
- [ ] The "corresponding commits" in the CHANGELOG have been checked ticket by ticket against the commits merged since the previous release, and every ticket that affects users has a scenario block.
- [ ] The difference audit is written: "none" with the reason when the candidate commit equals the release commit, otherwise why the difference is acceptable.
- [ ] The number of rows, the per-status counts and the number of source tickets in the overview table agree with the count sentence at the start of `## Scenario overview`; every row can be traced to a comment (the source ticket's scenario block or a batch result), and every scenario registered in a comment is in the table.
- [ ] The closing comment of this ticket carries the passed/failed/exempt count line, and it agrees with the tally of the overview table (scenarios verified during development count as passed).
<!-- checklist-template:end -->
