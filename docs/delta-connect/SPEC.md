# Delta Connect - design spec

Status: design, not built. Owner: Nic. Last revised after a competitive teardown
(Hermes + OpenClaw at 2026-07-27 HEAD), a survey of our own stack (delta-harness +
delta-agents), and an adversarial codex review at xhigh that corrected three claims and
reordered the build. Companion visuals live beside this file: `01-feasibility.html`,
`02-concept.html`, `03-teardown.html`.

---

## 1. What it is

A thin **channel gateway** ("the edge") that plugs a Delta agent into chat channels
(Telegram first, then Slack / email / webhooks) in both directions, and lets the agent
scale to zero while staying reachable. It is NOT part of the engine. The harness doctrine
("NOT building: channels", zero deps, <10ms cold start, single HTTP seam) is the moat, and
it stays intact. Delta Connect lives outside `@carrara-labs/delta-harness` as a separate
package sharing only a tiny contract module.

Positioning language: "connectors" and "edge", never "plugins" or "catalog". Framing:
Hermes and OpenClaw *are* the channel layer welded to the agent; Delta is the agent, Connect
is an optional thin edge; the same connector runs from a single-file local bot to a shared
multi-tenant gateway; the agent still scales to zero.

---

## 2. The thesis, corrected

Original thesis: Hermes and OpenClaw are resident, always-on, single-process daemons that
hold every socket open and keep session state in RAM; most of their machinery exists to make
that pinned process survive its own restarts; Delta deletes the premise.

**Codex correction (accepted).** "No resident per-agent process holding sockets" and "no
durable messaging middleware" are independent. Delete the first, keep a minimal version of the
second. The correct path is not "no queues":

```
platform event -> durable inbox / dedup -> platform 2xx -> turn dispatch
              -> durable outbox -> rate-limited platform send
```

What we delete: the resident per-agent socket, in-RAM session ownership, the plugin catalog,
the fat base class, the in-memory cron map, the 9-phase relay, the per-channel god adapter.
What we KEEP (small): a durable inbox with dedup, a durable occurrence table for schedules,
and a durable outbox. Hosted, we already have this in `event_deliveries` (SKIP LOCKED). This
is still far less than either competitor; "leaner" holds, "no durable middleware" was wrong.

Three claims from the first draft that were wrong and are retired:
- "No shared mutable in-process session state." False - the engine already uses an in-memory
  `busy` session set for serialization (`src/queue.ts`). Not our concern to remove; just don't
  claim it.
- "The sender owns retry via a 5xx." True for INBOUND (platform is the sender). False for
  OUTBOUND - Connect is the sender and must own its own retry + dedup.
- "One lease row gives at-most-once." A lease is leader election, not at-most-once dispatch.
  See section 7.

---

## 3. Always on, yet scaled to zero - on Fly AND a Mac Mini

The gateway is the always-on part in both deployments. It is cheap: it holds the socket and
the durable inbox/outbox, nothing else. The agent sleeps behind it. Only the wake mechanism
differs, and it hides behind one interface:

```ts
interface AgentSupervisor {
  ensureAwake(agentId): Promise<Endpoint>   // called before dispatch; returns base URL
  maybeSuspend(agentId): Promise<void>       // called after a turn iff /v1/busy is false
}
```

- **Fly (hosted).** `ensureAwake` = `POST machine/start` then poll `/healthz`; `maybeSuspend`
  = RAM-snapshot suspend. Warm resume ~1-3s. True scale-to-zero.
- **Mac Mini (local), default.** Keep-alive: the daemon just runs (~30MB idle). `ensureAwake`
  is a no-op, `maybeSuspend` a no-op. Scale-to-zero buys nothing on a box that is already on.
- **Mac Mini (local), optional zero.** `ensureAwake` spawns the process, `maybeSuspend` kills
  it after idle. Cold start, not warm resume, so the first message is slower.

Why it is safe on both: the durable inbox accepts the event and returns 2xx to the platform
BEFORE the agent is guaranteed up, so cold-start latency never loses a message. From the
user's side the agent is always reachable; from the cost side the heavy part sleeps. That
split is exactly what Hermes and OpenClaw cannot do, and it is substrate-agnostic.

Caveat (codex): `/v1/busy` reports durable queued/running counts, it does not "gate" suspend.
The supervisor must close the observe-then-suspend race itself (re-check busy inside the
suspend transaction, or hold a short suspend-lease).

---

## 4. Architecture - three seams, not one 4-method contract

Codex correction (accepted): a single `connect/disconnect/send/get_chat_info` contract hides
the ingress lifecycle and WILL fork local-poll vs hosted-webhook. Split into three:

1. **Connector codec** (per channel, pure, no transport): `verify()`, `parse() -> Inbound`,
   `render(neutralOutput) -> platform payload`, `send()`, `capabilities`. This is the only
   per-channel code and it is small.
2. **Ingress driver** (two implementations, channel-agnostic): `webhook` (verify sig -> write
   inbox -> 2xx) or `longpoll/socket` (read -> write inbox -> advance offset). Durable-insert
   happens BEFORE ack/offset-advance in both.
3. **Durable core** (shared, the spine): inbox + dedup, conversation ordering, routing,
   turn dispatch via the supervisor, outbox + retry.

The normalized downstream path is shared; the ingress lifecycle is honest about being
different. Lazy SDK loading is a codec concern, irrelevant to engine cold start since Connect
is a separate process.

---

## 5. The neutral envelope

Reject raw platform objects in the AGENT-facing contract (the engine sees only clean text +
refs). KEEP a versioned raw payload reference INSIDE the edge for debugging and forward-compat
(codex). The inbound envelope the durable core routes on:

```
{ tenantId, connectorInstanceId, eventId, conversationId, threadId?,
  actorId, occurredAt, orderingKey, replyTo?, text, attachmentRefs[], rawRef }
```

`identity + sessionKey + text` from the first draft was inadequate. `eventId` powers dedup;
`orderingKey` powers per-conversation ordering; `actorId` is separate from the session
principal (see section 6).

---

## 6. Sessions, ownership, and the group-chat problem

The engine threads by `previous_response_id` and stores one `user_id` owner per session
(`src/queue.ts`). Two rules:

- **Single threading authority.** Connect must NOT persist `previous_response_id` if `turn.ts`
  also does - that is two threading authorities and a coupling trap (codex). Decision: the
  durable core owns `conversationId -> engine session` mapping atomically; Connect submits
  `{tenant, connectorInstance, eventId, conversationKey, actor, content}` and never handles a
  raw response id. Hosted, this is `turn.ts` + `requesterKey`; local, it is a tiny table in the
  gateway's own SQLite.
- **First-message fork.** Two simultaneous first messages in one conversation (no
  `previous_response_id` yet) create two sessions (`src/queue.ts`). The durable core needs a
  per-conversation ingress sequencer, or the engine needs an API that accepts a deterministic
  session key. Until then, serialize first-contact per `conversationId`.
- **Group chat, v1 = DM only.** A Delta session has one owner; the second human in a group
  thread fails ownership, and using the group id as `user_id` destroys actor-specific memory.
  v1 ships DM-only. The real fix (later) is separate `session_principal` and `actor_id`.
- **Cancellation.** A queued "stop" cannot interrupt the long run ahead of it. Connect needs
  out-of-band cancel mapped to the active task id (`DELETE /v1/tasks/:id`), not an inline message.

---

## 7. Scheduling and proactive

Do NOT promise at-most-once from a lease row. A lease is leader election. Promise **durable
occurrence accounting + effectively-once admission** (codex). Required:

- A durable occurrence row keyed `(schedule_id, scheduled_for)` - unique, so a retry is a
  no-op, not a second fire.
- Database time, not worker clocks. A fencing generation if work can outlive the lease.
- The occurrence is created transactionally with an outbox/turn-dispatch record.
- At-least-once workers + durable dedup at turn admission.
- Explicit catch-up policy: latest-only vs every-missed vs bounded-backfill. Plus DST,
  timezone change, clock skew, cancellation race, and max-lateness.

Hosted, reuse `event_deliveries` + the existing `schedule_self -> schedule-ticker ->
agent-wake` path. Proactive send is the same outbound path as a reply. The agent gets a
generic `notify` MCP tool and never sees a `chat_id`; the gateway resolves the target.

---

## 8. Streaming and outbound delivery

- **Handoff via `/v1/tasks`, not `/v1/responses` streaming** (codex). Tasks return a durable
  run id immediately; the edge polls/subscribes. `/v1/responses` SSE is live-only, replays
  nothing, and emits no initial run-id frame, so a disconnect cannot resume.
- **The draft loop is NOT copied verbatim.** `/v1/responses` SSE deltas are raw model text and
  can cover intermediate tool-calling turns the agent later revises (`src/run.ts`). We need an
  explicit publishable-final-answer phase (or a task event that marks final output) before
  streaming to a channel. Until that exists, deliver the final `output_text`, not a live draft.
- **Outbound is durable.** States: generated -> queued -> attempted -> accepted -> failed ->
  dead-lettered. A crash between generate and send must not lose the answer; a lost platform
  ack on retry must not duplicate it (idempotent send key per outbox row). "Delivery" never
  implies "read".
- **Flood control.** Respect `429` / `Retry-After`; Telegram ~1 msg/sec/chat and broader
  broadcast caps; per-tenant fairness so one noisy chat cannot starve others.

---

## 9. Security and tenant routing

- **Signature/replay verification is mandatory**, per channel: Telegram secret header, Slack
  signing secret + timestamp window, generic webhook HMAC, realistic email trust. A "tenant
  tag" is routing, NOT authorization.
- **Tenant onboarding.** A shared bot needs a secure binding flow (deep-link token, workspace
  install). Slack user ids namespaced by installation/workspace.
- **Access control.** Allowlist (v1: just Nic's chat), group-membership rules later,
  per-agent tool-permission profile, quotas, abuse controls, quiet hours, proactive consent.
- **Loop prevention.** Ignore bot messages, forwarding loops, email auto-replies, webhook cycles.

---

## 10. Delete-by-design (corrected)

Keep: durable inbox+dedup, occurrence table, durable outbox (all minimal; reuse
`event_deliveries` hosted). Delete: resident socket per channel in the default (webhook-first);
in-RAM session ownership; plugin catalog + two-manifest split + facade files; fat base class +
per-channel god adapter; in-memory cron map; the 9-phase relay. Rejecting raw platform data in
the agent contract stays; keep a raw ref inside the edge.

---

## 11. Build order (reordered per codex)

The loss/duplicate boundaries come FIRST. Streaming and scheduling sit on top of them, so
shipping the pretty draft loop first would bake the loss window in.

1. **Durable spine.** Inbox + dedup (`eventId`), deterministic conversation ownership,
   async turn dispatch via `AgentSupervisor`, durable outbox with idempotent send.
2. **Telegram codec + ingress driver.** Webhook (with secret verification) for the scale-to-
   zero path; long-poll for the always-on local box. DM-only.
3. **Supervisor implementations.** Fly (start/suspend + `/healthz`) and local (keep-alive;
   optional spawn/kill). Close the `/v1/busy` suspend race.
4. **Outbound delivery.** Final `output_text` send with retry + flood control; the `notify`
   MCP tool for proactive.
5. **Scheduling.** Durable occurrence rows; reuse `event_deliveries` hosted.
6. **Then** the streaming draft loop, once the engine exposes a final-answer phase.

Discipline: one channel at a time; the contract is free, the framework is expensive;
webhook-first so scale-to-zero stays real; the codec never grows a god-adapter.

---

## 12. Open questions

- Does the engine need a small new affordance - an initial SSE frame carrying the run id, a
  deterministic-session-key input, or a "final answer" task event - to make streaming and
  first-message ordering clean? If so, that is the one place the engine changes, and it stays
  channel-agnostic.
- Package name: `@carrara-labs/delta-connect` (working). Confirm before publish.
- Local durable core: its own SQLite file vs a tiny embedded queue. Keep it boring.
