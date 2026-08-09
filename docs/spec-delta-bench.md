<!-- SPDX-License-Identifier: Apache-2.0 -->

# Delta Bench - design proposal

Written 2026-08-07. **Nothing here is built.** This is the full design; `docs/bench-vision.md` is
the shorter note that preceded it and now defers to this file.

- Visual version: `docs/bench/delta-bench-proposal.html`
- Published artifact: https://claude.ai/code/artifact/208b02f5-08bb-4575-87f9-7f59f5241fce
- Proposed package: `@carrara-labs/delta-bench` (Apache-2.0, npm + ghcr, same shape as the harness)

---

## 1. The defect this exists to fix

During 0.2.12 one change to argument bounding was run once against a control and reported as a
**-29.9% cost win**. A second run of the identical change measured **+22.9%**. Re-examining the
first run showed the "cheap" arm had done **18 writes where the control did 10** - it looked cheap
because it was throwing work away.

Three separate failures, only one of which is about the number:

1. **One run against a nondeterministic model is not a measurement.** Three runs of that change
   produced 163k, 286k and 202k tokens on one fixture.
2. **The metric set was chosen after the result was seen**, so it happened not to include the
   metric that would have caught the regression.
3. **The workload was invented by the person judging the result.**

The harness is a context-economics engine. 0.2.11 moved a production agent's cache hit rate from
11% to 91% and cut cost by a third at volume. Those are exactly the changes whose effect is
invisible to a unit test and drowned in variance by a single live run. We have 883 passing tests
and not one of them can tell you whether the next release is cheaper, faster or better than the
last.

## 2. What it is

A rig that takes **real runs the fleet already did**, replays them against **two or more arms**
under identical conditions, and returns **one table: quality gate, cost delta, confidence
interval.**

## 3. Interaction: three bullets in, a plan out

```
$ bench plan
> compaction seems to fire too often on long Ferni threads
> I want to try raising the trigger threshold
> must not cost us any answer quality
^D
```

The rig matches a playbook and emits a plan for approval: gate, fixture selection (including a
control set that must NOT move), arms, repetitions, route, and the **metric set fixed before the
code is written**. The guard metrics (`duplicate_tool_calls`, `rework_ratio`) are in that list
precisely because they are what caught the 0.2.12 regression after the fact.

## 4. Five stages

| Stage | Does | Emits |
|---|---|---|
| Ask | bullets → playbook match | `plan.json` |
| Select | query `agent_events`, freeze + hash | `fixtures/*.jsonl` |
| Run | fixture × arm × repetition, isolated | transcripts + events |
| Score | gate first, then metrics | `scores.jsonl` |
| Verdict | paired diffs, SE, CI | `verdict.md`, `report.html` |

The rig drives two already-public surfaces only: `POST /v1/tasks` and the telemetry outbox. **No
product API, no product database, no per-app adapter** - that is what lets one rig serve Quick
Search, Intake, Prep, Ferni and Brain.

## 5. Fixtures come from production

Selectors: **expensive** (top cost/run), **long** (turn count, wall-clock outliers), **repetitive**
(user had to follow up - the honest signal the agent did not finish), **failed**
(`context_irreducible`, budget exhaustion, breaker latches, compaction storms).

A fixture is a frozen conversation, not a prompt:

```
fixtures/ferni-2026-07-31-a91c4/
├── manifest.json   agent, bundle hash, model, route, turn count, why selected
├── seed/           workspace state at t=0, restored fresh per run
├── turns.jsonl     ordered user inputs, verbatim
└── tools.json      tool surface + record/replay policy per tool
```

**Limitation to state on the verdict, not infer:** read-only tools replay from a cassette;
side-effecting tools must be stubbed, and a stub is where the replay stops being the real run. The
report must declare live / replayed / stubbed per tool.

## 6. Four kinds of arm

| Kind | Compares | Question |
|---|---|---|
| Engine | 0.2.12 vs worktree HEAD | is the next release an upgrade? |
| Bundle | same engine, different DELTA.md/POLICY.md/model/effort | the **operator's** question |
| Route | same everything, different wire | see §8 |
| Foreign | Delta vs OpenClaw / Pi / Hermes | where do we actually stand? |

Arms are declared, never inferred. An arm pins engine source, bundle hash, model, route and effort;
the rig refuses a plan with an unpinned axis rather than varying two things at once. `latest` is
never an arm.

## 7. Playbook library (the cookbook)

Each playbook carries fixtures, gate, primary metrics, guard metrics and repetition count.

| Playbook | Gate | Primary | Guard | k |
|---|---|---|---|---|
| `context-economics` | answer equivalence, judged | cost/run, cache hit, compactions/run | duplicate calls, rework, turns | 5 |
| `cache-economics` | completion unchanged | cached-read share, post-warm miss turns, write premium | turns where context shrank | 3, ≥2 routes |
| `rework-and-reliability` | artefacts byte-comparable | duplicate writes, retries, breaker latches | cost | 3 |
| `latency` | completion unchanged | p50/p95 TTFT, turn wall clock | cold-resume timed separately | 7 |
| `quality-regression` | near-100% expected | **pass^k**, not pass@k | - | 3 |
| `bundle-tuning` | operator rubric | rubric score, cost/run | refusals, off-policy actions | 5 |
| `route-comparison` | equivalence across routes | effective $/run, cached share | tool-call fidelity | 5 |
| `cross-harness` | completion, judged identically | completion rate, $/completed task | declared capability gaps | 5 |

Playbooks are plain files, PR-able and versioned. **The cookbook lives in data, not code** - this
is how the rig gets smarter without the binary getting fatter (see §13, rig sprawl).

## 8. The route axis

Delta speaks three wire formats, and they hand you **different levers**, so the same change is
worth different amounts on each.

| Route | Caching | Lever | Cost source |
|---|---|---|---|
| `anthropic-native` | explicit `cache_control` breakpoints; write premium, ~10x read discount, ~1024-token minimum, TTL is a choice | **breakpoint placement** - where 0.2.11's fix lived | computed locally |
| `openai-native` (incl. codex sign-in) | automatic longest-stable-prefix above ~1024 tokens; no breakpoints, no write premium | **prefix stability only** - breakpoint work is worth exactly zero here | computed locally; subscription runs metered but unbilled |
| `openrouter` | whatever the upstream does, and it can change under you | **none - this is a measurement, not a control** | reported in the usage chunk |

Consequences:

- A change targeting breakpoint placement **can only** pay on the route that has breakpoints. A
  bench that averages across routes hides that.
- `openai-native` punishes compaction rewrites hardest, which is where the Sphere finding bites: a
  context that SHRINKS vs the previous turn missed cache 16/16.
- OpenRouter's value in the bench is as a fidelity check - if a win vanishes there, it depended on
  control we do not have in the fallback path, and the fleet should know before it fails over.
- **A subscription arm needs its own accounting.** Real tokens at zero marginal dollars wins every
  cost column by construction. Report subscription arms in tokens and turns; mark the dollar column
  `n/a - subscription`, never `$0.00`.

## 9. Execution: ephemeral Fly Machines

12 fixtures × 2 arms × 5 repeats = 120 runs. One machine per cell: create from the arm's image,
seed the fixture workspace, drive through `/v1/tasks`, drain telemetry, destroy. Per-second billing
means the trade is concurrency, not money.

This is a natural fit rather than a hack: Delta already runs one agent per Machine with a mounted
volume, a control plane owning suspend/resume, and `/healthz` as the wake probe. A bench cell is
the same shape with a shorter life.

**Fidelity is a ladder, and the verdict must say which rung it ran on:**

| Rung | What it catches | Cost |
|---|---|---|
| `local` | logic; hides everything about the platform | seconds |
| `lane · warm` | real network, volume, region latency | ~1s dispatch |
| `lane · cold` | **only rung that sees suspend-resume defects** | seconds + MCP discovery |
| `lane · pinned` | same region/volume as the modelled production agent | provisioning |

The 300s Quick Search first-turn stall was a dead pooled socket after suspend-resume. No local run
and no warm-lane run could ever have produced it. A rig offering only the fast rung will tell you a
release is fine and be wrong in the exact way that costs a client.

Arm resolution:

```yaml
arms:
  A: { npm: "@carrara-labs/delta-harness@0.2.12" }   # what the fleet runs
  B: { git: "HEAD" }                                 # built from the worktree
  C: { image: "ghcr.io/carrara-labs/delta:0.2.11" }  # an exact prior release
```

## 10. Telemetry: nothing new to instrument

The bench is a reader. Every daemon already emits structured events on the spine
`user → agent → session/run → task → turn` into SQLite-as-outbox, shipped as NDJSON.
`DELTA_CAPTURE_PAYLOADS=1` is off in production and **on in every bench cell** - a bench with no
transcripts cannot grade anything.

| Event | Feeds |
|---|---|
| `turn.start` / `turn.end` | latency, completion |
| `model.call` | every cost and cache metric |
| `tool.call` / `tool.result` | rework, guard metrics |
| `compaction` | context-economics |
| `recall` / `retrieval` | memory playbooks |
| `self.pressure` | reliability |
| `error` | failure-mode diffs |

**Metric tiers:**

- **Gate** - did it do the job? Read FIRST. Fail here and no cost number is printed at all.
- **Primary** - what the change is trying to move. 1-3 metrics, declared in the plan.
- **Guard** - what this class of change is known to break. A guard regression blocks a primary win.
- **Report** - context, never a decision input.

Gate-before-cost is the single most important rule in the rig, because the failure it prevents is
the one that actually happened: an arm that filed 4 of 10 pages as garbage looked 60% cheaper.

## 11. Statistics

- **Paired differences.** Both arms run the same fixture, so the statistic is the mean of the
  per-fixture *difference*, not mean-of-A vs mean-of-B. Fixture-to-fixture variation cancels
  entirely. Published work puts arm correlation on the same question at roughly 0.3-0.7; the
  variance reduction is free.
- **Repetitions.** k per fixture per arm, set by the playbook from metric noisiness: structural
  counts settle around 3, latency needs 7+.
- **pass^k, not pass@k**, wherever the question is "does it work every time". A production agent
  that succeeds one try in three is not a working agent.
- **Clustered standard errors** at the fixture level. Five repeats of one fixture are five
  correlated observations; treating them as independent shrinks the error bars fraudulently.
- **Inconclusive is a first-class verdict.** An honest "we need more runs" beats a confident number
  that flips sign on the next execution.

The verdict card refuses to summarise itself as a single percentage, refuses to report a cost delta
without an interval, and refuses to let a primary win overrule a guard regression.

## 12. Foreign arms

Smallest contract that works, same shape the agent leaderboards converged on:

```ts
type ForeignArm = {
  name: string
  setup(fixture): Promise<Handle>          // seed workspace, start runtime
  send(handle, turn): Promise<Transcript>  // one user turn in, transcript out
  usage(handle): Promise<Usage>            // tokens, cached, cost, per call
  teardown(handle): Promise<void>
}
```

| Arm | Driven via | Comparable | Not comparable |
|---|---|---|---|
| Delta | `POST /v1/tasks` | everything | - |
| OpenClaw | gateway / headless CLI in its container | completion, turns, tokens, cost, cache r/w | much larger built-in toolset |
| Pi | `AgentSession` in isolated temp project dir | completion, turns, tokens | coding-agent shaped; some fixtures out of scope |
| Hermes | Python agent runner over a task record | completion, turns, tool-call counts | cost accounting differs, thinner cache reporting |

**Three rules or don't publish:** portable fixture subset (no Delta-specific tools); identical
grader for every arm, blind to which arm produced the output; capability gaps **declared, not
scored as failures** - a harness that cannot do a fixture is a footnote, not a zero that flatters
us.

## 13. Prior art - and we would not be first

Read from source in `~/delta/.refs`:

- **OpenClaw `extensions/qa-lab` - ahead of us.** ~250 files: scenario catalogue, Docker harness,
  `jsonl-replay.ts`, `runtime-parity.ts` (openclaw↔codex), `runtime-parity-cache-diagnostics.ts`,
  a 551-line `token-efficiency-report.ts`, mock-openai vs live-frontier provider modes, lab server
  with UI. Closest thing to this proposal that exists.
- **Pi `packages/evals` - partly.** Real `AgentSession` in isolated temp dirs, `harness-table.ts`
  with `baseline` vs `candidates` and `repetitions` - genuine statistical intent. Fixtures are
  hand-written smoke scenarios; no cost or cache metrics.
- **Hermes `batch_runner.py` - partly.** Parallel batch over JSONL with multiprocessing,
  checkpoint/resume, trajectory capture, tool-usage aggregation. Built for training-data
  generation, but the fault-tolerance design is the right one to copy.

Research-world shapes worth borrowing: **HAL** (framework-agnostic harness validated over 21,730
rollouts / 9 models / 9 benchmarks for ~$40k; scaffold decoupled from benchmark behind a
one-function interface; cost tracked at the API-call level) and **Inspect AI**
(dataset → task → solver → scorer, sandboxed execution, log viewer). Anthropic's eval guidance
supplies the discipline: capability suites separate from regression suites, grade outcome and
transcript but not the path, calibrate a model judge against human labels before trusting it, treat
a 0% pass rate as a broken task until proven otherwise.

| Capability | OpenClaw | Pi | Hermes | HAL/Inspect | Delta Bench |
|---|---|---|---|---|---|
| Replays recorded transcripts | yes | no | dataset only | no | yes |
| Fixtures from production telemetry | no | no | no | no | **yes** |
| Baseline vs candidate arms | yes | yes | no | yes | yes |
| Repetitions per cell | unclear | yes | n/a | yes | yes |
| Confidence intervals on the delta | no | no | no | partial | **yes** |
| Cache-economics metrics | yes | no | no | no | yes |
| Compares token routes | partial | no | no | no | **yes** |
| Foreign-harness arms | yes (2) | no | no | yes | yes |
| Gate ordered before cost | no | n/a | no | no | **yes** |
| Ships standalone for consumers | no | no | no | yes | **yes** |
| Ephemeral cloud fan-out | Docker | no | local pool | yes | Fly-native |

**The pitch must not pretend we are first.** What none of them has is the combination: fixtures
drawn from production telemetry, a statistical treatment that can say "inconclusive", the route
axis, and shipping standalone so a customer can point it at their own agent. Every rig above is
welded into the runtime it tests.

## 14. Package shape

```
@carrara-labs/delta-bench
├── src/
│   ├── plan.ts        bullets → plan.json (playbook matching)
│   ├── select.ts      agent_events → frozen fixture set
│   ├── arms.ts        npm | git | image → pinned, hashed
│   ├── exec/
│   │   ├── local.ts   daemon on this box
│   │   └── fly.ts     Machines API: create · seed · drive · drain · destroy
│   ├── score.ts       deterministic checks, then calibrated judge
│   ├── stats.ts       paired diffs · clustered SE · CI · pass^k
│   └── report.ts      verdict.md + self-contained report.html
├── playbooks/         the cookbook - plain files, PR-able, versioned
└── adapters/          delta.ts · openclaw.ts · pi.ts · hermes.ts
```

```
bench plan                      interactive: bullets in, plan out
bench select --from ferni --last 30d --worst cost
bench run <plan> [--local|--lane] [--resume]
bench report <run-id> [--html]
bench compare <run-a> <run-b>
bench playbook list|show|add
```

**Why a consumer installs it:** the engine is product-neutral, so the bench should be too. An
operator has the same question one level up - *did my DELTA.md edit make this agent better?* Today
they ship the edit and watch the bill. This closes the loop from "the engine is configurable" to
"the configuration is tunable", which is a materially different product claim.

## 15. Risks

| Risk | Mitigation |
|---|---|
| **Money** - 120 real agent runs per plan | local rung for iteration, lane for gates only; hard budget ceiling in the plan that aborts rather than overruns |
| **Replay fidelity** - stubs and time-dependent state | declare live/replayed/stubbed per tool on the verdict; never let a heavily-stubbed fixture carry a gate alone |
| **Fixture staleness** - frozen fixtures drift from the product | date-stamp sets, re-select quarterly, keep old sets runnable so historical verdicts stay meaningful |
| **Judge drift** - the grader is itself a model | pin judge model + prompt in the plan; keep a human-labelled calibration set; re-check agreement on any judge change |
| **Rig sprawl** - OpenClaw's lab is ~250 files | cookbook lives in data, not code |
| **Measuring the wrong thing well** | fixtures come from real complaints and real cost outliers, so the population is chosen by production |

## 16. Build order

| Milestone | Scope | Size |
|---|---|---|
| **M0 · thin slice** | one playbook (`context-economics`), local rung only, fixtures hand-exported from `agent_events`, paired diffs + CI, gate before cost. Enough to grade the open age-gated elision change. | days |
| **M1 · the lane** | Fly executor (create/seed/drive/drain/destroy), checkpoint + resume, concurrency cap, cold-resume rung, automated fixture selection, three more playbooks | a sprint |
| **M2 · the axes** | route comparison across all three wires, foreign-harness adapters, HTML report, overnight release-gate battery | a sprint |
| **M3 · ship it** | publish as `@carrara-labs/delta-bench` with the consumer story | after it has gated two releases |

**M0 is not speculative.** There is an open engine question right now - whether eliding a tool
call's arguments once it is N turns old beats both seams already tried (see
`docs/spec-arg-eviction.md` §15) - and it has three existing arms to compare against. Building M0
to answer that question is how the rig gets specified by real use instead of by design, which is
the only way it ends up lean.

## 17. Sources

- Anthropic, *Demystifying evals for AI agents* - https://anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, *Adding Error Bars to Evals* - https://www.anthropic.com/research/statistical-approach-to-model-evals
- Anthropic, *Building Effective Agents* - https://www.anthropic.com/research/building-effective-agents
- *Holistic Agent Leaderboard* - https://arxiv.org/abs/2510.11977 · https://github.com/princeton-pli/hal-harness
- *Inspect AI* (UK AISI) - https://inspect.aisi.org.uk/
- Competitor rigs read from source in `~/delta/.refs/{openclaw,pi,hermes-agent}`
