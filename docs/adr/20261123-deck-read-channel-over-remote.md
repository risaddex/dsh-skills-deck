# ADR 20261123 · The deck gets a narrow read channel for the DSH Remote relay

> Date: decided 2026-11-23, after the maintainer settled the mobile panel discussion.
> Status: accepted.
> Related: spec #70 (the implementation spec), `research/dsh-go-remote-panel-surface-facts.md` (the transport facts), `GLOSSARY.md` (read-only deck panel, deck read channel), `dsh-go` and `ds-harness-remote` (the external implementation dependencies).

## Context

The deck's current panel is a web-shell right-sidebar panel. It cannot appear in DSH Go over the DSH Remote relay: the relay does not serve DSH Web, does not forward `/dsh-go/*`, and its narrow plugin-route facility exposes only two unrelated POST routes. DSH Go's native panel API also requires `DshHttpCarrier`, while the remote connection uses a tunnel carrier.

The maintainer wants a read-only deck panel in DSH Go over the current relay setup. The panel is scoped to a conversation's workspace, shows the open map/spec tree with child tickets and blockers, and opens one ticket's structured detail on demand. It refreshes only when opened or when the person asks.

## Decision

Add one **deck read channel**, negotiated as `deck.panel.read.v1`, with exactly two read operations:

- `tree`: a bounded thin tree of open maps and specs, their child tickets and blockers; at most 50 containers and 200 tickets, with visible truncation.
- `ticket`: one ticket's title, state, labels, body, acceptance criteria, progress and blockers; no comments.

The channel is read-only: there is no invoke, create, update, close or prompt-injection operation. The tree read happens when the panel opens and when the person refreshes; the ticket read happens when a ticket is opened. There is no cache between interactions and no polling. A tree failure shows an error with retry; a ticket failure stays inside the detail and keeps the loaded tree.

The feature is implemented as three independently compatible stages: the deck first exposes the read endpoints without changing its web UI; `ds-harness-remote` then forwards the channel and announces `deck.panel.read.v1` only when the endpoints exist; DSH Go last renders the panel. A host that does not announce the feature shows no panel.

All four deck backends — GitHub, GitLab, local Markdown and Linear — are read through the existing tracker contract. Acceptance requires one end-to-end run on a real Android device through the DSH Remote relay against a real host, covering both the tree read and the ticket read.

## Why not the alternatives

| Option | Why it was not chosen |
| --- | --- |
| Forward the whole DSH Go native-panel protocol through the relay | It would carry contributions, views, invoke and streams for every plugin. The deck needs two reads; the larger contract adds capability negotiation, write authorization and validation far beyond this MVP. |
| Tunnel generic HTTP/WebSocket routes for `/dsh-go/*` | It turns the relay into a general plugin proxy. The security surface and the streaming/resource-management burden are disproportionate to a read-only panel. |
| Ship only rich tool cards | It works over the relay without a new transport, but it shows snapshots when tools run; it is not the persistent panel the requirement asks for. |
| Reuse the existing web panel as a web island | The relay does not provide DSH Web, and the islands runtime requires host web-page reachability that the tunnel carrier does not have. |

## Consequences

- The work spans three repositories; the spec lives in `dsh-skills-deck` and names the other two as external implementation dependencies.
- `ds-harness-remote` must keep the channel fail-closed: only the two deck reads, scoped to a session, bounded in time and size, and available only when the deck endpoints exist.
- DSH Go must replace the HTTP-only eligibility check for this panel with the negotiated `deck.panel.read.v1` check, while leaving the existing HTTP bridge behavior unchanged for local and SSH hosts.
- The panel intentionally differs from the desktop panel: no comments, no closed items, no filters, no search and no writes. Those are later features, not omissions hidden from the user.
- A host with older deck or Remote software shows no panel; the deck remains usable through the agent and its tools.
