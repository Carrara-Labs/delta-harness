# Spec: per-run scratch must be relocatable off the workspace

Status: **spec v1, pre-implementation.** D-7 of `docs/backlog-delos-field-report.md`. Batch:
`harness-0.2.15-plan.md`, item 5. Looks like a one-line env read. It is not — §3 is a migration hazard
that silently reintroduces the defect 0.2.11 fixed, and it is the reason this got its own spec.

## 1. The defect

**Three** per-run artifact families are rooted in the workspace, each with its own wipe site. The
first version of this spec listed two families and one wipe site; the Delos operator read it and
found the rest, all three confirmed at the line:

| family | write site | wipe site | wiped when | path |
|---|---|---|---|---|
| capped tool results | `tools.ts:158` `spillPathFor` | `queue.ts:437` `wipeRunSpill` | ephemeral only | `${workspace}/.delta/spill/<runId>.<callId>.txt` |
| research child artifacts | `research.ts:275` | `queue.ts:443` `wipeRunResearch` | ephemeral only | `${workspace}/research/<runId>.<seq>/` |
| **the model's own scratchpad** | the model, via `{{run.scratch}}` | `queue.ts:403` `wipeRunScratch` | **every terminal run** | `${workspace}/scratch/<runId>/` |

The third is the one nobody had written down, and it is the most exposed of the three: `run.ts:828`
advertises `"run.scratch": \`scratch/${run.id}\`` **to the model**, so this is a directory the agent is
actively instructed to write into, at the root of whatever the workspace is. On a scratch checkout
that is invisible. On a git-tracked document vault it is model-authored content landing in a
human-browsed namespace.

Its saving grace is the wipe: `queue.ts:403` runs for *every* terminal run, not just ephemeral ones,
so it self-cleans. Delos could not show it ever reaching git — `git log -- scratch/` is empty there —
and reports the gap honestly as **unobserved rather than disproven**: the per-run wipe would have to
lose a race with their 2-minute vault commit loop. `research/` by contrast **did** reach git twice
before they added an ignore rule.

Correct for a scratch checkout. Wrong when the workspace is what Delos's is: a **git-tracked,
phone-synced Obsidian vault.** Consequences observed there:

- Raw un-stripped web fetches — untrusted third-party content, sometimes hundreds of KB — were being
  **committed to git and delivered to the operator's phone.**
- `research/` **collided with the vault's own convention** for real research notes, so engine output
  and human documents landed in the same namespace.

Neither is a bug in the vault's setup. `workspace` is documented as the agent's working directory and
the bundle lives there; nothing ever said it was also the place the engine writes megabytes of
untrusted intermediate state.

## 2. The fix

`DELTA_SCRATCH_DIR`, defaulting to the workspace, so existing deployments are unchanged:

```ts
// config.ts, beside the other path reads
scratchDir: resolve(env.DELTA_SCRATCH_DIR ?? env.DELTA_WORKSPACE ?? "."),
```

Thread it to the three sites. `spillPathFor` already takes its root as a parameter, so only the
argument changes:

```ts
export function spillPathFor(root: string, runId: string, callId: string): string {
  const safe = (s: string) => s.replace(/[^\w-]/g, "_").slice(0, 80);
  return `${root}/.delta/spill/${safe(runId)}.${safe(callId)}.txt`;
}
```

**Keep the `.delta/spill/` segment under the new root.** `SPILL_PATH_RE`
(`compaction.ts:180`, `/\/[^\s;"']*\.delta\/spill\/[\w.-]+/g`) matches on that segment and is therefore
already root-agnostic — the artifact ledger and `sessionArtifacts`
(`spec-exhaustion-handoff.md` §4.2) keep working across both roots for free. Changing the segment name
would break the ledger for every historical row. Do not.

Research artifacts move to **`${scratchDir}/.delta/research/<runId>.<seq>/`** — hidden and uniquely
named, see §6.2 for why the rename is not cosmetic — and the existing escape guard must realpath
against the **scratch** root rather than the workspace (`research.ts:277-280` currently realpaths both
sides against `workspace`; that check is correct in shape and just needs the other root).

The model's scratchpad moves to `${scratchDir}/.delta/scratch/<runId>/`, which means
**`run.ts:828` must advertise the new relative path** in `{{run.scratch}}` and `queue.ts:403` must wipe
the same root. This one is a contract with the model, not just a filesystem detail: if the advertised
string and the wiped directory disagree, the agent writes somewhere nothing ever cleans.

## 3. The hazard: relocating the root silently stops demotion

This is the part that makes it a spec.

`demoteSpilled` (`compaction.ts:199-229`) does not parse the path out of the message. It **derives** it
from the row's own identity — deliberately, because a tool result is model-visible and
attacker-influenced, and a forged path could suppress demotion or point at an arbitrary file
(the comment at `compaction.ts:208-211` is explicit). Then:

```ts
const path = spillPathFor(workspace, row.run_id, m.tool_call_id ?? "");
if (!m.content.includes(path)) return msg;   // not one of ours → leave it alone
...
if (!existsSync(path)) return msg;
```

**If the root changes, every pre-existing row fails both guards.** The stored content contains the old
absolute path, the derived path is the new one, `includes` is false, and the row is left untouched. The
file is also at the old location, so `existsSync` fails too.

The consequence is not a missing file. It is that **the retained tail stops shrinking** — demotion is
one of the two rails that bound it, and the other (`elideRowArgs`) only handles assistant arguments. A
long-lived session upgraded across this change would compact, pay for a summary call, and discover the
floor had not moved: precisely the defect `spec-compaction-tail.md` and 0.2.11 were written to fix, and
it would present as a performance regression with no error.

The same reasoning applies to the wipe sites, and there the second instance is worse than the first.
`wipeRunSpill` under a new root leaks every spill file written under the old one — bad, bounded.
**`wipeRunResearch` fails in the opposite direction and silently.** If research writes move to
`${scratchDir}/research/` while `queue.ts:443` keeps wiping `${workspace}/research`, then artifacts
are *written to the new root and wiped from the old one*: the cleanup no-ops forever and the new tree
accumulates without bound. Nothing errors, because `wipeByPrefix` swallows a missing directory by
design (`queue.ts:448-452`, "most runs spill/research nothing").

That is the §3 hazard's second instance, and the first version of this spec did not cover it because
it reasoned about `spillPathFor` only. Every one of the three families must move its write site and
its wipe site in the same commit, or not move at all.

### 3.1 The remedy

Derive against the configured root, and on a miss retry **once** against the legacy workspace root:

```ts
function demoteSpilled(row: Row, roots: { scratch: string; workspace: string }): string {
  ...
  const callId = (m as { tool_call_id?: string }).tool_call_id ?? "";
  const candidates = roots.scratch === roots.workspace
    ? [spillPathFor(roots.scratch, row.run_id, callId)]
    : [spillPathFor(roots.scratch, row.run_id, callId),
       spillPathFor(roots.workspace, row.run_id, callId)];
  const path = candidates.find((p) => m.content.includes(p) && existsSync(p));
  if (!path) return msg;
  ...
}
```

Bounded at two derivations, both still engine-derived — the security property is untouched, because
neither candidate comes from message content. When the roots are equal (the default, and every existing
deployment) the behaviour is byte-identical to today.

`queue.wipeSpill` gains the same treatment: wipe both roots by prefix when they differ.

## 4. What must not change

1. **The derivation-not-parsing property.** Paths are still computed from `run_id` + `tool_call_id`,
   never read out of model-visible content. Both candidates are engine-authored. This is the P1 that
   the original review of this code caught; do not regress it by "just using the path in the message".
2. **The `safe()` sanitiser** on both id components stays. A hostile `../`-laden `tool_call_id` must not
   escape the spill dir under either root.
3. **`.delta/spill/` as the segment.** §2.
4. **The ephemeral-only wipe policy.** `queue.ts:415-417` wipes run spill **only** for ephemeral
   (`store: false`) turns, with a comment saying why: durable sessions depend on those files surviving
   across runs, because `recall` reconstructs spill paths from a prior turn's transcript and compaction
   accumulates the pointers. **This spec relocates scratch; it does not bound it.** Do not let a
   "while we're here" retention sweep in — one was built and reverted the same day
   (see `shipping-list.md`, "Spill lifetime, still unsolved"), and the reference-holder set is
   "anything ever mentioned in this thread", which no age approximates.
5. **`sweepTrash` still never touches `.delta/spill`** under either root.

## 5. The test that fails without the fix

`test/spill.scratch.test.ts`:

1. **Relocation.** Set `DELTA_SCRATCH_DIR` to a temp dir outside the workspace. Run a tool returning
   >20KB. Assert the spill file exists under the scratch root, **nothing** was written under
   `workspace/.delta/`, and the workspace tree is otherwise unchanged (this is the vault-pollution
   assertion — a `readdirSync(workspace)` diff).
2. **Demotion under the new root.** Compact that session; assert the row is demoted and the stub points
   at the scratch path.
3. **Legacy rows still demote.** Hand-write a message row whose content carries a
   `workspace/.delta/spill/...` path, create that file, then compact with a *different* scratch root
   configured. Assert it demotes. **This is the assertion that catches the §3 hazard**; it fails under
   the naive one-line version of this change.
4. **Ledger continuity.** `sessionArtifacts` returns paths from both roots in one session.
5. **Research isolation.** A research run writes under `${scratch}/research/...`, and an attempt to
   escape (`seq` crafted to traverse) is still refused.
6. **Default equality.** With `DELTA_SCRATCH_DIR` unset, every path is byte-identical to pre-change.

Pre-fix, 1, 2, 4 and 5 fail; 3 fails against a naive implementation and passes against §3.1, which is
the specific reason it is in the list.

## 6. Resolved — answered by the Delos operator, 2026-08-18

All four questions came back answered, and the answers changed three of them. Recorded here rather
than in a reply thread, because the next reader of this spec needs the reasoning, not the correspondence.

### 6.1 Legacy fallback: **(a), plus a startup WARN**

The spec offered (a) fallback forever, (b) a boot migration, (c) refuse to start on a changed root
with existing spill rows. The spec leaned (a) and called (c) "defensible and safer for a fleet".

**(c) is rejected, and the reason is operational rather than technical:** it turns a configuration
change into an outage. An unattended agent that speaks through a chat surface does not report a
refusal to boot — it simply goes silent, and the operator learns from the absence of a reply hours
later. That is a worse failure than the one being prevented, since the fallback's own failure mode is
benign: an old artifact is not found, demotion skips, which is exactly what happens today.

Take **(a)**, and emit a startup `WARN` naming both roots so the divergence is visible without being
fatal.

### 6.2 `research/` → **`.delta/research/`**, on a better argument than the spec had

The spec argued the rename was optional: *"once relocated the collision is gone, so the name can
stay."* That reasoning only holds for deployments that **set** `DELTA_SCRATCH_DIR`. The default is
`env.DELTA_SCRATCH_DIR ?? env.DELTA_WORKSPACE`, so on upgrade day — for every existing deployment —
the scratch root **is** the workspace and `research/` does not move at all. Keeping the name fixes the
collision only for operators who already knew to move it; renaming fixes it for everyone.

The decisive argument is what the alternative costs an operator. Delos's D-7 workaround was a
`research/` entry in the vault's `.gitignore`, and **that rule was itself a footgun**: a bare pattern
matches the basename at any depth, so it silently ignored new files in five legitimate vault folders
(`Carrara/internal/research`, `Personal/stocks/strategy/research`, and three more). Existing files
survived only because git ignores rules for already-tracked paths; anything new would have vanished.

**A hidden, uniquely-named root needs no operator ignore rule at all**, so no operator has to write a
pattern that can misfire. That outweighs breaking hand-reading for the people who read these
directly — including, by their own account, the deployment that reads them most.

### 6.3 Container default: **`/data/scratch`**

Agreed, and it belongs in `connect/deploy/fly.toml` rather than the engine default. Delos will set
`DELTA_SCRATCH_DIR` to machine-local state beside its database, off the git-tracked vault entirely.

**Name it in the release brief.** A knob only helps operators who are told the default is wrong for
them, and the deployments most exposed to this are exactly the ones that pointed a workspace at
something precious.

### 6.4 Derivation sites: `recall` confirmed clean, inventory was **incomplete**

`recall` needs nothing — journal-keyed by `{runSeq, callId, field}`, never touches the filesystem,
confirmed independently. But the instruction to "confirm independently, because 'the comment implied a
fourth site' is exactly how a migration ships half-done" paid off in the other direction: the operator
found **two more sites the spec had missed**, `wipeRunResearch` and the entire
`${workspace}/scratch/<runId>` family. Both are now in §1, and `wipeRunResearch` is the second
instance of the §3 hazard.

### 6.5 Migration: **do not**

Leave existing `research/` and spill trees where they are; write new ones under the new root. These
are disposable scratch, a migration step is more risk than the mess is worth, and the fallback in §3.1
already keeps historical rows demoting. Operators delete the stale directories by hand — Delos has 42
of them and will.

## 7. Still open for the reviewer

1. **Does `.delta/scratch/` break the `{{run.scratch}}` contract for anyone?** The advertised value is
   a relative path the model is told to write into. Changing it is safe for a fresh run and
   meaningless mid-run (the dir is wiped at termination anyway), but confirm nothing persists the old
   string — a `PROMPT_CONTEXT.md` that hardcodes `scratch/` rather than `{{run.scratch}}` would break
   silently.
2. **Should the startup WARN in §6.1 fire only when the roots differ, or whenever legacy artifacts are
   found under the old root?** The second is more useful and needs a directory read at boot.
3. **`wipeRunSpill` and `wipeRunResearch` are ephemeral-only; `wipeRunScratch` is every-run.** With
   three families under one configurable root, is that asymmetry still right, or is it now just
   confusing? It is defensible per family and hard to explain as a set.

## 8. Review outcome — Codex pass, 2026-08-19: §2 is redesigned

The pass found a release-blocker the spec and both prior readers missed: **relocation as written
makes every artifact unreadable and the scratchpad unwritable.**

- `read_file` confines to `ctx.workspace` via `inside()` (`builtins.ts:374`) — a spill or research
  path under an off-workspace `DELTA_SCRATCH_DIR` cannot be read by the model at all. The demotion
  stub's "read_file this path" contract and `recall`'s reconstructed paths both break.
- `.delta/*` is write-reserved for model file tools (`fileClass`, `builtins.ts:130`) — reads are
  allowed (spill is read today), but §2's `.delta/scratch/<runId>` scratchpad could never be
  written by the model it is advertised to.

### The corrected shape

1. `scratchDir` config, default workspace — unchanged.
2. **Spill** → `${scratchDir}/.delta/spill/` (segment unchanged). **Research** →
   `${scratchDir}/.delta/research/<runId>.<seq>/` (rename per §6.2 stands — readable under
   `.delta/`, exactly like spill today). **Scratchpad** → `${scratchDir}/scratch/<runId>/` —
   NOT under `.delta/`, because the model must write there.
3. **The confinement seam:** file tools accept a second root. `inside()` resolution tries the
   workspace as today; an absolute path (or resolution) landing under `scratchDir` is equally
   in-bounds. `guardWrite`'s reserved-path classes apply under BOTH roots, so `.delta/*` stays
   write-reserved everywhere and the scratchpad stays writable. When the roots are equal this is
   byte-identical to today.
4. `{{run.scratch}}` advertises `scratch/<runId>` (relative, unchanged) when the roots are equal,
   and the absolute `${scratchDir}/scratch/<runId>` when they differ.
5. Wipe sites move with write sites, same commit. `wipeRunSpill`/`wipeRunResearch`/`wipeRunScratch`
   each wipe both roots when they differ (crash-resume across a root change strands run-scoped
   dirs under the old root — spill was the only family §3.1 covered).
6. §7.2 decided: WARN when roots differ, **plus** a fail-open nonempty probe for legacy layouts —
   including when roots are equal, because the `research/` → `.delta/research/` rename applies to
   every deployment. Never auto-delete.
7. §7.3 decided: the per-family wipe-policy asymmetry stays — one root does not imply one
   lifecycle. Document it as a set in the guide.
8. §5's "default equality" test is restated: with `DELTA_SCRATCH_DIR` unset, spill and scratchpad
   paths are byte-identical to pre-change; research paths intentionally rename (that is §6.2's
   point). §5.5's `${scratch}/research/...` expectation was stale — it is
   `${scratch}/.delta/research/...`.
