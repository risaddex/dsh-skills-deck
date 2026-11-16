# ADR 20261116 · Rooms get an injected HTTP channel, so an HTTP-only backend can stay a room

> Date: decided 2026-11-16, after the maintainer chose option A on ticket #24.
> Status: this document is the single source for "how does a room reach the network, and why that way".
> Related: #24 (the decision), #13 (the Linear room that needed it), `src/tracker/contract/contexts.ts` (the shape), `src/tracker/contract/outbound.ts` (the gate it reports to), `src/host/platform/httpChannel.ts` (the implementation), `tests/verify-24-http-channel.ts` (the gate that holds it).

## 1. Background: the contract had no way to send a request

The Tracker contract says a room must not use the global `fetch` and must not touch `node:fs`; file work goes through `fs` and processes go through `exec`. That held while every backend had a command-line tool: GitHub shells out to `gh`, GitLab to `glab`, and the local Markdown room only reads files.

Linear breaks that assumption. It has no CLI, so `exec` does not apply, and it exposes a single GraphQL endpoint over HTTPS. The result was a first-class backend with no legal way to make one request: `BackendContext` offered `platform`, `fs`, `exec`, `timers`, `logEvent`, `isEnabled` and `outbound`, and nothing in `src/host/platform` exposed HTTP either. The host does use the global `fetch` for the Linear identity probe, but that is host code sitting beside the rooms, not a capability a room can reach.

The ban is doctrine in the contract, not an automated check: the dependency rules police imports and the purity of `src/deck/rules/`, not global calls inside a room. So nothing would have stopped the Linear room from calling `fetch` directly — it would simply have bypassed the outbound gate without anyone noticing, which is exactly the failure `outbound.ts` ends by refusing to accept.

## 2. Decision

**A room reaches the network through an injected HTTP channel, `BackendContext.http`, and that channel acquires its own outbound slot.**

The channel takes one request (method, url, headers, body, bucket, service, timeout, abort signal) and returns the status, the lower-cased headers and the body text. It is created once per process beside `exec` and injected at the same three points as the outbound control:

- `src/host/platformChannel.ts` → `backendCtxForRooms`
- `src/refresh/registry/deck-tool-bridge.ts` → the backend object
- `src/refresh/rooms/host/refresh-runtime.ts` → the backend object

All three import the two capabilities from one module, `src/refresh/rooms/host/room-host-services.ts`, which only re-exports them. That is not decoration: those three files sit at the 350-effective-line ceiling enforced by `tests/verify-file-granularity.ts`, so a capability that costs one new import line per injection point cannot be wired at all. With the re-export, adding a capability changes one small file instead of growing the files that wire it.

**The channel owns the gate, not the room.** Every request acquires a slot through `ctx.outbound.acquire` with the bucket and the service `linear`, and reports the ending:

- any HTTP response means the path is alive → `reportSuccess` (a 4xx or 5xx is an answer, not a dead path);
- a write request that succeeded → `noteWrite`;
- connecting failure, timeout or a killed connection → `reportTransportFailure` with `timeout` or `spawn-failed`;
- a caller cancellation → returned as a cancellation, never recorded as a path failure.

**Failure semantics follow `exec`.** A transport failure throws; it never comes back as a made-up status code. Any real response — including Linear's habit of answering HTTP 200 with a populated `errors[]` — is returned to the room, because reading that is the room's protocol, not the channel's.

**The channel adds no log event of its own.** A transport failure is already recorded by the gate it reports to: `reportTransportFailure` makes the outbound layer write `gh.transport` (the cooldown-set line, keyed by service and bucket), which is exactly the fact worth keeping. A line per request would be the heartbeat noise the logging rules forbid, and a second line per failure would say the same thing twice. Adding one later means registering the event in `research/489-appendix.md` and `tests/verify-log-fields.ts` first; `tests/verify-24-http-channel.ts` refuses a logging call inside the channel so that order cannot be skipped.

## 3. Why not the alternatives

| Option | Why it was not chosen |
| --- | --- |
| Put the Linear backend in the host instead of a room | It contradicts the map's own decision that Linear is a native backend behind the Tracker contract, and it would move a twenty-four-operation surface outside the room architecture that keeps the deck tools free of per-backend branches. |
| Start `curl` through `ctx.exec` | This repository ships on Windows as well, and it abuses an admission path that is built around naming a command. |
| Let rooms use the global `fetch` | Zero plumbing, but it bypasses the concurrency cap, the cancellation check and the cooldown window — the exact silent bypass `outbound.ts` says must fail loudly instead. |
| Give the room its own gate handle and let it manage slots | Every room would then acquire slots in its own way, and the cap would decay into a suggestion. The channel is the one place that knows how to take and return a slot. |

## 4. Consequences

- The contract gained one required member, `http`, and two shapes (`HttpRequest`, `HttpResponse`); `OutboundService` gained `'linear'`. A missing channel is a wiring mistake and fails loudly, like a missing outbound control.
- Test fixtures that build a context by object literal keep compiling because they cast; the three real injection points are the ones that must be kept in step, and the comment at each of them names the other two.
- The channel is deliberately narrow: text bodies only, no redirect policy of its own, no retry. Retrying is the room's decision, because whether a write can be replayed depends on the operation (the contract already draws that line for outbound timeouts).
- Any future backend that speaks HTTP only reuses this channel with its own service name, rather than opening a second road to the network.
