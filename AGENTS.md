# Agent Instructions

This file gives an agent working in this repo the context it needs to operate well.

## Agent skills

### Issue tracker

Issues live as GitHub issues; read and write them through the deck tools (`deck_*`), not hand-written tracker commands. See `docs/agents/issue-tracker.md`.

After you upgrade the plugin, or when a deck tool reports an error, a receipt is judged invalid, or the tools as a whole are unusable, run the self-check first and then handle it as the "tool failure" section（工具故障）of `docs/agents/issue-tracker.md` says.

### Triage labels

Five triage roles (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`) plus five wayfinder labels (`wayfinder:map` / `research` / `prototype` / `grilling` / `task`). When a ticket is created, **the type label follows the position and the triage state is decided by the state machine**: an exploration map gets `wayfinder:map`, a map ticket gets the one `wayfinder:<type>` passed in the call, a bug ticket gets `bug`, and a plain ticket gets no type label. A position default is filled in **only when no triage state is given explicitly** (a spec and the spec tickets under it default to `ready-for-agent`, a bug ticket defaults to `needs-triage`); when the caller passes a state explicitly, the caller's choice wins. A ticket carries at most one triage state at any moment: changing the state replaces it rather than stacking, and passing two or more in one call is rejected as a whole. A wayfinder map and its child tickets carry only wayfinder labels and never stack a triage label such as `ready-for-agent` on top (those are decisions, not implementation work). The three labels `bug` / `needs-triage` / `wayfinder:grilling` are still kept: they are the entry points for the panel's three actions "fix", "diagnose" and "discuss", not a required item on every new ticket. See `docs/agents/triage-labels.md` for details.

### Domain docs

Single-context layout — root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Config ownership

Before you add a new value, or want to move a value into a data file under `config/`, read `docs/adr/20261021-config-ownership.md` first. In one sentence: a value is defined in exactly one place; whether a value should stay in the code or move into a data file is decided by asking "can the compiler connect the two copies directly" — when it can, connect them with imports; only when it cannot do you move the value into a data file and set up a generator and a gate.

### Coding standards

Reviewers check judgement rules in `CODING_STANDARDS.md`.

### Asking questions

When a person has to make the call, prefer the harness's native question tool (for example `ask_user_question`, which lets each question carry several options) over writing a manual `❓ Q1, Q2 …` list. The tool only holds option labels and a short custom text, so write the full background in the conversation body first and use the tool for the choice itself: one question per decision, each with a recommended answer. If the session has no such tool, ask directly in the conversation body instead.

This reverses the earlier rule in this section, which said never to use a popup-style question tool. The reversal was decided in [#43](https://github.com/risaddex/dsh-skills-deck/issues/43); see `.out-of-scope/popup-question-tool.md` for the history.

### Human-first wording

Every piece of text written while carrying out a task — conversation replies, issue titles and bodies, markdown documents, code comments, any file — takes "a human understands it accurately on the first reading" as its first standard: use only words that `GLOSSARY.md` defines or whose meaning was already established in earlier exchanges; when a new concept really has to be expressed, write it as a complete, plain description rather than coining a shorthand or a metaphor that then needs explaining. Satisfy what a person can read first, and talk about what is convenient for a machine after that — an AI can read plain complete sentences, but it will invent shorthand for the reader that only makes sense in this one session.

**Before you send anything out, stop for a second and ask yourself:**
1. Can someone who has not read the earlier text understand directly what this sentence is saying?
2. Have I used a name that only this conversation understands? If so, change it to plain language.
3. Is the new thing explained in one whole sentence, instead of just dropping a word and leaving others to guess?

### Commit message convention

Every `git commit` message must be written in English, in fluent, complete sentences that say what this change changed and why it changed. The title must be at least ten words long; do not just write `fix` / `update`. See `docs/agents/commit-convention.md` for details.

### Commit and push promptly

As soon as a module that can be delivered on its own is finished, commit the code and push it to the remote right away, so that local changes are not lost to a mistaken operation or a switch to another machine. Do not save several modules up and commit them all at once.

Use only commands that cannot lose files and do not rewrite history, for example `git status`, `git diff`, `git log`, `git add`, `git commit`, `git push`, `git pull --ff-only`. Commit messages follow the English requirement in "Commit message convention" above.

Before committing, run `git status` once to see which files this change actually touched, and `git add` only the paths this task touched; do not grab everything with `git commit -a` or `git add -A` — the same working tree may still hold changes another session has not committed, and grabbing everything drags other people's work into your commit, or takes files they have already staged away ahead of them.

Do not use any command that could lose files or rewrite history, for example `git reset --hard`, `git checkout .`, `git clean -f`, `git push --force`, `git rebase`, `git filter-branch`. When you are unsure whether a command might lose data, stop and ask a person first; do not try it yourself.

### Parallel sessions: when one workspace holds several sessions

By default each session goes to work in its own worktree, installs its own copy of the dependencies and builds on its own, and different trees never have to queue for each other; a second build writer in the same tree queues on a file lock. The repository itself is shared: there is only one copy of the branches, of `refs/stash`, and of which tree the panel looks at; the interface entry point also points at only one tree at a time — to see the interface result, point the profile install directory at that tree temporarily as `docs/agents/parallel-sessions.md` describes, and restore it after looking. Check `git status` before committing, stage only the paths you have confirmed yourself, and one branch belongs to one session at a time. The complete steps are in `docs/agents/parallel-sessions.md`.

### TypeScript first: old JS migrates as you touch it, and in the end only TS remains

The end goal is that the hand-written code in the project is only TypeScript, with no hand-written JavaScript (the `.js` produced as build output and generated from derived files does not count). From now on, whenever a requirement, a bug fix, planning or a design touches this plugin's hand-written code, write it in TypeScript first; existing JavaScript is not rewritten as a separate project but converted in the "convert whatever you touch" way, until the count reaches zero. This rule inherits the wording in `tsconfig.client.json` — "convert whoever you touch, no big bang" — and extends it to the whole repository.

1. Work file by file: fix first, convert second, in two commits, and never add hand-written JS again: commit a pure fix once, then commit the conversion of that file to TypeScript, with zero behaviour change after the conversion. Convert only the files this task really touches; every file added later is written as `.ts` (including `.mts`/`.d.ts`). Derived files (for example `scripts/generated/*`), the automated checks themselves and temporary directories are never converted. The zero target means hand-written `.js` reaches zero; build output does not count.
2. Once converted, wire it into the build: register it in the matching `tsconfig`'s `include` and in the `scripts/build.mts` list (an unregistered file is silently not compiled), keep `target ES2020`, `strict` and `noEmit` plus `esbuild` transpilation, and the work is done only once `tsc -p`, the build, the related `tests/verify-*` and the smoke runs all pass. While you are there, delete the matching line from the two ratchet lists (in `tests/handwritten-js-baseline.json` delete that line directly; for a test file, also run `node tests/verify-unmigrated-tests.ts --record-baseline` once to re-record `tests/unmigrated-tests-baseline.json`) — a path left in a list that can no longer be found in the tree turns both gates red, and the reason is written in each list's own `note` and error message.
3. Once converted, bring the comments up to par: for public functions, types and key branches, use complete Chinese sentences to say clearly why it is this way, which conventions must not be changed and what the counter-examples are; do not restate the type names. For a model, look at the start of `src/shared/label-color/src/colors.ts`.
4. Once converted, add logging along the way, following the next section "Logging instrumentation discipline", with troubleshooting first and "log a lot, but no junk" as the standard.

### Running the gates: pick a tier first, do not default to the whole chain

The gates come in three tiers; picking the wrong tier either makes you wait for nothing or makes you miss a run. Three common ways to run them:

- Change one place, verify one place: run only that one gate — `node --import ./scripts/ts-hook.mts tests/verify-xxx.ts`; to spot-check by name, use `node scripts/verify-chain.ts --only <a fragment of the file name>`.
- A module is finished: `npm run verify:changed` (runs only the gates this change can affect, on the order of tens of seconds).
- Before committing: `npm run verify:parallel` (the whole chain, 8-way concurrency, and after the main chain finishes it runs the five smoke runs serially; about one minute when the build cache is ready). The serial whole chain `node scripts/verify-chain.ts` is used only for diagnosing ordering problems.
- To read the result of the last run without decoding its JSON: `npm run verify:last` (five lines; exits non-zero when a red gate is not on the register).
- A type error inside a package's own type (`.d.ts` from `node_modules`) is a stale install, not broken code: run `pnpm install --frozen-lockfile --prefer-offline` before editing anything. Both cases are in [docs/agents/verification.md](docs/agents/verification.md) §1.5.

When a change touches `tests/**`, `scripts/**`, `docs/**` or any `*.md`, the selection rule decides "the whole chain is required"; that is deliberate, not a bug. How to pick a tier, what each tier cannot detect, and how to read a two-thousand-line gate while sparing context are all in `docs/agents/verification.md`.

Two mechanical traps, each already made cheap by the repository, so neither needs remembering:

- **Rewriting a whole Markdown file**: `tests/verify-md-sections.ts` goes red when a modified `.md` (staged or not) has fewer `## ` sections than at HEAD. It counts sections, so it does not notice an emptied section body; it follows `git mv` only while the cut is still unstaged; a rename plus a cut of more than half the file staged together, or a plain `mv`, looks like a delete plus a new file and is not checked. The `read` tool can return part of a file: compare its `totalLines` with the lines returned before writing the file back. A deliberate removal is registered as `{ path, from, sections }` in `docs/agents/md-section-removals.json`, and the gate fails only for an entry that describes nothing (the file is not at the registered count at HEAD); once the cut is committed the entry is harmless, and deleting it is tidiness, not a requirement.
- **Trying a function or a package from a scratch file**: `node scripts/probe.mts --eval "<code>"` (or `- < file.mts` when the code has quotes or `$`) runs it with the `.ts` hook loaded and removes its temporary file; do not create files in the repository root for this.

Since 2026-10-26 the remote no longer carries the responsibility of adjudicating verification (#1542, which removed `.github/workflows/verify.yml`, so neither pushing to main nor opening a PR runs verification automatically any more). Local verification is the only adjudicating standard, and the rule is fixed in three lines: running the chain locally must use Node 24.15 or newer (running the chain on Node 22 is itself the loading failure recorded in #1523, and produces a large number of failures unrelated to the content of the code); `npm run verify:parallel` is the only adjudicating entry point and must be run every time before committing and before pushing; before merging, the requirement is that, apart from the known reds on the register, truly red runs across the whole chain are zero. For the background, see `docs/adr/20261026-cancel-ci-verify.md`.

### How tests load .ts directly (the Node floor and the install guard)

Before running tests with `scripts/ts-hook.mts`, changing test entry points or migrating scripts to TypeScript, or investigating Node compatibility and install guards, read [How tests load .ts directly](docs/agents/test-loading.md).

### Logging instrumentation discipline (read the umbrella ticket #502 first: the logging system follows an overall outline, with one place to look things up)

Goal: once a flow that crosses an opaque boundary is done, an AI can say where it got to and where it stopped purely from the local diagnostic logs, without a person having to fill in the gaps. The more logs the better, but collect signal only, never junk.

1. Leave a full trace of a run at three kinds of boundary only: process or module boundaries, persistence boundaries and time boundaries. Each run contains a summary of the input at the start, the reason for a branch, the result of an external call plus its duration, state changes and the conclusion at the end; an exception line states clearly the step name, the input summary, where the expectation and the reality differ, and the upstream cause. The old set of five kinds are examples of these three. Tie one run together with the existing keys first (short workspace fingerprint, method name, time).
2. Four kinds of junk, never added: repeated heartbeat lines with no change, a line that records only the result and not the reason, pouring a whole object into the log, and high-frequency recording with no switch check. Before adding a line, ask one question: which failure can this line rule out, and where does it point the next investigation — if you cannot answer, do not add it. Event names and field meanings stay stable; when a meaning changes, emit a new event.
3. Quantity and content are two layers: an always-on minimum that is just enough, relaxed on demand; sampling, throttling and outer switch checks follow chapter 3 of `docs/design/335-logging-contract.md`. There is only one hard red line: replayable credential plaintext never reaches disk (tokens, password key-values, authorization headers). Errors in path and title are relaxed in the on-demand layer to the point of being locatable, but until the gates and the tables are changed to be tight or loose by tier, record them per the current allowlist.
4. Acceptance is graded: walk a new flow or a core path once with the export package of the day and locate it from the logs alone; if that does not work, instrumentation is missing; a pure refactor, added comments or a type migration is exempt from the drill. Before starting, get the related `tests/verify-log-*` passing, and change the comparison table in chapter 1 of `research/489-appendix.md` whenever events are added or removed; the current counts are whatever that appendix says. When something goes red, add the logging points first, then talk about functionality.

### Terminal discipline

When you run a command by hand, use the sidebar terminal that DSH provides natively (the "Terminal" tab in the right sidebar; write the tab title as `<ticket number>-<purpose>` so you can look back at it later). This terminal comes with DSH and has nothing to do with better-sidebar — since version 0.21, better-sidebar has removed the terminal it used to ship.

On the AI side there is no usable terminal tool (better-sidebar removed the `terminal_*` tools it shipped, and `dsh-tool-terminal`, the DSH-side counterpart, is not installed on this machine either), so a sidebar terminal cannot be opened; therefore every command the AI runs is executed with the system-native `pwsh` tool; say in the conversation body what you are running and why.

Tool arguments must not contain `undefined` (an optional parameter is either not passed at all or given a value); when a `lossless JSON` error is reported, drop that parameter or give it a value, and retry the same tool call once.

### Real-machine verification checklist

Every version that is going to be published has a checklist ticket titled `[真机验证] <version number>` — the bracketed prefix stays Chinese because `scripts/lib/release-checklist.mts` matches it literally; the actions for closing the ticket and for before and after publishing are all written in this one rule document, see `docs/agents/real-machine-verification.md`.

A failure met during real-machine verification that arises because the current feature's development is not complete enough must be fixed inside this ticket and re-verified until it passes; opening a separate ticket for it is not allowed. Only an existing defect that is confirmed unrelated to this change and does not affect this ticket's acceptance may be opened as a separate ticket; a separate ticket requires the user's explicit approval, and this ticket must state plainly "not fixed this time, with the reason and the impact".

### Release publishing

Before publishing a release, choosing its packages, handling a publishing token or checking registry acceptance, read [Release publishing](docs/agents/release-publishing.md).
