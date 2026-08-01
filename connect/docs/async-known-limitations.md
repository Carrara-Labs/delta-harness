# Delta Connect 0.3.2 async turns — known limitations

The async-turn design (durable tasks, placeholder recovery, terminal-idempotency, schedule identity)
closes every codex finding that is reachable in the deployment Connect actually runs in: a single
process talking to its daemon over the **loopback seam** (`127.0.0.1`), typically **one conversation
per user**. The residuals below survive only in regimes that don't occur there — a dropped/stalled
`202` on loopback (which essentially never happens, since there is no network), or one user driving
concurrent long turns in several chats. They are recorded here rather than fixed, because closing
them fully needs a further daemon affordance and their reachable impact is nil.

1. **Schedule during the accepted-but-unrecorded window.** If the daemon accepts a turn but its `202`
   is lost, and the *agent* calls `schedule_self` before Connect has recorded the task (up to the
   15s POST timeout), the control server finds no origin and returns `409` — the schedule is lost,
   not misrouted. Reachable only on a lost loopback `202` AND a schedule call inside that window.

2. **Placeholder deadline vs. a truly unreachable daemon.** A placeholder that can't be resolved for
   `PLACEHOLDER_DEADLINE_MS` (60s) is finalized as an error and the conversation freed. If the first
   POST *was* accepted but the daemon then stayed unreachable for 60s, that run is no longer tracked
   (a possible orphan). The alternative — never giving up — would wedge the conversation forever, so
   the deadline is the deliberate trade. Reachable only if the loopback daemon accepts then dies for
   60s; terminal-idempotency prevents duplicate execution while retries continue.

3. **Input thread head of a never-accepted, then `/new`-reset start.** A placeholder re-reads the
   session head when it resolves. If the original POST was *not* accepted and `/new` cleared the
   session in between, the retry starts with no previous head — which is the correct "fresh start"
   outcome anyway. If the original *was* accepted, terminal-idempotency re-attaches to the run that
   already carries its original head, so no context is lost. No reachable defect; noted for
   completeness.

The complete fix for (1) is a daemon affordance that asserts the run's own id (not just its user) on
`schedule_self`, letting Connect bind by task id even before the task row is recorded. It is queued
for a future harness bump; it is not worth its surface for a window the loopback deployment can't hit.
