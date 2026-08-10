# Spec: a capability the code enforces must not be describable any other way

Status: **specified, not built**. Written 2026-08-10 after fixing the same defect in four places,
and after finding it shipping in all three competitor harnesses.

## The defect

Sub-agent children have been read-only since 0.2.4. `childTools` (`research.ts:81-85`) admits a tool
only when `def.readonly === true`. For ten releases, four separate surfaces said otherwise:

| surface | what it claimed |
| --- | --- |
| the `research` tool description | children get "the SAME tools you have (read, write, search, code)" |
| `research.ts` file header | children can write, code, and `remember` |
| **`RESEARCH_ROLE`, the child's own prompt** | **instructed the child to write files** |
| `site/public/guide.md` | said it publicly |

The third is the one that matters. A parent told its children can write plans around a write that
fail-closes. A child told to write attempts a tool that is not in its map. **A stale doc corrupts an
agent's procedure, not just a human's reading**, and unlike a human the agent cannot notice the
contradiction and go look at the source.

All four were fixed on 2026-08-10. Nothing stops the fifth.

## This is not a discipline problem

Every competitor harness read on 2026-08-10 has the same defect **shipping today**:

- **OpenClaw** hard-denies `agents_list` to every subagent and **names it in the child's prompt**
  (`subagent-system-prompt.ts:84` vs `agent-tools.policy.ts:51`). Their own `AGENTS.md:152` states
  the law: *"Tool/prompt descriptions never statically name tools from other toolsets; gating turns
  the reference into hallucination bait."* They implement it correctly for the main prompt. The
  mechanism never reached the subagent prompt.
- **Hermes** documents 5 blocked tools while enforcement removes 6 (`kanban`, hardcoded in two
  enforcement sites, absent from both the constant and the prose). Their nearest test asserts
  keyword presence for 2 of 5 and its docstring says it is deliberately loose.
- **Pi** generates the child's tool list from the enforced array, which is the right idea, but only
  for the child's own prompt. `formatAgentList()`, the one utility that would carry capability data
  into the parent's description, is **dead code, never called**.

Three independent teams, three instances of the same drift, one of them with the rule written down
and partially implemented. Prose that restates an enforced rule will drift. The only fix is to stop
having prose that restates it.

## The design

Three mechanisms, cheapest first. Each is independently useful; together they close the class.

### 1. Make the capability decision unskippable at compile time

`ToolDef.readonly` is optional today (`tools.ts:124`, `readonly?: boolean`). A new tool that never
mentions it is excluded from children, which is the safe default but also a **silent** one: the
author was never asked.

Make it required. Every tool definition then states its capability class explicitly, and adding a
tool without deciding **fails `tsc`**. This is our version of OpenClaw's
`satisfies Record<Union, string>`, which was the only genuinely un-driftable mechanism found in any
of the three repos, and it is stronger because it fails the build rather than a test.

Scope check: `ToolDef` is engine-internal. MCP-sourced tools are wrapped by us, so the default is
applied at one place, not at every call site.

### 2. Generate the capability sentence; never write it

The `research` tool description and `RESEARCH_ROLE` must not contain a hand-written sentence about
what children can do. Both take the clause from one exported builder that derives it from
`childTools(universe)` — the same function that enforces admission.

The parent's description and the child's prompt then say what the filter actually did, on this
binary, with this tool universe. A future tool flipping `readonly` updates both without anyone
remembering to.

### 3. A bidirectional set assertion, not a keyword check

The test both Hermes and Pi got wrong by writing it one-directional:

```
for every tool in the parent universe:
  admitted = childTools(universe).has(name)
  named    = renderedChildCapabilityText().includes(name)
  assert admitted === named
```

Both directions are load-bearing. "Every admitted tool is named" catches a capability we gained and
never documented. "No unadmitted tool is named" catches Hermes' and OpenClaw's exact bug, a denied
tool still advertised. A keyword spot-check catches neither reliably, which is why theirs did not.

## Scope, and what stays unlocked

**Locked:** the `research` tool description, `RESEARCH_ROLE`, and any future surface that renders
the capability clause through the builder.

**Not locked:** `site/public/guide.md`. It is hand-authored prose on a separate deploy cadence and
locking it would mean generating documentation prose from source, which is a larger project than
this release. The mitigation is procedural and already recorded: the release ceremony regenerates
and redeploys the guide with the tag, after `guide.md`'s `/healthz` example was found **nine
releases stale** on 2026-08-10.

Stating this plainly rather than implying full coverage: **the site can still drift.** The engine,
the tool description, and the child's own prompt cannot.

## Why the child's prompt is the one that must not drift

The four surfaces are not equally dangerous, and a reviewer should weight them accordingly:

- A wrong **tool description** costs the parent a bad plan, which it usually recovers from when the
  child returns.
- A wrong **file header** costs a future maintainer an hour.
- A wrong **site doc** costs a reader trust, and costs an agent that reads its own docs a wrong
  procedure.
- A wrong **child role prompt** is the only one that instructs a running agent to attempt something
  the engine will refuse, every time, with no path to noticing. It is a fail-closed loop with a
  confident actor inside it.

If only one mechanism ships, ship the generated clause for `RESEARCH_ROLE`.
