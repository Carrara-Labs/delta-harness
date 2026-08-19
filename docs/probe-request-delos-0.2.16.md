# To the Delos engineer: six wire probes on the codex backend (0.2.16)

2026-08-19, from the Delta Harness maintainer. Same drill as the D-12 gate run, same two-curl
pattern you already have: identical bodies ± ONE field, against `chatgpt.com/backend-api/codex`
with a broker-minted token. Everything below is already live-proven **200 on `api.openai.com`**
(fixtures captured on the metered test key); the subscription surface is the only unknown, and
per the D-12 rule every one of these ships **default-DENIED** on your host until your probe
flips it. Nothing here blocks your lane — 0.2.16 changes what `chatgpt.com` receives in exactly
zero ways until these predicates flip.

Record per probe: HTTP status, and on a 400 the `error.message` verbatim.

| # | field under probe | body delta (± the field) | flips which predicate |
|---|---|---|---|
| P1 | `include: ["reasoning.encrypted_content"]` | top-level | `acceptsReasoningReplay` (with P2+P3) |
| P2 | a `reasoning` item replayed in `input` (verbatim from a prior response's output, `encrypted_content` and all) | input item | `acceptsReasoningReplay` |
| P3 | `phase` on an assistant message input item (replay a message item verbatim) | input item field | `acceptsReasoningReplay` |
| P4 | `text: {"verbosity": "low"}` | top-level | `acceptsResponsesTuning` |
| P5 | `reasoning: {"effort": "low", "summary": "auto"}` (the summary key is the probe; effort is already proven) | nested field | `acceptsResponsesTuning` |
| P6 | `prompt_cache_breakpoint: {"mode": "explicit"}` on a user `input_text` block | content-block field | `acceptsCacheBreakpoints` |

Probe notes:

- P1–P3 are one family: capture needs P1, replay needs P2+P3. If P1 200s but items come back
  WITHOUT `encrypted_content`, say so — capture-without-payload is a husk and we keep the deny.
- For P2, generate the reasoning item on the SAME backend first (a P1 probe response), then
  replay it — encrypted payloads are almost certainly not portable across backends, and a
  cross-backend replay 400 would tell us nothing.
- P6 composes with `prompt_cache_key`, which your backend already receives — keep it in both
  arms. The backend auto-caches, so also note whether a 200 changes anything visible in usage
  (`input_tokens_details.cache_write_tokens` appearing would be a real signal).
- All probes: `store: false` (required on your backend anyway), streamed or not — your choice;
  the field acceptance is what's under test.

## What happens with the results

Each 200 flips its predicate from `!hostMatches(baseUrl, ["chatgpt.com"])` to unconditional (or
per-family, if results split) in one line + one test each; each 400 gets the error message
recorded next to D-12's in `docs/spec-responses-first-class.md` §6 and the predicate stays. If
P1–P3 all pass, your lane gets the same reasoning-carry quality fix the metered lane ships with
— on `gpt-5.x` models the vendor-documented effect is better tool-chain coherence and no
intermediate-update-as-final-answer confusions.

Still open from the gate run, unchanged: the fixture DB (1.3MB gz — send whenever, it validates
the D-1/D-9 tests) and `DELTA_MODEL_PRICES` for your lane (D-6 stays open until it lands).

— Delta Harness
