# ADR: English first — English is the default and the fallback locale

> Date: 2026-11-13 · Status: accepted

This is the third of the three founding decisions recorded by the fork map
[Wayfinder: dsh-skills-deck — English-first hard fork with a native Linear backend](https://github.com/risaddex/dsh-skills-deck/issues/1),
next to `docs/adr/20261113-hard-fork-dsh-skills-deck.md`.

## Decision

1. `config/languages.yaml` now names **`en` as the default** language and puts **`en` at the end of the fallback chain**:
   `en.fallback` is empty (nothing above it), and `zh` declares `fallback: [en]`. Chinese stays fully selectable in the
   host's language picker; nothing is removed.
2. A language that is not in the list, an unreadable language snapshot, and any text missing in the selected language all
   land on **English**, not on Chinese.
3. Written English: everything a user or an agent sees — interface copy (`config/copy/`), prompt text (`config/prompts/`),
   tool and parameter descriptions, receipts and error messages, agent-facing documents and the README, and the text of
   issues, pull requests and ADRs.
4. Read both, write English: issue and prompt text still **recognises** Chinese section names and Chinese title words,
   because existing tickets and users' own words are Chinese. What the agent writes back is English only.
5. Still Chinese: code comments, the historical body of `research/`, `docs/design/` and older ADRs, tests, and the
   CHANGELOG. Those are provenance and history, not product surface; they get rewritten only when a later ticket touches
   them anyway.

## Why

The fork exists because the plugin's audience, its agent prompts and its tracker text are read in English far more often
than they were written in. Leaving `zh` as the default meant every new user and every fresh agent session met Chinese
first and had to change a setting to get English. Flipping the default is the smallest change that makes that surface
English: it is one file plus regenerating, because the interface copy and the prompt text already carry both languages.

It also lines the plugin up with the host. The DSH locale service's own fallback locale is `en`, and it requires a
registered language's fallback chain to end at `en`; with `en` as the chain's terminal, the plugin's own chain and the
host's expectation are the same thing instead of two arrangements that happen to agree.

## Consequences

- Nothing about the data volumes changes. Both languages were already complete when this flipped: the interface copy gate
  checks that every language has the same key set, and it was green (65/65) before and after; the prompt gate checks that
  every template has a non-empty `zh` and `en` body, and it was green too. So this changes *which* language a session
  shows by default, not *whether* text exists.
- Chinese now degrades to English instead of showing a bare key name. Before the flip the chain from `zh` ended at `zh`
  (it was the default), so a key missing in Chinese surfaced as `some.key.name` in the interface; now it surfaces as the
  English sentence.
- Language ids must not be hardcoded. `tests/verify-locale-config.ts` already forbids `promptLang() === 'zh' / 'en'`
  comparisons in hand-written TypeScript, and `tests/verify-prompts.ts` was the one place that hardcoded the expected
  default; it now reads `default` from the language list instead, which is what turned red when this flipped.
- Two remainders are known and owned by later tickets, not by this one:
  - The English copy for the destructive-rename confirmation (`switch.clearDesc`, `switch.clearNeedInput`) still quotes
    the Chinese keyword `确认清空`, because `src/client/views/shared/SwitchConfirmModal.ts` and
    `src/client/kernel/store-switch.ts` compare the typed text against that literal. Changing the copy alone would make
    the confirmation impossible to satisfy, so copy and code must move together — that is the `src/client` translation
    ticket's job.
  - A handful of Node-only fallbacks (`typeof promptLang === 'function' ? promptLang() : 'zh'`) in `src/client` and
    `src/shared` still name `zh` as their last resort. They only run where the client closure is absent, and they are
    owned by the `src/client` and `src/shared` translation tickets.
- How the flip takes effect: edit `config/languages.yaml`, then run `node scripts/generate-locale-config.mts` and
  `node scripts/generate-prompt-config.mts`, then build. Both generators are also checked by `--check` from
  `npm run typecheck`, so a forgotten regeneration is caught early. The full mechanism (which data file, which generator,
  which gate) is documented in `docs/design/1294-locale-gate-strength.md`.

## Amendment (2026-11-17): the README is Brazilian Portuguese

Decision item 3 listed the README among the texts written in English. The destination of the fork map says the fork ships a Brazilian Portuguese README, and the maintainer confirmed on 2026-11-17 that it is a single `README.md` with no English copy. So the README is the one document of the product surface that is written in Brazilian Portuguese; `docs/README.en.md` was deleted in [Rewrite README in Brazilian Portuguese](https://github.com/risaddex/dsh-skills-deck/issues/15). Everything else in item 3 stands.
