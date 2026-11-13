# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's tracker.

Label colours are **not** kept in this file. On the **local Markdown backend** the colours live in the workspace file `docs/agents/label-colors.json`, which the plugin places there and you can edit by hand or through the deck's re-colour dialog in the panel; on GitHub the colours are the repository's own label colours. This file only answers "which label string does a role map to".

## Label set

| Label | Meaning |
| --- | --- |
| wayfinder:map | The map issue of a wayfinder effort |
| wayfinder:research | Research ticket (AFK) |
| wayfinder:prototype | Prototype ticket (HITL) |
| wayfinder:grilling | Grilling / discussion ticket (HITL) |
| wayfinder:task | Task ticket (HITL or AFK) |
| bug | Something is broken (fix action / BUG filter) |
| enhancement | A feature request (category role; pairs with a state role) |
| needs-triage | Unexamined issue awaiting diagnosis |
| needs-info | Waiting on reporter for more information |
| ready-for-agent | Fully specified, ready for an AFK agent |
| ready-for-human | Requires human implementation |
| wontfix | Will not be actioned |

Add any custom label you use as a new row here. A row added here only records the label's name and meaning — it does not give the label a colour; colours come from `docs/agents/label-colors.json` (local Markdown backend) or from the repository's own labels (GitHub).

When a skill mentions a role (for example "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Mandatory label set

When this repo creates a ticket it **adds labels by position**; it does not require every new ticket to carry a triage label. Which label each of the six positions adds (one-to-one with `OBJECT_KIND_RULES` in the code's position table `src/deck/rules/object-kind.ts`; a spec and a spec ticket share one row):

| Position | Label added when the ticket is created |
| --- | --- |
| Exploration map (`kind: map`) | `wayfinder:map` |
| Map ticket (`kind: map-ticket`) | whichever `wayfinder:<type>` the call passed in `label` (`research` / `prototype` / `grilling` / `task`, one of the four) |
| Spec (`kind: spec`) and spec ticket (`kind: spec-ticket`) | no type label; when no triage state is given explicitly, it defaults to `ready-for-agent` |
| Bug ticket (`kind: bug`) | the type label `bug`; when no triage state is given explicitly, it defaults to `needs-triage` |
| Ordinary ticket (`kind: issue`) | none at all |

`deck_issue_create` fills in whatever is missing according to this table. **A wayfinder map and its child tickets carry only wayfinder labels, never a triage label such as `ready-for-agent`**: they are decisions, not implementation work. The same table is also written in the "Mandatory label set" section of `docs/agents/issue-tracker.md`.

**There is at most one triage state at any moment** (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`, one of the five). A state is switched, never stacked:

- When `labels` already carries one state label at creation, the caller's choice wins and the default state from the position table above is not added on top. A bug ticket created with `needs-info`, for example, ends up with `bug` and `needs-info` only, never a third `needs-triage`.
- When `addLabels` carries one state, the tool first removes the ticket's existing state label, then adds the new one, and the receipt says which labels it removed. So moving a ticket from `needs-triage` to `ready-for-agent` takes only adding `ready-for-agent`; do not go and remove the old one yourself.
- One request carrying two or more state labels (creating a ticket or changing labels alike) is refused outright and no label on the ticket changes: the caller has contradicted itself, and the tool does not choose on the caller's behalf.

The five states are listed in exactly one place in the program: `src/tracker/contract/triage-states.ts`, and `src/tracker/contract/canonical-labels.ts` takes the names from there too instead of copying them out. The local Markdown backend has a second source — `status.triage-roles` in `original-skills.yaml`; `tests/verify-md-format-config.ts` compares the two entry by entry, so changing the list means changing both.

The local Markdown backend writes the triage roles above as a visible `Status:` line in the ticket file, not into the hidden `DSH-LABELS` header; spec and exploration-map containers have no visible status line and still use the hidden `DSH-STATUS`. The read side merges the visible status back into the triage labels, so both "filter by label" and "add a label by position" keep working unchanged.

The three labels `bug` / `needs-triage` / `wayfinder:grilling` stay: they are the entry points of the three panel actions — fix (修复), diagnose (诊断) and discuss (讨论) — not something every new ticket has to carry.

## Wayfinder label set

The `/wayfinder` skill requires all five wayfinder labels to exist. Every wayfinder child ticket carries exactly one of them:

- `wayfinder:map` — the parent map issue (Notes / Decisions-so-far / Fog)
- `wayfinder:research` — research ticket
- `wayfinder:prototype` — prototype ticket
- `wayfinder:grilling` — grilling/discussion ticket
- `wayfinder:task` — implementation task ticket

Edit the `Label` column to match whatever label strings you actually use.

## Checklist issue exception

Every version to be released has a checklist ticket titled `[真机验证] <version>`; the Chinese prefix is matched literally by `scripts/lib/release-checklist.mts`, so the title itself stays as it is (the rules are in `docs/agents/real-machine-verification.md`). It is created as an ordinary ticket (`kind: 'issue'`) and recognised by that title prefix, and it carries **no label at all**: by the table above an ordinary ticket adds none, and a label would only drag it into the bug / triage filters. Do not add labels to it when you create it.

