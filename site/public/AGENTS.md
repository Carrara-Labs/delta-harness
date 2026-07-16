---
title: Delta integration brief for coding agents
canonical: https://deltaharness.dev/agent.md
last_updated: 2026-07-15
---

# Integrate Delta Agent Harness

You are helping a developer add Delta to an existing product or repository. Delta is a lean runtime for durable knowledge work: one model loop with a workspace, tools, memory, delegation, human review hooks, tracked-usage budgets, durable execution, and production visibility.

## Work from authoritative context

- Documentation index: https://deltaharness.dev/llms.txt
- Canonical technical guide: https://deltaharness.dev/guide.md
- Full documentation corpus: https://deltaharness.dev/llms-full.txt
- Human-readable documentation: https://deltaharness.dev/docs/

Read only the guide sections needed for the task. Prefer retrieval from these sources over assumptions from prior model knowledge. Do not invent package names, commands, configuration keys, or API behavior.

## Choose the integration shape first

Delta can power either:

1. An agentic assistant that users address directly and that owns an ongoing workspace and memory.
2. An agentic feature inside an existing workflow, where the host product owns the UI and calls Delta through its CLI or HTTP API.

Inspect the repository and the user's request before choosing. Preserve the host application's architecture, conventions, authentication, and deployment model.

## Current source-checkout workflow

Delta is not yet published as a package. Until release documentation says otherwise, use the source checkout workflow and do not guess an npm package name or installer command.

```sh
bun install --frozen-lockfile
bun run build
./dist/delta init ./my-agent
```

An agent bundle contains five files:

- `DELTA.md`: durable identity, mission, success criteria, and learned guidance.
- `POLICY.md`: approval and tool-use policy.
- `PROMPT_CONTEXT.md`: dynamic or generated operating context.
- `vocab.json`: product vocabulary and capability hints.
- `delta.env`: local configuration and secrets for development only.

Delta keeps runtime state in the workspace and SQLite. Keep the agent ID stable, never commit credentials, and ignore the local `delta.env` and `.delta/` state directory.

## Implementation rules

1. State which integration shape you selected and why.
2. Make the smallest change that satisfies the user's task.
3. Treat the five-file bundle as code: keep identity, policy, context, vocabulary, and local configuration in their intended files.
4. Keep secrets out of source control and avoid exposing a local daemon publicly without the documented control and inspection protections.
5. Verify the engine with its tests and verify the particular agent with one repeatable acceptance task.
6. Report assumptions, changed files, commands run, and any remaining production work.

Now inspect the repository and the user's request, retrieve the relevant Delta guide sections, propose a short plan, and implement only after the intended integration shape is clear.
