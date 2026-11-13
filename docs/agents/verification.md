# How to pick gates and how to run them

This document is written for someone picking up this repository for the first time. It makes five things clear: how many tiers of gates the repository has, when each tier runs, and what each tier cannot test; how the rule "pick the gates according to which files this change touched" was decided; which known holes that rule has; how to re-run the ownership map and how to add a new gate; and how to investigate a build output that has gone stale. Section 5 also has a short subsection, "Reading one large gate", about how to read only the criterion when context is limited, instead of reading the whole file.

The concrete numbers in this document (how many steps, how many files covered) come from measurements taken on 2026-10-12 and 2026-10-20, and are only there to give you a sense of the scale. The chain is still getting longer, so by the time you read this the numbers have most likely changed — run `node scripts/gate-map.mts --print` once to see the current values. Only two places are authoritative when you work something out: the chain's list and stages are in `scripts/verify-stages.json`, and the ownership map is the generated `tests/gate-map.json`.

## 1. Get clear on three things first

- **`scripts/verify-stages.json`**: the chain's list and stages (a directory convention plus an explicit exclusion
  table, #1125). Every step looks like `node tests/verify-xxx.ts` and runs one independent Node script under
  `tests/`. **This is the only source of the gate list**, computed by `planGates()` in
  `scripts/lib/discover-gates.ts`: scripts under `tests/` whose names match `verify-*` are discovered
  automatically and assigned to a stage by the stage table's `match`, landing by default in the stage whose
  `match` is empty. `package.json`'s `scripts.verify` is now nothing but the single line
  `node scripts/verify-chain.ts`; do not copy the list anywhere else — a copy is guaranteed to drift away from it.
- **`tests/gate-map.json` (the gate ownership map)**: a generated file that answers "which source paths does each
  gate guard". It is produced by the scan in `node scripts/gate-map.mts`; **do not edit it by hand**.
- **`scripts/lib/select-gates.mts` (the selection rules)**: answers "given these changed files, which gates should
  run". The input is the change list; the output is the steps on the `verify` chain that should run, plus the
  reason each step was chosen.

The gates themselves are `tests/verify-*`. `tests/` currently holds about three hundred of these scripts, and
about three hundred steps of them are on the chain; the ones not on the chain are for local investigation and do not run
automatically before a commit.

## 2. Gates come in three tiers

| Tier | How to run it | When to run it |
| --- | --- | --- |
| Fast tier (one gate, or a few) | `node --import ./scripts/ts-hook.mts tests/verify-xxx.ts`; to spot-check by name, use `node scripts/verify-chain.ts --only <a fragment of the file name>` | While writing code, verifying each change as you make it |
| Affected tier (only the gates this change can reach) | `npm run verify:changed` (reads this change's file list from git) or `node scripts/lib/select-gates.mts <which files changed...>` (you report the change list yourself) | When a module is finished, as a self-check before committing |
| Whole-chain tier (about three hundred steps of the main chain plus five smoke runs at the end) | `npm run verify:parallel` (runs the main chain 8 ways in parallel, running even the red steps to completion before summarising; the failing steps are then re-run once serially to rule out mutual interference; after the main chain it runs the five smoke runs serially in `package.json`'s `scripts.smoke` order, and a red smoke run also counts as an overall red) | Before committing and before pushing, **every time** |
| Whole chain, serial | `node scripts/verify-chain.ts` (stops at the first red one, which makes fixing easier) or `node scripts/verify-all.mts` (runs everything, then summarises) | When you want to read the output in order, or when a parallel run has behaved strangely |

Since 2026-10-26 the remote side no longer carries the job of deciding verification: `.github/workflows/verify.yml` has been removed (#1542), so pushing to main and opening a PR no longer run verification automatically. Local verification is the only adjudicating standard, and the rule has three parts: running the chain locally must use Node 24.15 or newer (running the chain on Node 22 is itself the loading failure recorded in #1523); `npm run verify:parallel` is the only adjudicating entry point and must be run before every commit and every push (since #1643 it covers the main chain and the five smoke runs in one go, and `npm test` and `npm run test:smoke` still work but neither of them is an adjudicating entry point); before merging, apart from the known reds that are on record, the number of true reds on the whole chain must be 0 (for example the failures unrelated to the Node version that #1541 tracks). The reasoning behind these three parts is in `docs/adr/20261026-cancel-ci-verify.md`.

The measurement on 2026-10-12 (a 28-core machine): 228 steps took 517 seconds serially; 8-way parallel took about 36 seconds when the source had not changed, and about 66 seconds when the source had just changed (a real build has to run). The chain has about three hundred steps today; the order of magnitude holds, and the absolute numbers grow with the length of the chain. In a parallel run the log timestamps the start, end and duration of every step; a step that goes red in a parallel run is automatically re-run once serially, and one that only goes red on that re-run is marked `flaky` (which means the parallel runs interfered with each other, not that the code is broken); only a step that is still red after the re-run is a true red.

The smoke stage (#1643) comes after the main chain and after "the red steps are re-run serially": the five smoke runs are run serially in `scripts.smoke` order (one of them temporarily changes the working directory, so the order must not be disturbed), and they no longer take part in the parallel re-run that filters out false reds. `--only` and `--changed` spot checks and a main chain that stops at the first red do not run it, and the summary says outright that the smoke stage did not run — the line it prints is （`冒烟阶段：没跑`） followed by the reason — so "did not run" is always stated outright, never left for the reader to guess from the output. The machine-readable result is in the `--json` output's `smoke` field (`ran` / `reason` / `red` / per-entry results); the top-level `red` is the total red count of the main chain plus the smoke stage, and `chainRed` lists the main chain separately.

**What each tier cannot test**:

- The **fast tier** only proves that the one gate you ran is itself green. It knows nothing about which other gates this
  change can still reach, whether it turned some other gate red, or whether the build outputs have kept up with the source.
- The **affected tier** runs only the gates the selection rules can circle out; relations the rules cannot circle out go
  untested (the five holes in section 4 are the example). What it saves is time, so it cannot serve as the last gate
  before a commit.
- The **whole-chain tier** covers every gate on the chain, and at the end it runs the five smoke runs from `package.json`'s
  `scripts.smoke`, so both the main chain and the smoke side count as judged. It still cannot test the things
  outside the chain: the two matrix scripts `scripts/matrix-smoke.ts` and `scripts/matrix-full.ts`, and the
  release flow, each have to be run on their own. Nor do the holes in section 4 disappear just because everything ran —
  the chain never had gates living in those places.
- **Whole chain, serial** (`node scripts/verify-chain.ts` or `node scripts/verify-all.mts`) covers only the main
  chain and **excludes the smoke stage**: all it adds is "read the output in order" and "a baseline to compare against
  when a parallel run behaves strangely"; its verification strength is less than the whole-chain tier, and it cannot
  replace it.

To skip the real-browser gates you can run `npm run verify:fast` (equivalent to `--tier fast`); it is one layer short of the whole-chain tier, so do not use it in place of the whole chain before a commit. The smoke stage still runs — none of the five smoke runs is a real-browser step.

The parallel run is fast because of three things, none of which changes the criterion of any single assertion:

1. **The slow steps are waiting, not computing.** CPU sampling showed that, of the slowest gate's 31.8 seconds, 31.7
   seconds were idle, so parallelism saves time almost linearly.
2. **Schedule from longest to shortest, and merge mutually exclusive steps into one train car.** Each step's measured
   duration from the previous round is recorded in `node_modules/.cache/dsh-verify-times.json` (which does not go
   into the repository); steps that compete for the same resources (`npm pack`, a real build) are merged into a
   single car, run one after another by the same worker, so that two workers never run `npm pack` at the same time
   and produce a false red. At the head of the car a pre-build runs first, so the gates after it all hit the build cache
   and never read a half-stale output. To look at the schedule, run `node scripts/verify-parallel.mts --tasks`.
3. **The build is cached, and build-output freshness is judged by content.** `node scripts/build.mts` first compares
   "the content fingerprint of the hand-written inputs" with "the hashes of the outputs from the last successful build";
   if neither has changed it skips those 30 seconds (a dozen-odd gates on the chain each run a build). The cache lands in
   `node_modules/.cache/dsh-build.json`; to force a rebuild use `node scripts/build.mts --force`. The
   criterion is "the output is byte-for-byte identical to the last successful build", not "the build never ran, so we do
   not know"; when inputs change, or an output was edited or deleted by hand, a full rebuild happens as usual.

   The eight freshness gates (`verify-ctx`, `verify-kernel`, `verify-leaves`, `verify-parse-leaf`,
   `verify-tabsfold-leaf`, `verify-platform-contract`, `verify-log-client`, `verify-log-artifacts`)
   and the two matrix scripts read the same criterion (`judgeProducts` in `scripts/lib/build-cache.mts`): when
   the cache is usable they compare the output's content digest; only when the cache cannot be read, when the build inputs
   changed again after the last successful build, or when the record does not contain this output, do they fall back to
   judging by modification time, and print one `INFO` line giving the reason, the affected outputs and how to
   recover — never silently. For what to do when you see that kind of `INFO`, see section 7.

   One more gate, `verify-1327-freshness-content`, is the regression gate for the criterion itself: it verifies the
   criterion directly in a temporary directory, and it also judges the four entry outputs on the real tree; what it guards
   is that the criterion does not regress, so it is not one of those eight "gates that use the criterion".

When two people in the same workspace run a build at the same time and both miss the cache, the later one queues on the build lock （the terminal prints `在后面排队等它`, meaning it is queueing behind that build）, and after taking the lock it re-checks the cache once — the earlier one has usually finished the work by then, so the later one hits the cache and exits without building again. The lock covers only the real build; the path that exits at once on a cache hit never touches it, so in ordinary times, when each of you hits the cache, nobody waits for anybody. If it waits more than five minutes without getting the lock it reports an error and exits (writing out the process holding the lock and the lock file, for a human to look at); `--break-stale-lock` is a manual gate, used only after confirming that the old lock has no owner.

The three tiers are not a choice of one; they are three layers of a sieve: use the fast tier while writing code, the affected tier when finishing a module, and **the whole-chain tier before every commit**. Section 4 below explains why the affected tier can never replace the whole-chain tier.

## 3. The selection rules (full version)

`selectGates({ changedPaths, map, chainSteps })` returns `{ steps, reasons, fullChain, fullChainReason }`: `steps` are the steps on the `verify` chain that should run (in their original order on the chain), `reasons` correspond one-to-one with `steps` and record why each step was chosen, and `fullChain` being `true` means "stop picking, run the whole chain". The rule set **leans everywhere towards "run more rather than miss one"**: when in doubt, run a few more gates, never guess your way into running fewer.

**Rule 1: the change touches a cross-cutting file, so run the whole chain.** If any one of these matches, `fullChain: true`:

- files at the repository root (the build entry, the release manifest, the repository configuration — everything at the
  root is used by everyone);
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`;
- `tsconfig*.json` anywhere;
- `scripts/**` (generators, release scripts, the check chain itself);
- `tests/**` (gates and test fixtures);
- `docs/**`, `research/**`, `specs/**`, and `*.md` anywhere;
- `package/**` (build outputs);
- `src/**/contract/**` (the contract layer — it is a cross-module agreement, so changing one place affects several
  modules at once).

**Rule 2: the change touches a source file that has ownership, so pick gates by walking up the directory levels, then add reverse dependencies.**

- take the directory the file is in and walk up through its parents all the way to the repository root; for example
  `src/client/views/versionControl/VersionControlTab.ts` walks
  `src/client/views/versionControl` → `src/client/views` → `src/client` → `src` → `.`;
- select every gate that the ownership map says **directly guards each of these directories**. Note "directly guards each"
  rather than "accumulates including subdirectories": changing `src/client/views/versionControl/` does not also
  select gates that guard only `src/client/views/cards/`, and this is exactly what the maintainer wanted — "changing
  E runs the three levels E, B and A, without touching the sibling directories C and D";
- **then add reverse dependencies**: whichever files' import graphs can reach this file (directly or transitively), the
  gates guarding those files must run too. This step is the key one. `src/refresh/kernel/host-budget.ts` is
  imported directly by several modules, and more modules depend on it indirectly; going by directories alone, changing it
  would run only the few gates guarding `src/refresh/kernel/`, and a broken consumer higher up would go unseen
  locally.

**Rule 3: the changed file has no ownership, so run the whole chain.** "No ownership" means that the ownership map holds no gate for the directory the file sits in (either the directory key does not exist, or it maps to an empty list). With nobody watching it, its blast radius cannot be guessed, so the only option is to run everything.

**Rule 4: the change touches a gate or the tests themselves.** `tests/**` has already matched in rule 1, so the whole chain runs and that test is naturally in it.

**Rule 5: gates that verify only build outputs run along with the source.** A few dozen gates read only the outputs under `package/` (for example `tests/verify-958-label-name-visible.ts` reads `package/lib/client.js`). The script cannot tell which source file an output was compiled from, so as long as this change touched source code, these gates all run along with it.

Two boundary cases to add: an empty change list (for example, you passed no arguments) is treated as the whole chain; and the paths you pass in may be repository-relative such as `src/client/kernel/styles.ts`, or `./src/client/kernel/styles.ts` written from the repository root, or the backslash form.

**One real example** (changing `src/client/views/versionControl/VersionControlTab.ts`): 75 steps selected out of about three hundred on the chain. These 75 steps are the union of several sources (a union, not a sum) — the gates guarding `src/client/views/versionControl/`, the ones guarding `src/client/views/`, `src/client/` and `src/`, plus the gates that depend on this file in reverse, and finally the few dozen that read only build outputs. Changing one file drops the run from about three hundred steps to 75, and not a single gate guarding those levels is missing. In the same map, changing a low-level shared module like `src/refresh/kernel/host-budget.ts` runs 156 steps — much more than 75, because reverse dependencies pull in all the upstream consumers, which is exactly how it should be.

To see the selection result straight from the command line (the human-readable output):

```
node scripts/lib/select-gates.mts src/client/views/versionControl/VersionControlTab.ts
```

The change list usually comes from the output of `git status --porcelain` or `git diff --name-only`.

## 4. Known holes in this rule set

**These holes are all real, and all of them have been verified, which is why you must run the whole chain once before committing.** The affected tier is there to save time, not to replace the whole chain.

1. **Paths assembled at run time cannot be recognised.** Ownership is inferred from the **string literals** in a gate
   file; once a path is assembled (a variable, a template string, a directory name read from configuration), the script
   cannot see what it reads. A real example: `scripts/gen-fixture-423.ts` extracts CSS rules from
   `src/client/kernel/styles.ts` and generates the fixture `tests/fixtures/423-clamp-repro.html`, while the
   gate `tests/verify-423-title-clamp-browser.ts` reads only that html fixture. So when you change `styles.ts`,
   this browser gate **will not be selected** — the paths it guards sit under `tests/fixtures/`, and there is not a
   single literal clue linking it to `styles.ts`. A gate that cannot be recognised is marked in the map as "no
   source ownership": when you pick by directory it never comes up, and only a full run of the whole chain reaches it. The
   fallback cannot save it either — the fallback looks at whether **the file you changed** has ownership, while the
   problem with this kind of gate is that **the gate itself** cannot say whom it guards.
2. **The correspondence between build outputs and source cannot be seen.** A few dozen gates read only the outputs under
   `package/`, and the script does not know that `package/lib/client.js` is compiled from `src/client/**`.
   Rule 5 covers this bluntly with "any touch on source brings them all along"; the cost is a few dozen extra gates on
   every source change, the benefit is that nothing is missed.
3. **A cross-directory shared agreement has no directory of its own.** Some agreements are obeyed by several directories
   together (the field names of a backend adapter, the message format between the panel and the status bar), and changing
   one place may affect several packages at once. That blast radius is neither in the directory hierarchy nor in the
   import graph, so rule 2 cannot cover it. Once this kind of thing takes shape, it should be given a directory (for
   example `src/**/contract/`), so that rule 1's contract layer covers it.
4. **Files generated at build time.** Some files that gates watch are not hand-written but generated from elsewhere during
   the build (the file header usually says AUTO-GENERATED). Changing the source file that generates it does not cause the
   "reads only the generated file" gate to be selected — there is no import edge between the two. For this kind of file,
   either make its gate guard the source file at the same time, or run the whole chain once more after the generator has
   run.
5. **"Having a gate" and "having a dedicated gate" are two different things; do not mix them.** A gate whose ownership is
   written as a directory (`tests/verify-reuse.ts` and `tests/verify-no-title.ts` name
   `src/client/views`) scans that directory **recursively**, so the files it guards count as "having a gate" — which
   is why the coverage column is full (524 files under `src/`, 0 with nobody guarding them). But whether "this level itself
   has been named" is a different matter: `tests/gate-map.json`'s `coverage.dedicatedDirs` records the latter,
   and `coverage.dirsWithoutDedicated` lists the directories without a dedicated gate together with their file
   counts; the generator's numbers are authoritative for both, so do not copy them by hand. To give a directory a
   dedicated gate, either write a gate for it or add one （`// 门禁归属:`） comment to an existing gate that really
   does guard it — note that the comment **replaces** every clue that gate already had, so write it out in full.

In one sentence: **the ownership map is a map of "who guards whom", not a proof of "who affects whom".** It can frame the blast radius of most changes, but not all of it, which is why the last gate is the whole chain before a commit.

## 5. Day-to-day operations

### Re-run the ownership map

```
node scripts/gate-map.mts            # re-derive and write back tests/gate-map.json
node scripts/gate-map.mts --print    # show the derived result only, write nothing to disk
node tests/verify-gate-map.ts        # the freshness check that guards the ownership map and the selection rules
```

You must re-run it at these moments, otherwise `tests/verify-gate-map.ts` goes red on its freshness assertion (when it fails it prints which segment and which character differ; re-run as it says and you are done):

- `scripts/verify-stages.json` has changed (a gate added, a gate removed, a stage or an exclusion changed);
- a `tests/verify-*.ts` **on the chain** was added or removed (scripts not on the chain do not enter the ownership
  map);
- files under `src/` (including `src/shared/<feature name>/`, where the four compute cores live; they used to
  sit flat at the repository root in `refresh-core/`, `label-color-core/`, `version-control-core/` and
  `config-store-core/`, and were moved in on 2026-10-13 under #1023) were added, deleted or moved — the map's
  directory hierarchy changes with them;
- any gate has newly written a （`// 门禁归属:`） comment, or has changed the files it reads.

**Also re-run it once after adding a new gate**: the map stores "how many steps are on the chain", and the two go out of sync as soon as the chain changes.

### Add a new gate

1. Create `verify-xxx.ts` under `tests/` (from now on everything new is written as `.ts`), copying the
   style of existing gates: one `check(ok, msg)` assertion after another, the number of passing assertions printed at
   the end, and `process.exit(1)` on failure. To let the executor verify "completion evidence" (#1158), hand out a
   `GATE-RESULT` line in the form specified by `tests/lib/gate-result.ts`.
2. The convention is "a directory convention plus an explicit exclusion table": scripts under `tests/` whose names
   match `verify-*` are discovered automatically and enter the chain automatically, landing by default in the stage
   of `scripts/verify-stages.json` whose `match` is empty; only sample gates that stay off the chain for the
   long term need to be registered in the `exclude` table, and both a reason and a ticket number are required (the
   guarding gate `tests/verify-1125-gate-coverage.ts` checks both).
3. Write a （`// 门禁归属:`） comment at the top of the file, spelling out which source paths it guards (the format is
   in the next subsection). This step is optional but strongly recommended — without it the only option is guessing from
   "which literal paths it reads", and guessing is unreliable.
4. Re-run `node scripts/gate-map.mts` to update the ownership map, then run `node tests/verify-gate-map.ts` to
   confirm it is all green. If a merge conflicts because both sides changed the ownership map, do not pick either side;
   regenerate once from the merged tree.
5. Run the gate yourself once and confirm that it **can go red as well as green** (break something on purpose and see
   whether it really stops it) — a gate that is always green is worse than no gate at all.

### How to write the （`// 门禁归属:`） comment

```js
// 门禁归属: src/client/views/versionControl/vcRows.ts
```

- Write it within the **first 4000 characters** of the file (the script looks only at that opening stretch), one path per
  line; several paths means several lines.
- Either `//` or `/* */` works, and the colon may be the Chinese `：` or the English `:`; the path may
  point at a file or a directory, and a trailing slash on a directory is optional.
- Write the path as a **repository-relative path** (`src/...`, `src/refresh/...`).
- **Once it is written, it is the only thing that counts and no other clue is looked at** (file reads, imports and string
  literals no longer take part). So write it out completely: a path you leave out is the same as nobody guarding it.
- If a gate merely "reads a file in passing", that does not count as guarding it — write only what it should stop when it
  fails.

### Pick which gates to run this time

```
node scripts/lib/select-gates.mts <which files changed...>
```

The output is either "run N of the M steps of the whole chain" plus the reason for each step, or "run the whole chain" plus the reason for running the whole chain. To use it inside a script: `import { selectGates } from './lib/select-gates.mts'`.

### Reading one large gate (saving context without missing the criterion)

Gates like `tests/verify-prompts.ts` run to more than two thousand lines; reading one whole into context is expensive, and attention gets eaten by formatting details. Follow the four steps below and what you read is exactly the criterion itself:

1. **Read the file header first.** The first 50 lines usually say what it guards, which items it judges (headings like
   R1–R8) and which summary counts it produces. Know "what question this gate answers" first, then decide whether to read
   further.
2. **Use grep to find anchors, not a full read.** Constant names (`EXPECT_`, `PROTECTED`, `LOCK_`),
   section titles, main function names and summary lines (`PASS` / `FAIL`) are all good anchors:
   `Select-String -Path tests/verify-xxx.ts -Pattern 'EXPECT_|PROTECTED|LOCK_|^(export )?(const|function) '`.
3. **Run it once on its own first, and see what it reports.** The summary line at the end of a gate (for example
   `S1=28 S2=28/28 …`) tells you which surfaces it scanned and how many items each one has, which builds a sense of the
   structure faster than reading code; and when it is red you see straight away which criterion is reporting.
4. **For an older version, read it with `git show`.** `git show <commit>:tests/verify-xxx.ts` prints the old
   content directly; to compare section by section use `git diff <commit> -- tests/verify-xxx.ts`. Do not copy the
   whole file to a temporary file and read it again.

To read a file at a chosen spot, use the `read` tool's `offset` / `limit` (or `Get-Content ... | Select-Object -Skip N -First M`). Never read the same file in full twice: note down the range you have already read and fill in only the stretches you have not read.

Before you start changing anything, run the gate once to confirm that it is green as it stands — otherwise you cannot tell whether "my own change turned it red" or "it was already broken".

## 6. Where to look first when a gate goes red

- **A large area of red, and many lines are `Cannot find module '<third-party package name>'`**: this is
  `node_modules` being broken, not a code problem (when the same missing piece shows up in two or more gates, the
  parallel entry point stops by itself and says so). The fix is to delete the whole of `node_modules` and install
  again: `pnpm install --frozen-lockfile`, which took a dozen-odd seconds on this machine when measured. **Do not**
  delete only one subdirectory under `node_modules/.pnpm`: `pnpm install` will answer "Already up to date", the
  directory does not come back, and you will believe it is fixed when all you did was make the next run red as well.
- **`tests/verify-gate-map.ts` reports that the ownership map is out of date**: re-run `node scripts/gate-map.mts`,
  then look at what changed in `git diff tests/gate-map.json` — the places that changed are usually the ownership
  relations this change really touched.
- **It reports that some file has neither a gate nor a reason**: this means a file under `src/` has appeared with
  nobody guarding it. The right fix is to add a gate for it or to add a （`// 门禁归属:`） comment to one; if it
  genuinely needs no gate (a pure type file, a derived output, a prototype page), add a classification rule to
  `ungatedReasonFor(rel)` in `scripts/gate-map.mts`, write the reason out clearly, and let the ownership map
  put it in the "no gate but the reason is known" class. **Do not delete assertions to make a gate go green.**
- **The scenario tests for the selection rules fail**: this means the selection rules were broken and some scenario has
  started missing gates. Work out whether it really is a miss before you change the rules; these scenario assertions are
  the last line of defence against "quietly running fewer".
- **It reports that the output content does not match the last successful build, reports that the output is missing, or
  the output carries a （`INFO 构建缓存`） line**: read section 7 first and tell apart whether the output content
  really is wrong or this machine has no usable build record.

## 7. How to investigate a build output that has gone stale

Build-output freshness answers only one question: **was this output on disk built from the current source?** It no longer compares modification times but content: the gate reads what the build cache (`node_modules/.cache/dsh-build.json`) records as "what each output looked like at the last successful build", then checks it against the sha256 of the output on disk. Why modification time is no longer looked at: when the cache hits, the build writes not a single byte, so an output's modification time stays at the previous one, and comparing by time would misreport "the source did not change" as stale; conversely, a build that touches the outputs as it finishes (older versions patched things that way) creates a mass of modification-time changes and triggers UI hot reload. A content digest is unaffected by file times — if the source did not change and the output did not change, the digests are equal; if either side changed, they are not.

When investigating, first work out which of the kinds below the gate printed.

### Red: the output content really does not match the last successful build

The failing line contains this passage:

```
产物内容与上次成功构建不一致（可能被人手改过，或构建没跑完）。请运行 node scripts/build.mts 重建。
```

Which output it is comes from the （`产物门禁 <产物>：`） prefix in front of the failing line; the reason does not repeat the output's name a second time.

This says that the digest recorded in the build record and the one for this file on disk do not match: someone edited an output by hand, the last build failed halfway or never finished, or an output was overwritten by a build from another branch or another workspace. **First run `node scripts/build.mts` to rebuild, then re-run the gate that just went red.** If it is still red after the rebuild, it is most likely that this change touched source but the build did not run to completion (or the source changed and no build ran at all), or that the cache record itself is broken: run `node scripts/build.mts` once without `--force` to fill in the "full build" record, then look again. Note that `--force` is only for forcing a rebuild and writes the "--force" grade of record; the "full build" grade that the gates read is not refreshed by it, so when the cache JSON really is broken, running `--force` cannot restore the content criterion. Do not edit outputs by hand to match a digest.

When an output is simply absent, it reports "missing" （the message begins with `缺失` and tells you to run `node scripts/build.mts` first）: this happens on a fresh clone or after the output directory has been cleaned, and one build is all it takes.

### An `INFO` line: there is no usable build record on this machine (which does not mean the source is stale)

The gate may still judge green while printing one `INFO` line. The two common ones:

```
INFO 构建缓存<原因>，这次退回按修改时间判断（受影响产物：……）。要恢复内容判据请运行 node scripts/build.mts（这不是源码过期，是本机没有可用的构建记录）。
```

```
INFO 构建输入在上次成功构建之后有变化（缓存里没有逐个文件的内容摘要，无法指出是哪一份），这次退回按修改时间判断（受影响产物：……）。上次成功构建时间是 <时间>。要恢复内容判据请运行 node scripts/build.mts。
```

The （`<原因>`） in the first line is the specific way the cache is unavailable (it does not exist, the JSON is broken, or its format version does not match the current build). In plain words both lines say: this machine has no usable record of the "last successful build" (switching machines, clearing `node_modules/.cache`, or a fresh clone that has never been built all do this), or the build inputs changed again after the record was made, so this time there is nothing but the old "the source is newer than the output, so it is stale" criterion to fall back on. **It does not mean the source is stale**; run `node scripts/build.mts` once to fill the record in, and from then on judgements go back to the content criterion. If this `INFO` line also comes with a red "expired" line （the message starts with `过期`, says the source is newer than the output and asks you to run `node scripts/build.mts` to rebuild, and notes that this time there was no usable build record so modification time was the only basis, ending with the fallback reason）, that is when the output really is older than the source, and you run the build as usual. The line that a fallback turns red carries the fallback reason, so this one line alone tells you whether the content does not match or this machine has no record.

There is also a third kind of `INFO`: it says that the build record has no content digest for these outputs （it asks whether the output list has changed） — this happens when the output list has changed and the cache still holds the old list; one build is enough.

The build cache's criterion has a boundary: it only answers "is this batch of build inputs the same batch as the last successful one", and it cannot say which input changed — to avoid bumping the cache format version, the cache does not record a per-file content digest. When the inputs do not match, the whole batch has to fall back to judging by modification time, and no single input is named. To pin down which input actually changed, go by the build log, the gate output and `git diff`.

### Which tier to run first

Go narrowest surface → blast radius → whole chain, and at every tier first look at whether it printed red or `INFO`:

1. **Run the red one first** (or the one you suspect): `node --import ./scripts/ts-hook.mts tests/verify-xxx.ts`.
   Usually you will not need to wait for the whole chain — it prints the named output, the reason and a command you can
   copy, all together.
2. **Then run the affected tier**: `npm run verify:changed`. One source change often turns several freshness gates
   red at once (the source sets they watch overlap), and this step confirms whether they share the same cause.
3. **Finally run the whole chain**: `npm run verify:parallel`, to confirm that there is no other freshness problem
   apart from the known reds; the smoke stage at the end has to be all green too (when it is red the summary gives the
   smoke stage its own line, not mixed in with the main chain).

When investigating, the fastest thing is to search the output for these two pieces of text: （`产物内容与上次成功构建不一致`） (red, the content is wrong) and （`INFO 构建缓存`） (a fallback, this machine's record is unusable). To check whether "the cache record itself is broken", run `node scripts/build.mts` once without `--force` to fill in the "full build" record and look again (`--force` is only for forcing a rebuild and writes the "--force" grade of record; it does not refresh the "full build" grade that the gates read, so when the cache JSON is broken, running `--force` cannot get the gates back onto the content criterion).
