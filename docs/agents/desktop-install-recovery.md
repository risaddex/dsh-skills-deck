# Desktop installation recovery after a missing Deck module

## Check the installed package before changing the profile

1. Read the Desktop crash report and identify the missing import and the file importing it. Check both paths in the installed package, then compare them with a clean, compiled checkout of the same commit. A successful checkout build does not prove the selected installation method delivered the same files.
2. If a direct GitHub install is incomplete, keep it disabled and use the compiled-clone route in the [installation guide](../../README.md#instalação). Build outside the active profile. For a missing `package/refresh/rooms/host/refresh-runtime.js`, require that exact file to exist and be nonempty before linking the clone. Use the Desktop plugin manager for the replacement; leave the working clone in place.
3. Back up the Desktop profile patch separately from the package manifest. If preferences also need recovery, quit Desktop fully before restoring the known backup so the running instance cannot overwrite the change. Keep the current manifest and working Deck link. Read back the restored patch and the resolved package path after reopening; verify the preferences and the relevant action in the UI separately.

## What happened on November 27, 2026

After [PR #142](https://github.com/risaddex/dsh-skills-deck/pull/142), DSH Desktop 0.2.2-rc.5 on macOS arm64 was configured for a direct GitHub install at [`f2847299`](https://github.com/risaddex/dsh-skills-deck/commit/f2847299). The host reported `ERR_MODULE_NOT_FOUND`: `package/lib/index.js` imported `../refresh/rooms/host/refresh-runtime.js`, which was absent in the installed package but present in the compiled worktree. The generated file was not tracked at either the merge commit or its parent; the PR did not change the import or packaging. Why the direct installation omitted the file remains unknown. Separate crash reports showed `INACTIVE_EFFECT` in Desktop diagnostics; no common cause was established.

The maintainer reported that Desktop reopened after linking a compiled clone. A selective patch restore was read back immediately but did not persist; the writer that replaced it was not identified. An exact copy of the saved Cordis patch with the working package manifest left intact was later verified byte for byte after reopening. The Deck link and the previously missing module were still present. The Linear Execute click itself was not independently rechecked in that Desktop session.

## Verify the installation route, not just the build

The existing [build artifact check](../../tests/verify-build-artifacts.ts) checks products in the checkout. The [real-machine verification setup](real-machine-verification.md#2-tools-and-environment) can isolate an installed candidate from the daily profile. Before recommending direct GitHub installation, use the same source spec and package-manager path in a disposable profile: verify the installed runtime module and require the host to start and the interface to become usable. Check that the daily profile is unchanged. A compiled-clone or release-tarball pass is not a pass for the direct GitHub route. This installation-route check is a follow-up, not a check added by this note.

## Resolve generated verification-map conflicts after building

PR #142 required two merges of the freshly fetched base. For a conflict in the [generated gate map](../../tests/gate-map.json), keep the source changes from both sides, build the merged tree first, then regenerate with `node scripts/gate-map.mts`. The first regeneration before building missed a new generated directory, which failed `verify-gate-map`. Verify the generated file, run the required local chain, and push the merge commit to the PR branch without rewriting history. The final #142 run reported 682 main-chain steps and eight smoke checks, with no new failures; `verify-detail-levels` was the registered failure tracked in [#135](https://github.com/risaddex/dsh-skills-deck/issues/135).
