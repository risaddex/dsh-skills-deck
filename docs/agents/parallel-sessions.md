# How to work when several sessions develop in the same workspace in parallel (#1321)

> Effective date: 2026-10-22; checked once against the current state on 2026-10-31, with outdated and mutually contradictory statements deleted. Status: usable.
> Versioning and authority follow the rules in `GLOSSARY.md`: when this conflicts with content settled after the date marked in this file, the newer one wins; what is written today is not an immutable baseline, and future changes follow future versions.
> Related: map #1319 · design `docs/design/1323-build-mutex.md` (settled in #1323, implemented in #1365) · measurements `research/1322-worktree-link-probe.md` (#1322) · the list of surfaces where parallel sessions collide `research/1313-parallel-session-resources.md` (#1313) · choosing a tier and picking which gates to run is in `docs/agents/verification.md` · how to write a commit message is in `docs/agents/commit-convention.md`.
> This file writes only the extra rules that parallel work adds. How to pick a tier for the verification chain and how to write a commit message stay where they were; this file only points at them and does not repeat them.

## The principle in one sentence

Each parallel session does its work in its own worktree, installs its own copy of the dependencies, builds on its own, and keeps its own build output and build cache, so different worktrees never queue behind each other. The repository itself is shared: the branches, `refs/stash`, and which tree the panel looks at exist only once; the interface entry point also points at exactly one tree at any moment — use these three according to the rules below.

## When to use a worktree

| Situation | Where to do it |
| --- | --- |
| Writing code, running gates, running the full verification chain, with no need to look at the interface | Your own worktree |
| You need to see this change in the running interface (the interface loads a copy inside the installation directory, so it cannot see a build from any tree; to look at a particular tree, point the installation directory at it temporarily, as described in the "Looking at a worktree's result in the interface" section below) | Any tree will do (usually your own); only one tree at a time |
| Only reading code and investigating problems, with no build | Anywhere; it takes no build slot |

## Working in your own worktree (preferred)

1. Start a worktree from a clean baseline and put a ticket branch in it rather than a detached HEAD — in this repository every module is committed and pushed as soon as it is done, and commits on a detached HEAD are not held by any branch: `git worktree add -b ticket/<ticket-number>-<purpose> .worktrees/<ticket-number>-<purpose> <baseline commit>`. When the ticket already has a branch (pulled from the remote or created elsewhere), drop `-b` and put that branch name in the last slot. A branch can be checked out by one tree only, and git enforces this itself.
2. Install a separate copy of the dependencies inside this tree; do not reuse the main workspace's dependency directory: run `pnpm install --offline --ignore-scripts --frozen-lockfile` in the worktree. A measured run takes about 1.42 seconds and has a logical size of about 124.5 MB (the files are hard-linked through the disk's content store, so the real extra space is small; when the offline package store does not have these packages they are downloaded, and that time is additional).
3. Run builds and the verification chain only in this tree, never back in the main workspace. Once the separate dependencies are installed, the next build hits the cache in about 0.23 seconds and writes no output file at all, and the output is byte-for-byte identical to the main workspace's.
4. Why the main workspace's dependency directory cannot be reused: the whole repository has only one build cache (`node_modules/.cache/dsh-build.json`), so when two trees share one copy of the dependencies with different inputs, each round invalidates the other's cache and both do a full rebuild (measured: about 10.6 seconds for one tree, about 18.9 seconds each with two running at once); when the inputs are exactly the same, the output still differs by 192 bytes (the relative dependency paths in a build-tool comment differ), and the cache is still rewritten back and forth. Saving 124.5 MB costs one extra full build every time.
5. There are many build entry points (build scripts, tests, the automatic preparation after the package is installed, the verification chain's pre-build, the builds a few gates start for themselves, commands typed by hand), and they are all separate processes, so nothing can enforce "remember not to build at the same time". Worktrees keep the output directory, the build cache and the index files apart, which is why people no longer have to remember it.

## Build queueing (the lock follows the dependency directory)

1. A real build (one that misses the cache) takes a cross-process file lock, and the lock sits in the cache directory under the dependency directory, so it follows the dependency directory. Every tree with its own dependencies has its own lock and never queues behind another; waiting is needed only when a second build writer appears in the same tree. If the lock cannot be taken, wait; if it still cannot be taken when the limit is reached, exit with an error that names the process holding the lock and the lock file; the limit is `buildLockWaitMs` in `config/timeouts.yaml`. After the wait succeeds, re-check the cache once, and on a hit exit right away (about 0.2 seconds) instead of building again. Taking the lock, waiting for it, taking it over, releasing it and timing out all go into the log, so the log alone shows who took the lock first and who waited how long.
2. A build that hits the cache takes no lock and writes no output file; the pre-build at the front of the verification chain is only a speed-up, and its failure does not make the chain red; a step that goes red in the verification chain is automatically re-run once, one at a time, and only a step that goes red again is truly red (this rule is in `docs/agents/verification.md`).
3. Before deleting a dependency directory, first confirm that no other process is using it. The lock file and the build cache both live inside the dependency directory, so deleting the dependency directory also carries away the lock somebody else is waiting for.

## Committing and pushing (the four extra rules for parallel work)

How to write a commit message, committing one thing at a time, and committing only the paths you touched are all in `AGENTS.md` and `docs/agents/commit-convention.md`; follow them. Parallel work adds four more:

1. Commit from the command line inside your own tree. Every tree has its own index (`.git/worktrees/<name>/index`), and `git add` inside a tree touches only that tree's staging area; before committing, look at `git status --porcelain=v1 --branch`, confirm which changes are yours, stage only the paths you have confirmed, and write one file or one directory at a time.
2. The panel draws the tree at this session's cwd and does not move with you to another tree; while the session cwd stays in the main workspace, do not use the panel to commit changes that live in a worktree. Staging and committing are write operations and contend for `.git/index.lock`, while read operations do not; when a commit fails, first check whether another process in the same tree is writing the index.
3. The commit window for one branch belongs to one session at a time: branch refs are shared at repository level, and two trees cannot check out the same branch at the same time. Pull before pushing (using only pulls that cannot lose files), and if the push does not go through, stop and ask a person; do not force-push and do not rewrite history.
4. `refs/stash` is shared at repository level as well: when you run `git stash` in one tree, the other trees see the same entry. Before using the stash, confirm that no other session is using it; if the change can be committed to your own branch, do not stash it.

## Cleaning up: delete worktrees you no longer use

1. After the work is delivered (merged or pushed), delete that tree: first run `git -C .worktrees/<name> status --porcelain` to confirm there are no uncommitted changes, then run `git worktree remove .worktrees/<name>`. It refuses while there are uncommitted changes; once you have confirmed those changes are not wanted, add `--force`, and ask a person before you do.
2. After deleting a directory by hand, run `git worktree prune` to clear the registration; first run `git worktree prune --dry-run -v` to see what would be cleared.
3. `.worktrees/` holds worktrees only. Temporary files (commit-message fragments, probe scripts, logs) go in `.scratch/<ticket-number>/`; that directory is not in the version control repository, and these files must not be left at the root of `.worktrees/`.

## Why integration branches (`integ/*`) may change more than one room

`tests/verify-no-mixed-session.ts` (#326) enforces one plain rule: a single session changes only one backend room. It reads "the list of changes from the comparison baseline to HEAD", so on a **spec**'s integration branch it is bound to go red — a change like spec #1439 adds budget declarations to the github, gitlab and markdown backends at the same time, which is by design, not a crossing of the boundary.

Since 2026-10-24, for branches that start with `integ/` this gate prints the list of room hits and then SKIPs, with the reason written on the SKIP line of the gate's output: "one session" on an integration branch means the whole chain of tickets, the tickets run one after another and each ticket touches only its own rooms, so the single-room assumption binds single-ticket sessions only. When you create a ticket-level work branch (not `integ/`), the gate goes red as before, so do not use this exemption as a shield.

## Looking at a worktree's result in the interface

The interface loads a real copy inside the profile's installation directory, not the output directory of any tree, so a build in a worktree being invisible to the interface is normal and does not mean the build did not run; two worktrees building at the same time do not overwrite each other either.

The installation directory is `<DSH profile directory>\node_modules\dsh-mattpocock-skills-deck`, which on this machine is `C:\Users\辰辰洋洋\.dsh\profiles\desktop\node_modules\dsh-mattpocock-skills-deck` (assembled from `$env:USERPROFILE\.dsh\profiles\desktop\`; which version is installed on this machine is answered by the "three-way version check" section of `docs/agents/issue-tracker.md`). Two measurements, on 2026-10-22 and on 2026-10-30, both found it to be a real copy rather than a directory junction; after changing machine or changing the way it was installed, look once at whether it is a copy or a junction — if it is a junction, just change where it points, and the rename-and-back-up step below is not needed.

In the interface's event stream (`/plugins/events`), a `graph` frame carries a `rev` for each plugin, and a `rebuilt` frame means that a plugin's output was loaded again. The `rev` is computed from the modification time, creation time and byte count of the plugin's output files, so if those three numbers match a candidate file, you have confirmed which copy of the output the interface is loading right now.

To look at a worktree in the interface, the steps below were measured once on 2026-10-22 (the main workspace's output was never touched along the way):

1. Build once in the separate worktree: `pnpm install --offline --ignore-scripts --frozen-lockfile`, then `node scripts/build.mts`.
2. Rename the profile installation directory as a backup, and at the original path create a directory junction that points at that worktree's `package` directory.
3. Watch the interface's event stream: in the measurement, about 0.3 seconds later one `rebuilt` frame (carrying the `rev` of this tree's output) and one new `graph` frame arrived, and the interface remounted once on that basis.
4. Requesting the plugin output with the new `rev` returns content byte-for-byte identical to `package/lib/client.js` in that worktree (only one extra 83-byte sourceMappingURL comment line at the end); requesting it with the old `rev` returns 404.
5. Restore after looking: delete the directory junction and rename the backup directory back to its original name. In the measurement, about 0.4 seconds later another `rebuilt` frame and a `graph` frame carrying the restored original `rev` arrived, and the plugin output went back to the copy it had before the switch.

What the measurement concluded: switching the entry point triggers one remount and only one, and the interface really does get that tree's output; after switching back the interface returns to its previous state. The switching round was observed for 100 seconds and showed only the one baseline `graph` frame from before the switch, plus one new `rebuilt` and one new `graph` after it; the restoring round was observed for 60 seconds and likewise showed only the one `graph` frame of the original baseline, plus one new `rebuilt` and one new `graph` after restoring, with no other reload signal.

What the measurement confirmed, and its limits:

- Not one byte of the main workspace's output changed during the switch: before and after the switch, the metadata fingerprints of the main workspace's four output files, of the whole `package/lib` tree, of the git index, of the build cache and of the whole profile installation directory tree were equal item by item.
- "How many times it remounted" is the number of signals seen in the event stream; whether the interface in the browser finished its refresh in one go is confirmed by a person looking at it.
- Only one window and one round trip were measured. After changing machine or changing the way the plugin was installed (for example upgrading it from the marketplace), the output the interface loads changes, so confirm it once with the reconciliation method of the second paragraph above before relying on it.

## Reading logs and locating a problem (one thing to watch when running in parallel)

Logs are written to disk one file per day under `.dsh-mattskillsdeck-cache/logs/` in the host process's current directory (the file name is `YYYY-MM-DD.log`); levels and fields are in `docs/design/335-logging-contract.md`. The program that writes to disk assumes there is only one writer at a time, so when two processes write at the same time the later write wins and the other batch of lines may be lost; sessions inside one host process share one writer. So when locating a problem, go by the timestamps and context of your own run, and do not assume that "it is not in the log, so it did not happen".

## What this convention does not solve, and what is still unverified

- Output read while it is being rewritten: the lock only queues writers, not readers. Reading while another process is rewriting the output can still return an old generation or a mixed generation. To really never see a mixed generation you would need a way of switching the whole output at once, and that is not stuffed into this convention.
- Scheduling across machines and changing the multi-session model: these were already outside the map, and this convention does not deal with them either.

## Related notes (pointers only, no full text copied)

- `research/1313-parallel-session-resources.md`: the list of facts about the five shared surfaces (build cache, output directory, index, logs, temporary fragments) and the priority order for fixing them.
- `research/1322-worktree-link-probe.md`: the full measurement of two worktrees running in parallel, the numbers, the commands that reproduce it, and what it does not cover.
- `docs/design/1323-build-mutex.md`: the scope of the lock, where the three time parameters went, the failure modes and the acceptance criteria; the conclusion of section seven, "the main workspace is still the only one", has been replaced by this document's "Looking at a worktree's result in the interface" section.
