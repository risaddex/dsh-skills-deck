# ADR: Hard fork as `dsh-skills-deck`, no routine upstream sync

> Date: 2026-11-13 · Status: accepted

This repository started as an exact copy of `FeatherHunter/dsh-mattpocock-skills-deck` (fork and upstream were 0/0 commits apart at `5b4d78f`). We renamed the GitHub repository to `risaddex/dsh-skills-deck` and the npm package to `dsh-skills-deck`, starting at `2.0.0-alpha.0`, and treat it as a **hard fork**: the `upstream` remote stays only for occasional cherry-picks; we do not rebase or merge upstream routinely.

Why: the fork's goals (English-first runtime, a native Linear backend, a pt_BR README) touch almost every user-facing string and the tracker layer, while upstream moves fast (≈92% of recent commits by its author) in Chinese. Regular merges would conflict on nearly every release. Keeping the old package name would also let the upstream self-updater (`dsh-plugin-update`) and the marketplace offer upstream builds over the fork.

## Consequences

- The DSH plugin entry ids change (`dsh-skills-deck`, `dsh-skills-deck/tools`), so the upstream package must be uninstalled before installing this one; per-plugin settings and credential records live under the new owner name.
- The `deck_*` agent tool names are unchanged.
- The upstream self-update channel is removed; releases are published through `risaddex/dsh-plugins-index`.
- Test fixtures and comments that cite the upstream repository as a data source keep pointing at it; they are provenance, not configuration.
