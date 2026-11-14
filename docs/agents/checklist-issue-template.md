# Template for a release's real-machine verification checklist ticket

This ticket collects the real-machine verification a version needs: one ticket per version that is going to be released, and the title is always `[真机验证] <version>`. Below it is called the **checklist ticket**. The rules are in [real-machine-verification.md](real-machine-verification.md).

## Chinese text that must stay exactly as written

The page is in English, but the release scripts and the published verifier in `dsh-featherhunter-plugin-base` still match some Chinese text character for character. Until a release of that package accepts English as well, write these pieces exactly as shown, in the title, the body and the comments; everything else may be English.

| Where | Exact text | What it means | Who reads it |
| --- | --- | --- | --- |
| Title prefix | `[真机验证]` | real-machine verification | `scripts/lib/release-checklist.mts` and the published release gate |
| Placeholder title word | `下一版` | next version | the same two |
| Body placeholders the release scripts fill in | `<版本号>`, `<上一发布版本>` | version, previous released version | `fillChecklistTemplate` in `scripts/lib/release-checklist.mts` |
| Scenario overview heading | `## 场景总览` | scenario overview | the consistency checker and the published gate |
| Overview column names (inside the header cells) | `场景编号`, `来源票`, `状态` | scenario number, source ticket, status | the same two |
| Empty overview row | `（暂无）` | none yet | the consistency checker skips this row |
| Status cells | `待验证`, `已验证`, `通过`, `失败`, `豁免`, `未测`, `阻塞`, `作废` | to be verified, already verified, passed, failed, exempt, not tested, blocked, void | the same two; keep the status cell to the Chinese word alone and put explanations or ticket links in Notes |
| Count sentence at the start of the overview | `N 条场景`, `M 张来源票`, `K 条「<status>」` | N scenarios, M source tickets, K with that status | the consistency checker compares them with the table |
| Batch records heading | `## 批次记录` | batch records | declared in the published checklist format |
| Difference audit heading and line | `## 候选与发布差异审计`, `- 候选提交 <40-char commit> → 发布提交 <40-char commit>：<reason>` | candidate and release difference audit; candidate commit → release commit | the published release gate |
| Reconciliation heading | `## 发布前对账` | reconcile before the release | the consistency checker reads counts in this section |
| Scenario block heading in a comment | `## 场景块：<source ticket number> <one English sentence>` | scenario block | the consistency checker and the published gate |
| Batch identity and baseline lines in comments | `- 验证身份：批次 …；候选提交 …；候选包 sha256 …`, `- 验证基线：本地 … …；目标版本 …` | verification identity, verification baseline | the published release gate; copy them verbatim from `batch open` |
| Closing count line | `[发布就绪] 通过 N / 失败 M / 豁免 K` | ready to release: passed / failed / exempt | the consistency checker and the published gate |
| Closing-only phrases | `发布就绪`, `验证收口`, `收口关闭`, `已登记场景` | ready to release, verification closed, closing closed, registered scenarios | the consistency checker treats any comment with one of them as the closing comment |

## Creating the ticket

1. **Search first**: use `deck_issue_list` to search titles for `[真机验证]` and see whether this version's checklist ticket already exists. If it does, do not create another one; merge any duplicate into the earlier ticket.
2. **Settle the version**: if the version is settled, put it straight into the title. If it is not settled yet (early in development), create a placeholder ticket titled `[真机验证] 下一版（自 <previous released version> 之后）` and rename it during release preparation.
3. **Create it**: use `deck_issue_create` with `kind: 'issue'`, the title in the format above, and the body template below (replace the parts in angle brackets).
4. **Labels it does not get**: this is a tracking ticket of the release process, so it does not get `bug`, `needs-triage` or `wayfinder:grilling` (it is none of those three kinds of work); it is recognised by its title prefix.

## Who creates it

- Normal path: **whoever closes the first source ticket of the version**. Before closing that ticket, search for the checklist ticket and create it if there is none.
- After a release: the post-release script `scripts/release-postflight.mts` creates the next version's placeholder checklist ticket automatically.
- Fallback: if the release owner finds no checklist ticket during release preparation, they create one and backfill the scenarios. If two people create one at the same time, the later one searches again before posting any "add scenario" comment; when an earlier ticket exists, move the content there, close their own ticket and write "duplicate, merged into #<earlier ticket>".

## Closing the ticket

- The ticket may be closed when every registered scenario is `已验证` (already verified), `通过` (passed) or `豁免` (exempt) with the exemption accepted. A scenario already verified on a real machine during development is marked `已验证` with the source of the evidence, and is not scheduled into a batch.
- When closing, write one count line in the closing comment so readers see the result at a glance: `[发布就绪] 通过 N / 失败 0 / 豁免 M` (ready to release: N passed, 0 failed, M exempt).
- The pre-release check verifies five things: this version has exactly one checklist ticket; it is closed; its record is internally consistent (the numbers and statuses in the body's scenario overview agree with the scenario blocks, batch results and closing counts in the comments); every batch comment carries the candidate identity line; and every candidate commit is an ancestor of the release commit (when the candidate commit and the release commit differ, the ticket has a difference audit line saying why the difference is acceptable). The counts take part in the check: the total, the per-status counts and the release counts the body states must agree with the actual tally of the overview table; where they do not, the script lists each mismatch and the release waits until it is fixed.
- After the version is really released, add one last comment (released version and time, the counts, where the evidence is, the CHANGELOG commit). The ticket stays closed.
- Post exactly one closing comment, and only when the checklist ticket really closes. Batch comments and batch result comments must not contain the four closing-only phrases (`发布就绪`, `验证收口`, `收口关闭`, `已登记场景`) nor a slash count line such as `通过 N / 失败 M`: the pre-release check would treat them as closing comments and compare their counts, and historical comments must not be rewritten. The full reason is in section 3 of [real-machine-verification.md](real-machine-verification.md).
- A comment is never edited after it is posted. To correct one, post a new comment that says which sentence of which comment it corrects and why.

## Body template

Copy everything between the two markers below and replace `<版本号>` and `<上一发布版本>` with the real values (the release scripts do this replacement themselves when they create the placeholder ticket).

<!-- checklist-template:start -->
> **This ticket is a release's real-machine verification checklist**, not a development ticket. The rules are in [docs/agents/real-machine-verification.md](https://github.com/risaddex/dsh-skills-deck/blob/main/docs/agents/real-machine-verification.md); the Chinese headings, status words and fixed lines below are matched verbatim by the release check, so keep them exactly as written.

## Purpose

Collect every scenario of this version that needs real-machine verification in this ticket, and verify them one by one here before the release. A source ticket may be closed without real-machine verification, but before it is closed its scenarios must be registered in a comment on this ticket.

## Version scope

- Version: <版本号>
- Previous released version: <上一发布版本>
- Scope: the changes merged into main after the previous released version and shipped with this version, as listed under "corresponding commits" in `CHANGELOG.md`.

## 规则（给读票的人）

Rules for readers of this ticket. This heading and `## 豁免` below retain the names used in the local checker's repair instructions.

- Scenario details go into comments: one scenario block comment per source ticket, headed `## 场景块：<source ticket number> <one sentence>`. The body does not hold scenario details.
- The verification facilitator maintains the three tables in the body: scenario overview, exemptions and batch records.
- Closing condition: every registered scenario is `已验证` (already verified), `通过` (passed) or `豁免` (exempt) with the exemption accepted. A scenario already verified on a real machine during development is marked `已验证` with the source of the evidence, and is not scheduled into a batch.
- The pre-release check confirms that this version has exactly one checklist ticket and that it is closed, checks that the body and the comments agree (scenario numbers, each scenario's conclusion, every count), and requires every batch comment to carry the candidate identity line and every candidate commit to be an ancestor of the release commit (with a difference audit when they differ). Anything that does not agree is listed with how to fix it, and the release does not go out until it is fixed.

## 场景总览

Scenario overview. When the table has rows, state its totals using `N 条场景` (N scenarios), `M 张来源票` (M source tickets) and `K 条「<status>」` (K with that status), replacing the letters with the actual counts. Do not leave illustrative numeric counts here: the checker reads them as claims about this table.

| 场景编号 (scenario number) | 来源票 (source ticket) | One sentence | 状态 (status) | Notes |
| --- | --- | --- | --- | --- |
| （暂无） | | | | |

Status cells hold exactly one of: `待验证` (to be verified) / `已验证` (already verified) / `通过` (passed) / `失败` (failed; put the `→ #<ticket>` reference in Notes) / `豁免` (exempt) / `未测` (not tested) / `阻塞` (blocked) / `作废` (void, with the reason in Notes). `已验证` is for a scenario that was already verified on a real machine when it was registered: write where the evidence is in Notes, and do not schedule it into a batch. Update the table once per batch and note next to the table which batch it reflects.

## 豁免

Exemptions.

| Source ticket | Category | Statement of the observable surface | Registered by | Accepted by the facilitator |
| --- | --- | --- | --- | --- |
| （暂无） | | | | |

## 批次记录

Batch records.

| Batch | Time | Version and commit | Artifact sha256 | Passed / failed / not tested | Result comment |
| --- | --- | --- | --- | --- | --- |
| （暂无） | | | | | |

## 候选与发布差异审计

Candidate and release difference audit. When the candidate commit of the last verified batch differs from the release commit, write one line here saying why the difference is acceptable (the pre-release check reads this line, and its Chinese wording is fixed):

- 候选提交 <40-char lowercase commit> → 发布提交 <40-char lowercase commit>：<one sentence on why the difference is acceptable, for example "after the candidate there are only documentation and tooling commits; the plugin artifact did not change">

When the two are the same, write "none" and say why no audit is needed, for example "the last batch is a clean build of the release commit".

## 发布前对账

Reconcile before the release.

- [ ] Every row of the scenario overview is `已验证`, `通过` or `豁免` with the exemption accepted.
- [ ] The "corresponding commits" in the CHANGELOG have been checked ticket by ticket against the commits merged since the previous release, and every ticket that affects users has a scenario block.
- [ ] The difference audit is written: "none" with the reason when the candidate commit equals the release commit, otherwise why the difference is acceptable.
- [ ] The number of rows, the per-status counts and the number of source tickets in the overview table agree with the count sentence at the start of `## 场景总览`; every row can be traced to a comment (the source ticket's scenario block or a batch result), and every scenario registered in a comment is in the table.
- [ ] The closing comment of this ticket carries the passed/failed/exempt count line, and it agrees with the tally of the overview table (scenarios verified during development count as passed).
<!-- checklist-template:end -->
