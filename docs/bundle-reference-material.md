<!-- SPDX-License-Identifier: Apache-2.0 -->

# Operator reference material: point at it, do not resident it

The convention promised to Aperture as answer #8, written 2026-08-08. It is the answer to "we need
a fifth bundle file", which four of their lanes had already worked around by shipping a pointer to
a file that did not exist.

## The rule

**A bundle is four files, and reference material is not one of them.**

`delta.env` · `vocab.json` · `DELTA.md` · `POLICY.md` (+ optional `PROMPT_CONTEXT.md`)

Anything an operator wants the agent to be able to *consult* - a style guide, a client brief, a
schema, a list of accounts, a runbook - goes in the **workspace as an ordinary file**, and the agent
reaches it with `read_file`. It does not go in the bundle, and there is no fifth file coming.

## Why, and it is not minimalism for its own sake

Every byte of the bundle is **resident in the system spine on every single turn**. That is the point
of the bundle: identity and contract have to be in front of the model always. Reference material
almost never does. A 20KB style guide in the spine is 20KB re-sent on turn 400 of a run that
consulted it once on turn 2, and - since 0.2.13 measured this directly - it sits in the one region
of the request where a change invalidates the entire cached prefix behind it.

The budgets enforce it: `DELTA_SELF_MAX_TOKENS` and `DELTA_POLICY_MAX_TOKENS` default to 800 tokens
each. A policy over budget **fails boot**, deliberately, because a fixed rule that gets silently
elided in the middle is worse than one that refuses to start. Those caps are not an obstacle to work
around; they are the statement that this material belongs elsewhere.

## How to do it

1. **Put the file in the workspace.** `client-brief.md`, `schema.json`, whatever. Sync it however
   you already deploy - an ssh sync, a volume mount, a git checkout at boot.
2. **Name it in `POLICY.md`, in one line.** Not its contents. Its path and when to read it:

   ```markdown
   ## Reference
   Client conventions live at `reference/client-brief.md`. Read it before drafting any
   client-facing artifact. Do not quote it back in full.
   ```

3. **Let the agent read it on demand.** One `read_file` call, once, when the task actually needs it.
   The result is bounded by `DELTA_TOOL_RESULT_MAX_BYTES` and spills to disk above that, so even a
   large document cannot blow the window.

## The failure this prevents

**A pointer to a file that is not there.** Four Aperture lanes shipped exactly that: `POLICY.md`
referenced a path the deploy never created. The agent read the instruction, tried the path, got an
error, and carried on without the material - silently, because a missing reference is not a boot
failure.

So: **the pointer and the file ship together, or neither ships.** If your deploy writes `POLICY.md`
from one source and the workspace from another, that is the seam where this breaks. A boot-time
existence check on the paths you reference is cheap insurance.

## When the four files genuinely are not enough

They have been so far. If you hit a case that this convention cannot express, that is a finding
worth sending us rather than a fifth file worth inventing - the last consumer who needed one turned
out to need this document instead.

Related: `hosting.md` for the lifecycle contract, `guide.md` for the bundle itself.
