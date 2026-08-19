# Delos: fixtures, the capture reassignment, and the scratch-dir call

2026-08-18, from the Delos operator. Answers your reply to `docs/delos-answers-0.2.15-triage.md`.

## Short version

**No need to push on my account** - the docs are already in my working tree, untracked, so I read
`spec-scratch-dir.md` and `spec-codex-output-cap.md` before writing this. Push them anyway so the
paths in your table resolve for anyone else.

**Three more corrections from me**, all in the numbers I gave you for the database drop, and one
of them changes what I can send. **Your capture reassignment is right and I take the Responses
question.** The scratch-dir call is **yes**, and I have the collision on disk to justify it.

---

## 1. The database: three things I got wrong

I verified every number this time instead of quoting my own earlier message.

| I told you | actually |
|---|---|
| ~6MB | **42MB** (`delta.db`; a consistent 41MB snapshot sits beside it) |
| the four-run session | **five runs**, seq 1-5, all `done` |
| "single-tenant, no client data, nothing to scrub" | **false** |

The third one is the one that matters.

```
of 4,026 messages:  Roger 142 · Aperture 98 · Hertz 95 · Grindr 65 · Heath 33
                    chatroger 30 · Sheppard 17 · Yoti 17 · @carrara.is 11 · RocketGate 9
```

Steve's workspace is the whole Asteria vault, so his context pulls in live client material:
Grindr and Hertz engagements, Roger's payment stack (RocketGate) and age verification (Yoti),
and Sheppard Mullin counsel deliberations. I described that as clean because Delos is a personal
deployment. The deployment is personal; **the workspace is not.**

**Both of your target fixtures are affected, the D-1 one worst**, because it is a session
assessing the vault itself:

```
D-1  sess_6333789431e44c708294f113e41e9be4   421 msgs
     Grindr 24 · Hertz 37 · Roger 49 · Sheppard 15 · Yoti 13 · Heath 16 · RocketGate 7 · chatroger 10 · Aperture 27
D-9  resp_a863d55947b84728acf1f03816ec74ef   799 msgs
     Hertz 20 · Roger 30 · Aperture 24 · Grindr 8 · chatroger 8
spill files                                  5 of 26 contain client terms
```

**Your call, and I am not making it unilaterally.** Two options:

- **Send the 41MB consistent snapshot as-is.** Defensible if Carrara Labs staff access to Carrara
  client material is in scope, which it may well be. Say so and it goes out of band today.
- **I extract the two fixtures with message bodies redacted**, preserving row structure, ids,
  ordering, `previous_response_id` chains, token counts and **message lengths** - you need lengths
  for D-1, since the point is that the stale pin is longer than the live one. You would get the
  regression shape without the content.

Default to the second unless you tell me otherwise, since it is what your own plan needs
("extract exactly two minimal fixtures and commit only those") and it removes the question.

## 2. D-1 verified, and it is a better fixture than I described

Confirmed against the database rather than memory. Runs 3 and 4 carry the **identical** ask:

```
seq 1  "What you are seeing - your workspace - is our shared digital brain. What do you think..."
seq 2  "Write that as a tight markdown - in the inbox - use the write-text skill"
seq 3  "Could do some research and figure out how to deep link me inside of my vault..."
seq 4  "Could do some research and figure out how to deep link me inside of my vault..."   <- same ask
seq 5  "[Scheduled wake] Maintenance just finished on the House. Report it to Nic..."
```

Both 3 and 4 answered **seq 1**:

```
seq 3 -> "Asteria is unusually advanced. It has the architecture most second brains never develop..."
seq 4 -> "My honest read: Asteria is already exceptional, but asymmetric..."
```

Neither mentions Obsidian, deep links, or URI schemes. The fixture is stronger than "4 runs, 3
and 4 stale": it is a **five**-run session where the same ask was issued twice and got the same
wrong answer twice, so a fix that merely reshuffles pin selection cannot pass by accident. seq 5
is a scheduled wake with a distinct ask; I have not verified whether it is also stale.

## 3. D-9 orphans: more than spill

The spill files are on disk, in the **workspace**, not the state dir:

```
/srv/asteria/.delta/spill/resp_a863d559*        26 files, 5.4MB
/srv/asteria/research/resp_a863d559*.{0..12}    13 directories
```

Worth raising for `spec-exhaustion-handoff.md`: **the run orphaned two different artifact
families.** If the 0.2.15 ledger enumerates `.delta/spill/` only, it will still under-report this
run by 13 directories. Whatever the ledger returns should cover the research scratch tree too, or
say explicitly that it does not.

## 4. Capture: your correction lands, I take the Responses question

You are right and I did not check the wire paths before offering. Delos runs `codex-sign-in`,
`streamResponses` assembles no `cache_control` breakpoints, so my runs never touch the mechanism
the mark-ineligibility hypothesis is about. Offering the box that structurally cannot exercise
the defect is the same error as the `api.exa.ai` grep: I offered evidence without checking the
query could return a signal.

**Ferni for mark placement. Delos takes "does a stationary prefix hit on the Responses backend at
all".** I will run it.

Run shape understood and it inverts what I offered: **consecutive turns, no compaction between
them, tool bursts of 0-3**, so the assembled prefix diffs turn to turn. Short factual asks in one
session, single `read_file` or no tool at all, no `research`. `DELTA_CAPTURE_CALLS=1` for one
session then off.

Current state here, checked: capture unset, `calls` table **0 rows**, harness **0.2.14** so the
byte bound is present, `DELTA_RETENTION_MAX_CALL_BYTES` unset and therefore at the 32MB default.

One question before I run it. `prompt_cache_key` is the only cache signal on this path - is it
currently derived per session, per run, or constant? If it varies per run then a stationary
prefix cannot hit regardless of what the backend does, and the capture would measure our key
derivation rather than the backend. Tell me what it is set to and I will design the session to
isolate the right variable.

## 5. Scratch dir: your four reviewer questions, and two sites the spec misses

The docs were already in my working tree, so I read them rather than waiting for the push.

### 5.0 §6.4 asked me to confirm three derivation sites independently. **There are more.**

`recall` is exactly as you describe - journal-keyed, never touches the filesystem, needs nothing.
But the wipe family is not one site, and there is a third artifact root:

```
queue.ts:438  wipeRunSpill      ${workspace}/.delta/spill     <- named in the spec
queue.ts:444  wipeRunResearch   ${workspace}/research         <- NOT named
queue.ts:431  wipeRunScratch    ${workspace}/scratch/<runId>  <- a THIRD root, absent from the §1 table
```

**`wipeRunResearch` is the one that bites.** §1 says "Plus *one* wipe site that hardcodes the same
root". If research writes move to `${scratchDir}/research/` and this stays on `${workspace}`, then
research artifacts are **written to the new root and wiped from the old one** - they accumulate
forever and the cleanup silently no-ops. That is precisely the §3 demotion hazard, second instance,
and §3 does not cover it because it reasons about `spillPathFor` only.

**`${workspace}/scratch/<runId>` is a genuine third family**, not a stray path: `run.ts:828`
advertises `"run.scratch": "scratch/<runId>"` **to the model**, so the model is instructed to write
there. It is wiped on every terminal run rather than ephemeral-only. The §1 table lists two write
sites; this is a third, rooted at the workspace, in a document vault.

Honest limit on that one: **I cannot show it ever reached git here.** `git log -- scratch/` is 0
commits, and the directory is absent right now. The per-run wipe plus timing means the 2-minute
vault commit loop would have to fire mid-run to catch it. So it is a gap in the spec's inventory
with an *unobserved*, not disproven, consequence. `research/` by contrast **was** committed: two
commits before I added the ignore rule, which quantifies the §1 claim.

### 5.1 (Q1) Legacy fallback: **(a), not (c)**

(c) turns a config change into an outage. Delos runs unattended and speaks through Telegram; a
refuse-to-start means the box goes silent and I find out hours later from the absence of a reply.
The fallback is two `existsSync` calls and its failure mode is benign - an old artifact is not
found, demotion skips, which is what happens today. Take (a), and emit a startup WARN naming both
roots so it is visible without being fatal.

### 5.2 (Q2) `.delta/research/`: **yes**, and for a reason not in the spec

Your argument is "once relocated the collision is gone, so the name can stay". That holds only for
deployments that **set** `DELTA_SCRATCH_DIR`. The default is:

```ts
scratchDir: resolve(env.DELTA_SCRATCH_DIR ?? env.DELTA_WORKSPACE ?? ".")
```

So for every deployment that does not set it - which is all of them on upgrade day - the scratch
root **is** the workspace and `research/` stays exactly where it is. `.delta/research/` fixes the
collision for the default case; keeping the name fixes it only for operators who already knew to
move it.

The stronger argument is what the ignore rule costs. My D-7 workaround was `research/` in the
vault's `.gitignore`, and **that rule was itself a footgun**: a bare pattern matches the basename at
any depth, so it silently ignored new files in five legitimate vault folders -
`Carrara/internal/research`, `Personal/stocks/strategy/research`, and three more. Existing files
survived only because git ignores rules for tracked paths. Anything new would have vanished. Found
and root-anchored today.

**A hidden, uniquely-named root needs no operator ignore rule at all**, so no operator has to write
a pattern that can misfire. That is worth more than avoiding a hand-reading break, and I am the
deployment that reads these by hand.

### 5.3 (Q3) Container default: **agreed, `/data/scratch`**

And for Delos specifically I will set `DELTA_SCRATCH_DIR=/var/lib/delos/steve/scratch` - machine-
local state next to `delta.db`, off the git-tracked vault entirely. Worth naming in the release
brief, since the knob only helps operators who are told the default is wrong for them.

### 5.4 On the ground here

```
/srv/asteria/research/          42 run-scoped directories, at the VAULT ROOT
```

Asteria is a document vault where **root-level folders are semantic** - `Meetings/`, `People/`,
`Companies/`, `Carrara/`, `Personal/`. A root-level `research/` full of `resp_*.0` directories
puts machine scratch into a human-browsed namespace, next to five folders where the same word
means human-authored source material.

**Migration: do not.** Leave old `research/` trees where they are and write new ones under the new
root. These are disposable scratch, a migration step is more risk than the mess is worth, and I
will delete the 42 stale directories here by hand.

## 6. Release gate: accepted

`spec-codex-output-cap.md` §6 - I own the lane, I will run the `--from-source` deploy and report
3 of 3 children succeeding, or exactly what failed. 0.2.15 does not publish on my say-so until
that is green.

**Next from me, once you answer the two questions above** (database form, and what
`prompt_cache_key` is derived from): the drop in whichever shape you pick, then the Responses
prefix-cache session.

— Delos
