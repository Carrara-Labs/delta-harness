# To the Aperture engineer: 0.2.15 is published — you lead the testing from here

2026-08-19, from the Delta Harness maintainer. `@carrara-labs/delta-harness@0.2.15` is on npm
(CI-built, provenance-signed, tag `v0.2.15`), already redeployed onto Ferni from the published
tarball and verified live, and D-12 passed its live gate on the one Codex-backend lane — 3/3
children, with a negative control reproducing the old 0/3 the same minute. Your fleet is next,
and the plan below is built around your two constraints: Quick Search must get better without
risk, and the OpenAI path must be demo-ready fast.

Full receipts, in order of usefulness to you:

- `docs/release-brief-0.2.15.md` — what shipped, what it is worth, and to whom (the measured table)
- `CHANGELOG.md` §0.2.15 — the complete list with the three upgrade-day behavior changes
- `docs/brief-aperture-lab-validation.md` — your standing A/B assignment; unchanged, now with a purpose
- `docs/reply-aperture-qs-config.md` — the config track (unchanged; the two-step config rollout still applies)

## 1. Sequencing — the one rule that protects everything else

**Finish the 0.2.14 A/B first if it is still running.** Do not upgrade mid-battery. The moment the
0.2.14 arms are complete:

1. Upgrade the two bench lanes (`speed-lab`, `google-deepmind`) to published 0.2.15.
2. Re-run the SAME pinned battery, unchanged. That re-run **is** the release acceptance test —
   same prompts, same tiers, so 0.2.14 vs 0.2.15 is attributable.
3. On a clean verdict, roll carrara, then the client lanes. Your control plane already selects
   the right rest verb for ≥0.2.4, so nothing changes there.

## 2. What changes for Quick Search on upgrade day — and what does not

You asked the two right questions; here are the answers with the receipts.

**D-1 (compaction ask pin) helps QS specifically — the measurement came from your lanes.** On
`aperture-qs-69598a208017`, 27 of 27 exposed compactions pinned a different task than the one
being served, zero harmless, and 23 of the 27 stale pins were LONGER than the live request —
a big old search outranking a short live one, mid-run, as trusted instructions. QS has no
standing first-request frame to lose: your identity and drafting rules live in DELTA.md/POLICY,
which render every turn. The pin only exists after a compaction fires, so your simple tier is
untouched. Watch the hard tier's artifact-quality check — same people found, identifiers intact —
that is where this fix should show.

**D-7 (scratch relocation) changes nothing for you unless you opt in.** `DELTA_SCRATCH_DIR`
defaults to the workspace; your lanes do not set it, so spill and scratchpad paths are
byte-identical. Model-written files — staged bodies, saved artifacts, anything via `write_file` —
are untouched everywhere. The ONE universal change: research artifacts write under
`.delta/research/` instead of `research/`. Within a run this is self-consistent (the tool returns
the new paths); your artifacts flow through `qs_save_artifact` to your app, not through that
directory — but **if any Aperture-side script reads `${workspace}/research/` directly, that is
the single thing to grep for before rolling.**

**The other two visible changes:**
- A failed run's `output_text` is now a user-facing handoff (plan + artifact paths + advice), not
  `budget exhausted: N/M…`. The counters live in `runs.error` and the `error` event, unchanged.
  If anything on your side string-matches counters out of `output_text`, move it to `runs.error`.
  For your users this is strictly better: the eleven QS runs that burned $141 and 158 minutes
  returning one sentence would each have returned their plan and every result file.
- The `code` CLI default gains `--disable apps --disable plugins`. Your lanes run your MCP
  toolset; if any lane deliberately uses a CLI account connector through `code`, set
  `DELTA_CODE_CLI` explicitly (used verbatim). Otherwise: nothing.

**What is byte-identical:** single-request sessions (apart from one lead-in sentence), budgets,
wire formats, the seam, and every config value you already run.

## 3. New instruments — wire these into your fleet checks

- **`GET /v1/status` now reports `tools.registered` / `tools.unusable` / `tools.omitted`, with
  reasons.** Poll it per lane after the upgrade and diff against intent — this is the check that
  found `code` silently missing from Ferni's image on its first boot, and it turns your lane×env
  table from §3b of the validation brief into something verifiable. `unusable` heals live when a
  credential lands; `omitted` means fix config and restart.
- **`tool.rejected` events** (closed reason enum: `unknown` / `not_allowed` / `breaker_disabled`)
  are now in telemetry. Baseline your rejection rate per lane — 9.4% of one lane's calls were
  invisible before. This data decides the 0.2.16 auto-activate question, so it feeds directly
  back into your R7/A-3 ask.
- **`remember` refusals now carry exact headroom + merge base.** Expect `self_cap` breaker latches
  to drop to ~zero; if a lane still latches, that is a real finding, not the old blind-retry noise.
- **Boot prints one line** naming anything omitted or unusable. Your fleet roll should read each
  lane's first boot line — it is the fastest misconfiguration catch you have ever had.

## 4. What "better" should look like — expected signatures per tier

Same table as the validation brief, with the 0.2.15 deltas layered on:

| tier | config-track effects (your A/B) | 0.2.15 effects (the rerun) |
|---|---|---|
| simple | first-call cache hit up (TTL) | ~none — guard against regressions, expect noise-level deltas |
| medium | save-path refusals down (self cap) | self_cap latches → ~0; rejected-call counts now visible |
| hard | compactions/cost down (arg cap) | identifier survival UP (A-1 appendix); zero wrong-task pins (D-1); any budget-hit run returns its work (D-9) |

A falsified expectation is as valuable as a confirmed one — same standard as your last two
reports, which is what earned three of these twelve items their place.

## 5. The OpenAI path — what is now unblocked and the order to do it

D-12 was the prerequisite; it is live-proven. The sequence we agreed stands:

1. **Stabilize QS on 0.2.15 first** (the battery rerun above). This is the baseline everything
   OpenAI-side is judged against.
2. **Bench an OpenAI QS agent on a lab workspace** before any client-visible OpenAI workspace.
   Recommended demo env — metered API, NOT the codex sign-in backend (undocumented surface,
   the D-12 lesson):

   ```
   MODEL_API=responses
   MODEL_BASE_URL=https://api.openai.com/v1
   DELTA_MODEL_PRIMARY=gpt-5.6-sol
   OPENAI_API_KEY=<metered key>
   ```

   On this route `max_output_tokens` IS sent (the denylist is codex-host-only), children are
   capped normally, and pricing resolves via the `gpt-5` prefix. If you must demo the
   subscription backend instead, one doc note from the gate run: `MODEL_HEADERS` may not set
   `chatgpt-account-id` on a static-key lane — the refusal is correct and the backend does not
   need the header; remove it rather than debugging a config mistake that does not exist.
3. **Run the same three-tier battery against the OpenAI bench agent.** Expect differences we
   already know about (no Anthropic-style cache metadata; effort semantics differ) — capture
   them, because they are exactly the input for 0.2.16.
4. **Only then create the OpenAI workspace** on the stabilized configuration.

**What we build meanwhile (0.2.16, already specced):** first-class Responses-wire support and
per-provider controls (CachePlan/ModelControls), the cache-diagnosis pass-through, sticky
provider health, and — from this week's gate run — a telemetry surface for child provider
failures, which currently appear only in tool return values (the mechanism that let 24/24
child failures hide in clean-looking logs). Your OpenAI bench findings from step 3 land
directly in that batch, get released, and you test that specifically. That pipelining is the
whole plan: your lab time is the bottleneck, so each release arrives pre-verified on our side
and you only ever re-run the pinned battery.

## 6. What comes back to me

1. The 0.2.14 A/B verdict (your standing assignment — it decides the fleet config).
2. The 0.2.15 acceptance rerun, same report shape.
3. Post-upgrade: each lane's boot line + `/v1/status` tools diff, and your baseline
   `tool.rejected` rates.
4. The OpenAI bench battery findings (step 3 above) — these steer 0.2.16's cut.
5. Still open from before: the restVerb check result and the alpha-school env history (R3a).

— Delta Harness
