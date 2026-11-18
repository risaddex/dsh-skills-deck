# Release publishing

## How this fork publishes (read this first)

This fork does **not** publish to npm. A release is a built tree pushed under a `dist/v<version>` tag, and the public plugin index points at that tag. The steps, in order:

1. Bump `package.json` and `package/package.json` to the same version, add the `CHANGELOG.md` section, and make `node --import ./scripts/ts-hook.mts tests/verify-release-contract.ts --version <version>` pass.
2. Run `npm run verify:parallel` on the release commit. `release-dist.mts --push` refuses to run unless `node_modules/.cache/dsh-verify-last.json` matches the commit being released.
3. Run `node scripts/release-dist.mts --dry-run`, then `node scripts/release-dist.mts --push`. Both run the pre-release gate (`scripts/release-preflight.mts`) before anything is created, and either one accepts `--candidate <candidate.json>` to add the byte-level candidate check. The push refuses to create the `dist` ref, the `dist/v<version>` tag or the dispatch when the gate verdict is failing (exit 1: the checklist ticket or the candidate manifest has to change) or undecidable (exit 2, and any other exit code: the environment or the ticket-face adapter is missing), and it prints the gate's own findings together with their fix hints. The dry run prints the same findings and only warns. When the gate passes, the push creates the `dist/v<version>` tag and sends a `repository_dispatch` of type `skills-deck-dist-tag` to `risaddex/dsh-plugins`, which republishes the index. The tag is one-way: the script fails if it already exists.
4. Confirm the `publish-index` run in `risaddex/dsh-plugins` finished green and that `index.json` in `risaddex/dsh-plugins-index` lists the new version.

The marketplace title, description, category and keywords come from the `dsh.market` block in `package/package.json`, so they ship with each tag. The generator in `risaddex/dsh-plugins` only falls back to its own text when that block is missing.

## Inherited npm flow (not used by this fork)

The rest of this page is the npm token flow inherited from the upstream repository. It is kept because `scripts/publish-token.ps1` and the gate `tests/verify-1646-publish-token-file.ts` still guard it; this fork does not run it.

Publish `package` (the main plugin; skills ship inside it, never separately). `dsh-log` and `dsh-plugin-update` now live in standalone repos and are only consumed from npm, never published from here (#878, #892). Private package shells are skipped automatically.

Unattended publishing (prefer it when there is a token with write permission; it needs no human click): **the token always goes through the file channel**. Writing the value as a command-line argument, or as an inline assignment such as `$env:NODE_AUTH_TOKEN='<value>'`, records the whole command in plain text in the session transcript and in the process arguments (#1646 leaked it for real), so neither of these may be used any more. The way to do it:

1. A person writes the token with write permission as the first line of a temporary file that only they can read, for example `%TEMP%\dsh-publish-token.txt`; do not put it in the repository directory, and do not add comments. For how to tighten the file permissions and how to write the value in, see section 12 of `docs/releases/RELEASE-RUNBOOK.md`.
2. The agent's command mentions only a path: run `pwsh -NoProfile -File scripts\publish-token.ps1 -TokenFile <path> -Probe` first (it must say PROBE-OK), then run `pwsh -NoProfile -File scripts\publish-token.ps1 -TokenFile <path>` for the real publish (build and test gates → publish → one visibility sample; add `-FullPost` before announcing it publicly).
3. Delete the temporary file immediately after every run (`Remove-Item -LiteralPath <path> -Force`). Once the token may have leaked, revoke that one at npm first and then issue a new one; otherwise rotate it quarterly.

The `$env:NODE_AUTH_TOKEN` environment-variable entry point is still compatible (`-TokenEnv` changes the preferred variable name), but it is only recommended that a person sets it in their own terminal: when an agent runs, always use the file channel. Accepted is not the same as visible: `E409 previously-staged` means the registry received the package, so wait a few minutes instead of republishing or bumping the version. The old interactive flow (`scripts\publish-all-window.ps1` via schtasks) stays as fallback. Publishing ends the job; installing is always done by the user (marketplace upgrade, in-app upgrade, or their own install command).
