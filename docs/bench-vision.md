# The bench we want (ambition, NOT being built yet)

Written 2026-08-06, during the 0.2.12 work, after a measurement failure made the need obvious.
**Nothing here is scheduled.** It is written down so the next person does not re-derive it, and so
the small tests we run in the meantime are shaped to feed it.

> **Superseded by [`spec-delta-bench.md`](./spec-delta-bench.md)** (2026-08-07), which carries the
> full design: playbook library, the token-route axis, Fly execution, the statistics, foreign-harness
> arms, and the prior-art survey (OpenClaw's `qa-lab` is ahead of us on replay and cache
> diagnostics). Visual version at `bench/delta-bench-proposal.html`. This file is kept for the
> origin story in "Why this exists" below.

## Why this exists

During 0.2.12 I reported a **-29.9% cost win** from one run per arm. A second run of the identical
change measured **+22.9%**, and the first run had silently been doing **50% more writes** than the
control. The claim had to be retracted.

That is not a bad number, it is the absence of a method. Three failures in one:

1. **one run per arm against a nondeterministic model is not a measurement;**
2. **the metric set was chosen after the fact**, so it happened not to include the thing that broke;
3. **the workload was invented by the person judging the result.**

A harness that claims to beat the competition has to be able to prove a release is better than the
one before it. Today we cannot, and that is the gap.

## The core idea: replay real runs, don't invent them

The fixtures should be **actual production runs**, not synthetic shapes.

We now have real usage across several agent types. The interesting runs announce themselves:

- **expensive** - top cost per run, or worst cost-per-delivered-unit;
- **long** - highest turn count, or wall-clock outliers;
- **repetitive** - the user had to follow up many times, which is the honest signal that the agent
  did not finish the job;
- **failed or degraded** - `context_irreducible`, budget exhaustion, breaker latches, compaction
  storms.

Those runs are the benchmark. They are already in `agent_events`, with their inputs, their turn
counts and their outcomes.

**Why replay beats invention.** The rework regression in 0.2.12 was only visible because the
workload resembled real filing work. A synthetic fixture I designed would have measured what I
expected to measure. A real run measures what actually happens, including the parts nobody thought
to look for.

## The shape

```
bench replay <run-selector> --arm-a <engine|url> --arm-b <engine|url> --runs N
     │
     ├─ selects real runs from agent_events (by cost / turns / follow-ups / failure)
     ├─ replays each against BOTH arms under identical conditions
     ├─ reads back the same telemetry both arms emit
     └─ one table: quality gate → cost/latency → variance
```

**Product-specific by construction**, because the fixture IS the product's own run. The rig itself
stays thin: it drives the harness seam and reads `agent_events`, both of which every agent already
speaks - Quick Search, Intake, Prep, Ferni, Brain. No product API, no product database.

### Two modes, one flag, identical fixtures

| | `--local` | `--lane` |
|---|---|---|
| Against | a daemon on your box with the real bundle | the actual Fly lane |
| For | iterating, overnight sweeps, cheap | the release gate, production fidelity |

The mode must never fork the fixtures or the metrics. The moment they diverge the local number
stops meaning anything.

### Non-negotiables, each one learned the hard way in 0.2.12

- **The quality gate is reported BEFORE any cost number.** A run that gets cheap by delivering less
  is a regression. In 0.2.12 an arm filed 4 of 10 pages as garbage and looked 60% cheaper for it.
- **Duplicate/repeated work is a first-class metric**, beside cost and latency. It is how the rework
  regression was caught, and it was invisible in the first two runs.
- **N runs per arm, with variance shown.** Never a single run.
- **A named control fixture that must show NO change**, so "most consumers see nothing" is proven
  rather than asserted.
- **The metric set is fixed before the change is written**, not after the result is seen.

## Further out: ship it as a package

The same rig is what a *consumer* needs to answer "did my DELTA.md edit make this agent better?"
Prompt, policy, model, effort and tool-surface changes all deserve the same A/B discipline as an
engine change, and nobody has a way to do that today.

If it ships as its own package, the loop closes: an operator tunes a bundle, replays their own worst
runs against the tweak, and gets a table. That is a genuinely differentiated thing to offer, and it
is the natural end state of "the engine is product-neutral" - the bench should be too.

## What we are doing instead, for now

Deliberately staying small. The next engine change is tested with the best rig we can assemble
quickly, and **what that test struggles with is the input to this document.** Concretely, the open
questions the next round should answer:

- how faithfully can a local daemon stand in for a lane, and where does it stop being honest?
- how many runs per arm are actually needed before the variance settles?
- which of the metrics above turn out to be load-bearing, and which are noise?
- what does replaying a real run require that a synthetic fixture does not (state, seeded workspace,
  tool mocks, timing)?

Answer those with a small tool on real work, and the rig above becomes a build rather than a design
exercise.
