# Delta Agent Harness

Delta is a lean runtime for building production agents that do durable knowledge work. It gives one model call a workspace, tools, memory, delegation, human review hooks, tracked-usage budgets, durable execution, and production visibility without turning the harness into a framework.

> This is the canonical Delta guide. It is self-contained and written for both humans and language models. Start with the quickstart, then use the later sections as the exact operating reference.

Choose a path:

- [Create and test a local agent](#start-here)
- [Build an agentic assistant or AI feature](#two-ways-to-build)
- [Give a coding agent the right Delta context](#use-delta-with-coding-agents)
- [Integrate through the CLI or HTTP API](#run-and-call-the-agent)
- [Understand tools, MCP, memory, and review](#built-in-capabilities)
- [Deploy and operate in production](#deploy-delta)
- [Look up every setting](#configuration-reference)

This guide describes the source checkout that contains it. A running daemon reports its harness version at `/healthz`. Delta reads `DELTA_BUILD` at runtime. The Docker build argument persists it into the image environment; a direct binary deployment must export it when starting the daemon.

A Delta agent is three things:

1. **Engine:** the compiled `delta` binary. It owns the model loop, tool execution, persistence, budgets, events, and HTTP API.
2. **Bundle:** five small files that define one agent. They hold its identity, policy, dynamic context, product vocabulary, and local configuration.
3. **State:** the workspace plus a SQLite database. They hold files, conversations, checkpoints, memory, events, and self-file revisions.

Delta is designed for work that crosses files, tools, systems, and people. It is not limited to a source repository. When a task genuinely needs advanced coding, Delta can delegate that part to an installed Codex, Claude Code, or other command-line coding agent.

## Start here

### Prerequisites

- Bun 1.3 or newer
- A model credential, such as an OpenRouter, Anthropic, or OpenAI API key
- Optional: an Exa key for built-in web search
- Optional: an installed coding CLI for the `code` tool
- Optional: the host `grep` command for the `grep` tool
- Optional: the host `unzip` command for lightweight DOCX and XLSX extraction

Repository access and an existing checkout are prerequisites until Delta is published. All commands in this guide run from that repository root unless stated otherwise.

### Build the binary

```sh
bun install --frozen-lockfile
bun run build
```

The build creates `dist/delta`, a Bun-independent executable for the current operating system and architecture. Build on the target platform, or use the Docker build for Linux. Optional built-ins can still call external `grep`, `unzip`, and coding CLI executables. During repository development, run the test suite with:

```sh
bun test
```

### Create an agent

```sh
./dist/delta init ./my-agent
```

`delta init` attempts to create these five scaffold files with exclusive writes:

```text
my-agent/
├── delta.env
├── vocab.json
├── DELTA.md
├── POLICY.md
└── PROMPT_CONTEXT.md
```

It never overwrites an existing path. In a partially scaffolded directory it creates only the missing files. A permissions, disk, or path failure can leave a partial scaffold and returns a nonzero exit status; rerun after fixing the error to fill the remaining files.

Set a model credential and a stable agent ID in `my-agent/delta.env`:

```dotenv
OPENROUTER_API_KEY=your-key
DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5
DELTA_AGENT_ID=my-research-agent
```

The agent ID must remain stable for the life of the agent. Local memory is scoped by it. `delta.env` is a local-development convenience inside the agent workspace, and file tools can read workspace files. Use a restricted development key, never commit this file, and keep production secrets in the process environment or a secret manager. Add at least these paths to the repository ignore rules:

```gitignore
my-agent/delta.env
my-agent/.delta/
```

Give the agent a concrete identity in `my-agent/DELTA.md`:

```md
# Persona

You are Meridian, a research operator for the product team.

# Mission

Turn ambiguous market questions into sourced, decision-ready briefs.

# Success

The reader can make a decision without repeating the research.

# Learned

Keep recommendations explicit and separate evidence from inference.
```

`POLICY.md` can remain as generated for the first run. Its comment-only starter causes Delta to use the embedded review policy when a reviewed-write MCP tool is present.

### Launch the agent and Cockpit

```sh
./dist/delta dev ./my-agent --port 8080
```

With the generated configuration, the launcher:

- reads `my-agent/delta.env`
- uses `my-agent` as the workspace, unless `delta.env` sets `DELTA_WORKSPACE`
- stores local state in `my-agent/.delta/delta.db`, unless `delta.env` sets `DELTA_DB`
- defaults the daemon bind to `127.0.0.1`
- defaults local Cockpit editing and normalized model-call capture to on
- opens `http://localhost:8080/dev`

`delta.env` overlays the launcher's inherited environment. `DELTA_BIND`, `DELTA_INSPECT_WRITE`, and `DELTA_CAPTURE_CALLS` from that merged environment override their development defaults. `--port`, or the automatically selected free port, always replaces `PORT`. For workspace and database paths, only values in `delta.env` override the launcher defaults; inherited `DELTA_WORKSPACE` and `DELTA_DB` values are ignored. Relative overrides resolve from the bundle directory.

Do not set a public `DELTA_BIND` for local development unless `DELTA_CONTROL_TOKEN` and a deliberate inspection policy are also configured. Otherwise the run API can become reachable beyond the local machine. The bundled browser UI does not attach those tokens, so a token-protected local Cockpit also needs an authorization-injecting proxy.

Omit `--port 8080` to let Delta select a free port. Keep the browser closed when needed:

```sh
./dist/delta dev ./my-agent --port 8080 --no-open
```

The terminal prints the selected port. `delta dev` runs the ordinary production daemon as a child, so the execution behavior is the same as a directly launched Delta.

### Send the first task

In another terminal:

```sh
./dist/delta send --port 8080 "Using only DELTA.md and POLICY.md, create brief.md with the agent mission, success criteria, risks, and next steps."
```

The default `delta send` path creates an asynchronous task, then prints the run's dev event stream as JSON Lines until it finishes. It needs the control credential to create the task and the inspection credential to read that stream when those gates are enabled. For only the final text:

```sh
./dist/delta send --port 8080 --json "Read brief.md and summarize it in five bullets."
```

The `--json` name is historical. This mode makes a synchronous request and prints only `output_text`; it needs only the control credential. `delta send` and `delta watch` read credentials from their own process environment and do not load the bundle's `delta.env`.

At this point the agent is real: it can reason across multiple model turns, use files and tools, persist every checkpoint, continue a conversation, and be inspected in the Cockpit.

### Develop and acceptance-test the agent

Treat the five-file bundle as code and keep one fixed acceptance task for the agent:

1. Start Delta on a pinned port and send the task without `previous_response_id`, which creates a fresh session.
2. In Cockpit, inspect the run timeline, model calls, selected tools, tool arguments, results, usage, and final answer.
3. Verify the expected workspace artifact, budget behavior, policy behavior, and a deliberate failure case such as a missing input file.
4. Edit the smallest relevant bundle file. `DELTA.md` takes effect on the next run; policy, vocabulary, all prompt context, MCP, and provider changes require a daemon restart.
5. Run the identical task in another fresh session and compare the artifact, tool choices, cost, and call trace.
6. Before release, repeat the task through the authenticated production API and inspect the production run with the separate inspection credential.

`bun test` verifies the Delta engine. This repeatable task verifies the particular agent bundle and its connected systems.

## Use Delta with coding agents

The documentation exposes three layers so Claude Code, Cursor, Codex, and similar tools can receive only the context they need:

1. **Immediate handoff:** use **Copy agent context** from the documentation header menu, then paste it into the coding agent with your task. The copied brief explains Delta's integration shapes, current source-checkout workflow, bundle contract, safety rules, and authoritative URLs.
2. **Focused retrieval:** point an agent to [`/llms.txt`](/llms.txt) for a concise index, [`/guide.md`](/guide.md) for the canonical guide, or [`/llms-full.txt`](/llms-full.txt) when a tool explicitly needs the complete corpus.
3. **Persistent project context:** place a short, relevant Delta section in the target repository's root `AGENTS.md`, or install the official Delta Skill when package distribution is available. A hosted `AGENTS.md` is a source to copy from; coding agents only load it automatically after it is present in the repository they are working in.

The header's **Copy .md** action copies the complete current guide. Use that for a full page handoff. Prefer the smaller agent context for routine implementation work so the coding agent can retrieve only the relevant guide sections instead of carrying the entire manual in every turn.

Until Delta's package release is documented, the brief deliberately uses the source-checkout commands in this guide and tells agents not to invent a package name. The planned package should ship version-matched agent context, a portable `SKILL.md`, and a small installer that can add or update a bounded Delta section in the target repository's `AGENTS.md`. MCP is only necessary later if agents need live registry search or operational actions; static product knowledge does not require it.

## Mental model

### What one run does

Every request follows the same durable loop:

```text
request
  -> durable queue row
  -> load identity, policy, context, memory, and relevant capabilities
  -> model call
  -> zero or more parallel tool calls
  -> checkpoint messages, usage, tool intents, and active tools
  -> repeat until final text, cancellation, budget exhaustion, or failure
  -> on a handled outcome, durable response and run.finished event
  -> optional background reflection
```

A run may last for seconds or hours. Delta has no overall wall-clock limit. Its loop stops on successful-main-model-call, recorded fresh-token, and recorded model-cost budgets. Individual model and ordinary tool calls have separate timeouts, with the exceptions documented under built-in capabilities.

### The prompt spine

Delta rebuilds a small, ordered system spine for every model turn:

1. Delta's base behavior and operating norms
2. boot-stable rendered context
3. `DELTA.md`, read once at the start of the current execution attempt
4. `POLICY.md`, rendered as the last instruction layer
5. an index of currently resident tool names and descriptions

The full JSON tool schemas are sent separately in the provider request's `tools` field. Conversation history follows the system spine. Per-turn context, request instructions, and retrieved capabilities are appended as user-role blocks. This matters because request-scoped text can specialize a task, but it does not become system policy.

The stable prefix is deliberately cache-friendly. Volatile values such as time and request metadata stay outside it. `{{model}}` is the configured primary on the first turn and the model that served the previous successful turn after that, so it cannot predict a fallback that will serve the call currently being assembled.

### Sessions and runs

One API response ID identifies one run. Passing that ID as `previous_response_id` appends another run to the same session and preserves the full current conversation. It is a session lookup, not a branch pointer: passing an older response ID does not fork or rewind the conversation, so pass the latest response ID. Runs in one session execute serially. The shipped daemon executes up to four different sessions concurrently.

Do not invent or reuse an unknown response ID. Delta returns `400` instead of silently starting a new session.

## Two ways to build

Delta is one runtime, but products put it to work in two shapes. Both are the same agent with the same primitives — threads for context, tools for reach, and review-driven reflection for learning. They differ only in who opens the thread and where the human gives feedback.

- **An agentic assistant.** A person chats with the agent. Each topic or task is its own thread; the agent uses tools and permissioned app access to do real work, and gets better from how its proposals are received.
- **An agentic feature.** A product turns a one-shot LLM call — "generate a job description," "draft the outreach," "summarize the deal" — into an agent that iterates to a reviewable deliverable and improves across generations. The feature is a pre-seeded thread: the same agent, opened by the product with task context instead of by a person with a chat message.

The rest of this guide is the reference for every primitive named here. This section shows how they compose into each shape.

### A thread is the unit of context

A thread is a Delta session (see [Sessions and runs](#sessions-and-runs)). Open one with a first `POST /v1/responses`; continue or switch by passing that thread's latest response ID as `previous_response_id`. Everything that makes a long task survivable — compaction, `recall`, the working plan — is scoped to the thread, so two threads never bleed into each other. A person managing several threads, or a product running one thread per job, gets clean isolation without extra work. Your product owns the list of threads and their titles; Delta owns each thread's execution and memory.

### Learning spans threads; context does not

The isolation above is deliberate, and it is only half the design. The learning rail is the other half, and it runs the opposite way: a lesson distilled in one thread becomes available to every later thread of the same kind. Tag related work with a caller-declared `task_type` (see [Request fields](#request-fields)) — `jd-generation`, `weekly-report` — and reflection tiers what it learns to that use case. Generation fifty opens a fresh, isolated context but recalls what generations one through forty-nine taught the agent about the job. Isolation where you want a clean slate; memory where you want compounding.

### Use case 1: an agentic assistant

Give a person a chat surface backed by one agent.

- **Threads for context.** One thread per topic or task; the user switches between them and each keeps its own working context.
- **Tools and permissioned app access.** Connect the agent to your systems over [MCP](#connect-mcp-tools) — retrieve contacts, read a CRM, draft in a document store — under whatever scopes your gateway enforces. Delta calls the tools; your product owns identity and permission.
- **Self-improvement from review.** When the agent proposes work and a human accepts, edits, or rejects it, that verdict becomes a learning signal (see [Learn from human review](#learn-from-human-review)). The agent's `DELTA.md` and scoped memory improve without a prompt change.

### Use case 2: an agentic feature

Turn a static feature into an agent that does the whole job and learns from every correction. The mechanism is the same review loop, opened by your product instead of by a person. Job-description generation, end to end:

1. **Open a thread per job.** `POST /v1/responses` with no `previous_response_id`, seeded with the source material and tagged with the feature's `task_type`:

   ```json
   {
     "input": "Draft a JD and specs for the Staff PM role. Hiring-manager transcript: ... Recruiter transcript: ...",
     "metadata": { "task_type": "jd-generation", "user_id": "acme" }
   }
   ```

2. **Let it work and iterate.** The agent pulls context, drafts, and proposes; continue the thread with `previous_response_id` as the hiring manager reacts. This job's transcripts and drafts stay in this thread.

3. **Propose, do not just answer.** Delta's write rail bundles the deliverable into one proposal a human reviews (see [`POLICY.md`](#policymd-fixed-operator-rules) and [Learn from human review](#learn-from-human-review)), stamped back to the run.

4. **Feed the verdict back.** When the reviewer accepts with edits, your control plane sends the disposition into the same thread as a new run:

   ```json
   {
     "input": "Review outcome: accepted with edits. Proposed: ... Accepted: ... Reviewer note: lead with scope, cut adjectives.",
     "metadata": { "review_kind": "submission_disposition", "submission_id": "sub_123", "reflect": true }
   }
   ```

5. **It learns from the diff, and the next job starts smarter.** Reflection grounds the lesson in the gap between what was proposed and what was accepted, tiers it to `jd-generation`, and the next job's thread recalls it at open.

### What Delta owns and what you own

Delta owns the loop, threads, context management, reflection, and the memory tiers. Your product — or a control plane — owns opening and titling threads, the review surface, and, critically, authenticating the disposition and constructing the real proposed-versus-accepted digest. Delta trusts that digest; it does not verify the reviewer, so the trusted plane must be the one asserting that a human reviewed the work.

The learning loop ships wired to a submission-and-review model: an agent that proposes through the review inbox and is reviewed there gets the propose-review-learn cycle today. A feature on a different product surface reuses every harness primitive but supplies its own equivalent of that disposition digest and sender.

## Configure the five-file bundle

### `delta.env`: local launch configuration

`delta dev` parses this file as trimmed `KEY=value` pairs. Blank lines and full lines beginning with `#` are ignored. One matching pair of outer single or double quotes is removed. It is not a shell parser: `export`, variable expansion, escape processing, and inline-comment removal are not supported, and malformed lines are silently skipped.

The direct daemon does not automatically load `delta.env`. In production, pass the same settings as real environment variables. The container entrypoint can seed the four non-secret bundle files, but never `delta.env`.

Keep credentials out of version control. A useful local file starts small:

```dotenv
OPENROUTER_API_KEY=your-key
DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5
DELTA_AGENT_ID=my-research-agent

# Optional built-in web search
EXA_API_KEY=your-exa-key

# Optional post-run learning
DELTA_REFLECT=1
```

### `DELTA.md`: identity and writable self-memory

`DELTA.md` is the agent's compact, durable self-file. The generated structure is:

```md
# Persona

Who the agent is and who it serves.

# Mission

The standing goal it exists to advance.

# Success

The concrete outcome that defines good work.

# Learned

Durable lessons worth carrying into every future run.
```

The file is human-editable and agent-editable. The model can replace it through the `remember` tool. A content-changing overwrite is atomic and size-capped. When prior content exists, Delta records it in SQLite before retaining the newest 20 previous revisions. The first write and a same-content write do not create a revision. The Cockpit can compare and restore recorded revisions. The filesystem rename happens just before the database snapshot, so a process crash in that narrow interval can leave the new file in place without a revision for the immediately prior content.

Important behavior:

- Delta reads one snapshot of `DELTA.md` for each execution attempt. An uninterrupted run keeps that snapshot. A run resumed after a daemon restart loads the current file again.
- A change made during uninterrupted execution becomes visible to the next fresh or restarted execution attempt, not the current in-memory attempt.
- The default budget is about 800 tokens, implemented as a 3,200-byte write ceiling.
- A file above the prompt budget but no larger than 1 MB is head-and-tail elided as a recovery behavior. A file above 1 MB loads as empty, and an oversized self-write is rejected by its byte cap.
- The agent must write the complete replacement file, not only a new lesson.

Keep this file lean. Every future model call includes it.

### `POLICY.md`: fixed operator rules

`POLICY.md` is the fixed, highest-priority prompt guidance for a daemon process. It is loaded once when the daemon starts, placed after writable identity as the last instruction layer before the tool index, and cannot be changed by the normal root-file tools or `remember`.

Use it for rules such as:

```md
# Policy

- Never send an external message without human approval.
- Cite the source for every material factual claim.
- Stop and ask when an action could spend more than $500.
```

Important behavior:

- A missing, unreadable, heading-only, or comment-only file uses Delta's embedded reviewed-write policy when a compatible write rail exists.
- A real custom policy replaces that embedded policy.
- The default policy budget is about 800 tokens.
- Delta refuses to boot when a custom policy exceeds the budget. Fixed rules are never silently truncated.
- An edit on disk requires a daemon restart.

Human review is policy plus tools, not a built-in approval server. Delta's embedded policy recognizes an MCP tool whose name ends with the configured reviewed-write suffix, such as `propose_change`. It tells the agent to bundle work into one human-reviewable proposal. The actual queue, approval UI, and side effect belong to the connected product.

Prompt guidance is not an authorization boundary. Delta does not evaluate `POLICY.md` before each tool call. MCP services, the trusted gateway, and any approval product must enforce permissions and block unapproved side effects even when the model ignores or misinterprets the prompt.

### `PROMPT_CONTEXT.md`: stable and live context

This optional file has two sections:

```md
## Stable
Engine {{engine.version}} | agent {{agent.id}} | profile {{profile}}

## Turn
Model {{model}} | date {{now.date}} | timezone {{now.tz}}
Requester city: {{request.city}}
```

`## Stable` is rendered once at boot and joins the cached prefix. It can use:

- `{{engine.version}}`
- `{{agent.id}}`
- `{{profile}}`

`## Turn` is rendered for every model turn. It can use:

- `{{model}}`
- `{{now.iso}}`
- `{{now.date}}`
- `{{now.tz}}`
- `{{request.<key>}}` from `metadata.context`

Both section templates are loaded at daemon boot. The turn block is re-rendered from that boot-loaded template, so editing either section requires restart.

Example request:

```json
{
  "input": "Prepare the regional launch note.",
  "metadata": {
    "context": {
      "city": "Paris",
      "country": "FR"
    }
  }
}
```

Request context is treated as bounded data. Delta accepts at most 24 safe keys, reduces each value to one line of at most 200 characters, and leaves unknown placeholders visible. The source file is ignored if it exceeds 100 KB. Rendered stable and turn blocks are capped at 2,000 and 4,000 characters respectively.

### `vocab.json`: product bindings

The vocabulary file lets the same engine fit a product without compiling product names into the runtime. It controls:

- which MCP verb suffixes are pinned in the lean core
- which tool suffix is the reviewed-write rail
- the nouns used by the embedded review policy
- which request metadata keys identify a hydration subject
- how a learned artifact maps into the product's write-tool arguments
- the default local memory namespace

The generated neutral vocabulary is enough for a plain agent. A product-specific example is:

```json
{
  "coreVerbs": ["get_dashboard", "list_open_work", "propose_change"],
  "writeVerbSuffix": "propose_change",
  "writeNoun": "workspace",
  "runRefKey": "run_ref",
  "learningTargetKind": "note",
  "taskNoun": "task",
  "itemNoun": "review item",
  "subjectKeys": ["account"],
  "writeShape": {
    "summary": "{{summary}}",
    "details": "{{brief}}",
    "provenance": {
      "key": "{{run_ref_key}}",
      "value": "{{run_id}}"
    },
    "items": [
      {
        "kind": "{{target_kind}}",
        "source_kind": "{{kind}}",
        "content": "{{content}}",
        "confidence": "{{confidence}}"
      }
    ]
  }
}
```

MCP tools are named `<server>__<tool>`. A core verb matches the suffix after `__`. For example, `crm__get_dashboard` matches `get_dashboard`.

`writeVerbSuffix` is resolved with the first insertion-order tool whose full name ends with that text. It must identify exactly one connected tool. If two servers expose `propose_change`, use a more specific suffix such as `crm__propose_change`; otherwise policy rendering and learned-write promotion can bind to the wrong server.

`writeShape` is the exact argument object sent to the tool whose name ends in `writeVerbSuffix` when Delta promotes a fact, preference, or pitfall. It replaces the built-in envelope completely; it is not merged with it. Delta recursively resolves these placeholders:

| Placeholder | Value |
|---|---|
| `{{run_id}}` | Producing run ID. |
| `{{kind}}` | Learned artifact kind. |
| `{{content}}` | Distilled learning text. |
| `{{confidence}}` | Numeric confidence when available. |
| `{{target_kind}}` | `learningTargetKind` from the vocabulary. |
| `{{summary}}` | Generated one-line reflection summary. |
| `{{brief}}` | Generated reflection details and provenance. |
| `{{run_ref_key}}` | The configured `runRefKey` name. |

A string leaf that is exactly one placeholder keeps the value's type. If that value is unavailable, Delta removes the object key or array item. Placeholders inside a longer string are converted to text, and unavailable values become an empty string.

Without `writeShape`, Delta sends this logical envelope:

```json
{
  "summary": "Reflection (<kind>) from run <run-id>",
  "details": "Post-task or post-review reflection details",
  "<runRefKey>": "<run-id>",
  "items": [
    {
      "kind": "<learningTargetKind>",
      "content": "<learning text>",
      "confidence": 0.8
    }
  ]
}
```

The `confidence` key is omitted when no numeric value exists. The custom shape must be a JSON object at its root.

`DELTA_VOCAB` can supply the same JSON as an environment variable and takes precedence over `vocab.json`. Malformed vocabulary falls back to neutral defaults. If the wording of `writeNoun` changes, the derived memory namespace also changes. Set `DELTA_MEMORY_NAMESPACE` explicitly when changing only the wording.

## Choose a model provider

Delta has no model SDK dependency. It supports three wire formats:

- OpenAI-compatible Chat Completions, used by OpenRouter and many other gateways
- native Anthropic Messages
- OpenAI Responses

### OpenRouter

OpenRouter is the default endpoint and requires the least configuration:

```dotenv
OPENROUTER_API_KEY=your-key
DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5
```

`MODEL_API_KEY` can be used instead of `OPENROUTER_API_KEY`. Set `DELTA_MODEL_FALLBACKS` to a comma-separated model list to try additional models on the same provider:

```dotenv
DELTA_MODEL_FALLBACKS=openai/gpt-5.5,google/gemini-3.5-flash
```

Primary credential precedence is `MODEL_API_KEY`, then `OPENROUTER_API_KEY`. A defined but empty `MODEL_API_KEY` suppresses the fallback key. The fallback key name is not endpoint-aware, so set `MODEL_API_KEY` explicitly whenever `MODEL_BASE_URL` is not OpenRouter. Delta does not validate a usable credential at boot or in `/healthz`; the first model call exposes a bad route or key.

### Anthropic directly

Use the base URL without `/messages` because Delta appends that path:

```dotenv
MODEL_BASE_URL=https://api.anthropic.com/v1
MODEL_API=anthropic
MODEL_API_KEY=your-anthropic-key
DELTA_MODEL_PRIMARY=claude-sonnet-5
```

Delta sends native Messages requests and uses Anthropic prompt-cache breakpoints on the system prefix and recent user or tool blocks.

### OpenAI directly

For the Responses API:

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API=responses
MODEL_API_KEY=your-openai-key
DELTA_MODEL_PRIMARY=gpt-5
```

For an OpenAI-compatible Chat Completions endpoint, omit `MODEL_API`. Delta appends `/chat/completions` to `MODEL_BASE_URL`.

Model IDs pass through unchanged. `DELTA_MODEL_FALLBACKS` shares the primary base URL, wire, headers, and credential, so every ID in that list must be valid on that endpoint.

### Provider and model failover

There are two levels of failover:

1. `DELTA_MODEL_FALLBACKS` tries more model IDs on the primary endpoint.
2. `DELTA_PROVIDERS` adds endpoints after the primary provider.

Example:

```dotenv
BACKUP_OPENAI_KEY=your-key
DELTA_PROVIDERS=[{"label":"openai","baseUrl":"https://api.openai.com/v1","api":"responses","models":["gpt-5"],"apiKeyEnv":"BACKUP_OPENAI_KEY"}]
```

Inside one provider, a retriable failure gets two retries by default, for up to three wire attempts per model, then advances to the next model. A non-retriable client `4xx` skips retries but still advances to the next model on that provider. Credential-wide `401`, `403`, broker `409`, and shared-subscription `429` errors skip the remaining models. After the provider's model list is exhausted, network errors, `401`, `403`, `409`, `429`, and `5xx` errors can advance to the next provider; a normal client `4xx` and an exhausted HTTP `408` do not. Failed attempts do not increment the run's step count and usually have no usage to charge. The timeout applies per wire attempt, so retries and fallbacks can make one model turn last longer than `DELTA_MODEL_TIMEOUT_MS`.

Once answer text has started streaming, Delta does not retry or switch providers and concatenate a second answer.

Each `DELTA_PROVIDERS` entry supports `baseUrl`, `models`, `api`, `label`, `apiKey`, `apiKeyEnv`, `brokerMintUrl`, and `brokerAuthEnv`. `baseUrl` is required. `models` may be one string or an array and otherwise reuses the primary model list. Only `anthropic` and `responses` are recognized as `api`; every other value selects compatible Chat Completions. An inline `apiKey`, including an empty string, wins over `apiKeyEnv`. Fallback entries cannot configure static headers and do not inherit `MODEL_HEADERS`. Invalid JSON is logged and the whole fallback list is ignored. Entries must be JSON objects; a `null` entry currently aborts configuration loading.

`MODEL_HEADERS` accepts a JSON object of extra static headers for the primary provider only. Authentication, account, protocol, cookie, and hop-by-hop headers are reserved and rejected at boot.

### Codex subscription access

Delta has two distinct Codex paths:

1. **Delegated coding:** the built-in `code` tool runs an installed Codex CLI. The CLI uses its own credentials from the process user's home directory.
2. **Primary model access:** Delta can call an OpenAI Responses-compatible Codex backend with a short-lived bearer minted by a trusted broker.

The primary-model subscription path is an infrastructure integration, not a standalone login flow. A complete deployment commonly uses:

```dotenv
MODEL_API=responses
MODEL_BASE_URL=https://chatgpt.com/backend-api/codex
DELTA_MODEL_PRIMARY=<Codex model ID accepted by this backend>
DELTA_BROKER_TOKEN_URL=https://control.example/api/broker/openai-token
DELTA_BROKER_AUTH=machine-gateway-token
MODEL_HEADERS={"originator":"codex_cli_rs"}
```

The harness requires the Responses wire, an endpoint-native model ID, an allowed backend host, and a usable broker response. `DELTA_BROKER_AUTH` and `MODEL_HEADERS` are optional to Delta but may be required by the deployed broker or backend.

Delta sends a `GET` to the broker with the optional bearer and a 15-second timeout. A usable JSON response contains non-empty `accessToken`, non-empty `accountId`, and an ISO `expiresAt` more than five minutes in the future. Delta caches the token and coalesces concurrent mints. A `401` or `403` invalidates it and permits one re-mint retry; `409` immediately advances to another provider; a `429` temporarily cools the shared credential and advances to a keyed provider.

Subscription tokens are sent only to exact HTTPS hosts in `DELTA_BROKER_ALLOWED_HOSTS`, whose default is `chatgpt.com`. Add the real backend host explicitly when required. The broker URL must be HTTPS, except for loopback development. Configure a keyed provider in `DELTA_PROVIDERS` as a production fallback for broker exhaustion, authentication failure, or rate limiting. Subscription-route `cost_usd` is API-rate-equivalent consumption from Delta's price table, not the incremental subscription bill.

### Utility model and reasoning

Compaction, reflection, and `eval_n` judging use `DELTA_UTILITY_MODEL`, which defaults to `anthropic/claude-haiku-4.5`. Set it to an empty value to use the main provider cascade for those calls. The utility model is tried on each compatible provider. Native Anthropic translates dotted Claude version segments to dashes; Responses providers are skipped for a Claude utility model. Any utility-lane failure falls back to the main cascade, and reasoning effort is not applied to utility calls.

Set a daemon default for extended reasoning:

```dotenv
DELTA_REASONING_EFFORT=high
```

Or override it for one run with `metadata.reasoning_effort`. Delta lowercases and trims the value. OpenRouter and Responses receive `reasoning.effort`; a directly compatible Chat Completions endpoint receives `reasoning_effort`. Native Anthropic maps `none`, `minimal`, `low`, `medium`, `high`, and `xhigh` to disabled, 1,024, 4,096, 8,192, 16,384, and 32,768 thinking tokens. An unknown Anthropic value uses the 16,384-token mapping. Other providers validate their own accepted values and can return a clean `4xx`.

## Run and call the agent

### CLI reference

| Command | Behavior |
|---|---|
| `delta init <dir>` | Create the five-file bundle without overwriting files. |
| `delta dev <dir> [--port N] [--no-open]` | Load `delta.env`, run a loopback daemon, capture calls, and open the Cockpit. |
| `delta send [--port N] "<input>"` | Create an async task and print its dev event stream as JSON Lines. |
| `delta send [--port N] --json "<input>"` | Make a sync request and print final `output_text`. |
| `delta watch [--port N] [--run <id>] [--since <event-id>]` | Replay and follow the Cockpit event stream without starting work. |
| `delta run <task>` | Run one task with an in-memory database and persistent workspace. Primarily used for delegated subagents. |

`delta run` reads configuration from the process environment and bundle files from `DELTA_WORKSPACE`. It does not load `delta.env`, connect configured MCP servers, start HTTP or Cockpit, or provide crash recovery. Its conversation database is in memory, but file writes and `DELTA.md` changes persist in the workspace.

### Synchronous HTTP request

```sh
curl -sS http://127.0.0.1:8080/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "input": "Create a decision brief from the files in the workspace.",
    "metadata": {
      "user_id": "user_123",
      "task_id": "task_456",
      "task_type": "decision-brief"
    }
  }'
```

When `DELTA_CONTROL_TOKEN` is set, add the machine bearer to every run, task, queue, and upload request:

```sh
-H "authorization: Bearer $DELTA_CONTROL_TOKEN"
```

The terminal response has this shape:

```json
{
  "id": "resp_...",
  "object": "response",
  "model": "anthropic/claude-sonnet-5",
  "status": "completed",
  "output_text": "...",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "..." }]
    }
  ],
  "previous_response_id": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "cost_usd": 0
  }
}
```

### Continue a conversation

Use the prior response's `id`:

```sh
curl -sS http://127.0.0.1:8080/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "input": "Now turn that brief into an executive email.",
    "previous_response_id": "resp_previous"
  }'
```

The new run joins the same session. Its active conversation, compacted summaries, and session-scoped user identity remain available. A prior response ID is only a session lookup, not a history snapshot or branch point. Continuing from an older response still appends to the current session head and sees later turns. Multiple continuations into one session serialize rather than fork.

### Stream final text

```sh
curl -N http://127.0.0.1:8080/v1/responses \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"input":"Write the brief.","stream":true}'
```

The stream emits `response.output_text.delta` frames, followed by one `response.completed` frame with the full response. Tool-calling turns can emit intermediate assistant text before the terminal answer, so concatenating every delta is not guaranteed to equal the final `output_text`; treat `response.completed` as authoritative. Reasoning deltas are available to the internal dev stream, but are never mixed into final answer text.

### Start and monitor a long task

Create the task:

```sh
curl -sS http://127.0.0.1:8080/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"input":"Review every report in the workspace and synthesize the findings."}'
```

Delta acknowledges only after the queue row is durable:

```json
{"id":"resp_...","object":"task","status":"queued"}
```

Inspect status:

```sh
curl -sS http://127.0.0.1:8080/v1/tasks/resp_...
```

Follow live task events:

```sh
curl -N http://127.0.0.1:8080/v1/tasks/resp_.../events
```

This task event endpoint is live-only. If the task is already terminal, it immediately emits the final `done` frame. Use `/v1/dev/stream?since=<event-id>` when replayable inspection is required.

The shipped queue has four cross-session workers and no admission or backlog cap. Put capacity limits and backpressure in the gateway. For long work, prefer `/v1/tasks` over keeping a synchronous request open. Delta disables Bun's server idle timeout, but proxies and load balancers still need suitable request, read, and SSE timeouts. Task and response streams do not bound queued frames for slow consumers, so clients must consume promptly and gateways should cap concurrent or abandoned streams.

Cancel a queued or running task:

```sh
curl -sS -X DELETE http://127.0.0.1:8080/v1/tasks/resp_...
```

Cancellation is cooperative. Signal-aware model and tool work receives an abort. A detached, signal-ignoring tool may still finish, so verify external state before retrying its side effect.

Task status has five values:

| Status | Meaning |
|---|---|
| `queued` | Durable and waiting for an available daemon worker. Sessions stay serial; different sessions use up to four workers by default. |
| `running` | The worker owns the run. |
| `done` | Completed successfully. |
| `failed` | Reached a terminal provider, tool-loop, or budget failure. |
| `cancelled` | Cancelled before start or stopped cooperatively while running. |

`GET /v1/tasks/:id` includes `result` only for `done`, `failed`, or `cancelled`. Handled outcomes store a complete Responses-compatible object with `status`, `output_text`, `output`, model, previous response ID, and usage. Failed and cancelled output begins with a Delta status marker rather than pretending to be a successful answer. An unexpected exception outside Delta's handled run path can currently mark a task `failed` with an empty `{}` result and no normal `run.finished` event. A task or response SSE client waiting for that event can continue receiving heartbeats, so clients need their own terminal-status polling and timeout. Operators must alert on structured errors and malformed terminal results.

Handled non-streaming API errors use this shape:

```json
{"error":{"message":"human-readable reason"}}
```

The request root must be a JSON object. A valid JSON scalar such as `null` currently escapes the normal validation path and can produce a generic `500` response instead of this envelope, so a public gateway should reject non-object bodies before forwarding them.

| Status | Common meaning |
|---|---|
| `400` | Invalid JSON, empty input, unknown prior response, or invalid route parameters. |
| `401` | Missing or incorrect control or inspection bearer. |
| `403` | Inspection is non-loopback without an inspect token, editing is disabled, or a file operation is forbidden. |
| `404` | Unknown task or route, unavailable inspection state, or the inspection surface is disabled. |
| `413` | An uploaded file, batch, or Cockpit file body exceeds its cap. |

### Request fields

| Field | Meaning |
|---|---|
| `input` | Required non-empty task text. |
| `instructions` | Optional task-specific instructions appended as an ephemeral user-role block on each model turn. |
| `previous_response_id` | Continue the session that contains this response. |
| `stream` | Stream a synchronous response over SSE. |
| `metadata` | Caller-supplied identity, budgets, context, auth, learning, and correlation fields described below. A trusted gateway must validate and normalize it. |
| `store` | Accepted for Responses API compatibility. It does not disable Delta's required durable persistence. |

Useful metadata:

| Metadata | Meaning |
|---|---|
| `user_id` | Bind the session user, scope private memory, and correlate events. Use this snake-case form for durable session binding. `userId` is accepted by some per-run readers but is not persisted on a newly created session. |
| `agent_id` or `agentId` | Override the per-run event identity. The daemon's stable memory identity still comes from `DELTA_AGENT_ID`; a gateway should normally replace this value. |
| `task_id` or `taskId` | Correlate the run with external work. |
| `entity_id`, `entityId`, or `entity` | Correlate and optionally scope product hydration. |
| `task_type` or `taskType` | Select a caller-declared reusable memory tier, such as `weekly-report`. |
| `profile` | Narrow the daemon's placement profile for this request. It cannot escalate permissions or budgets. |
| `reasoning_effort` or `reasoningEffort` | Override the main model's reasoning effort for this run. |
| `reflect` | Set `true` to run post-task reflection even when the daemon default is off. |
| `authToken` | Replace static authorization for this run's HTTP MCP calls. Treat it as a sensitive, short-lived user credential. |
| `context` | Supply bounded values for `{{request.*}}` prompt context. |
| `review_kind` | Set exactly `submission_disposition` for a human-review correction turn. |
| `submission_id` | Caller correlation only. Delta does not look up, authenticate, or validate a submission with it. |
| `widen_authorized` | Allow reviewed user-derived learning to widen beyond private user memory when explicitly `true`. |

Delta does not authenticate these identity or privilege claims, and it does not enforce ownership of task IDs. It does enforce **session ownership**: continuing a session with `previous_response_id` is rejected when the session is owned by a different user, so a caller cannot join or read another user's transcript by guessing a response ID. A session with no asserted owner stays open, which is the single-tenant path. Both `user_id` and `userId` are recognized when a session's owner is set, so the alias does not create an unowned session. Per-run metadata can still affect recall, reflection, event identity, MCP authorization, and review widening. End users must never send these fields directly to Delta. A trusted gateway must authenticate the caller, authorize every task and prior response ID, inject one canonical `user_id`, reject identity mismatches, strip or replace `agent_id`, `authToken`, `review_kind`, and `widen_authorized`, and construct review metadata only from verified control-plane state. Missing identity can route learning into shared scopes.

### Queue visibility

```sh
curl -sS http://127.0.0.1:8080/v1/queue \
  -H 'x-delta-user: user_123'
```

The named caller sees its own queued and running rows with IDs and session IDs. Other users' rows remain opaque and show only status, position, and age. The header is an identity hint expected from a trusted control plane, not authentication by itself.

### Upload files

```sh
curl -sS http://127.0.0.1:8080/v1/files \
  -F 'file=@./brief.docx' \
  -F 'file=@./chart.png'
```

Delta validates the full batch before writing any file. Limits are 50 files per request, 25 MB per file, and 100 MB total. The later filesystem writes are not transactional, so a storage failure on file N can leave earlier files from that batch in place. Files land under `inbox/YYYY-MM-DD/`, and the first upload creates `FILES.md` with organization conventions. Pass the returned paths to the agent in the next request.

Images are attached to a vision-capable model only after Delta itself has verified their provenance through upload, `read_file`, or an MCP image response. Up to four recent images smaller than about 3.4 MB each are attached. Provenance is process-local, so after a daemon restart re-read a workspace image, re-upload it, or retrieve it again through MCP before expecting an inline attachment. Old markers remain file references and can be re-read.

## Built-in capabilities

The `work` profile exposes the built-in tools below. Tool failures are returned to the model as values, so one failed dependency does not crash the daemon.

| Tool | What it does | Important limits |
|---|---|---|
| `web_search` | Search through Exa. | Requires `EXA_API_KEY`; 5 results by default, 10 maximum. |
| `web_fetch` | Fetch an HTTP or HTTPS page. | Blocks private, loopback, and metadata addresses, including up to five redirects, unless explicitly relaxed. It buffers the full response before applying the returned-text cap, so use egress and upstream size controls for hostile endpoints. |
| `read_file` | Read supported workspace files. | Text: 20 MB maximum and pages of at most 2,000 lines and 50,000 characters. Also handles images, notebooks, DOCX text, and XLSX shared-string cells. PDFs, PPTX, other binary formats, formulas, numeric spreadsheet cells, and document layout need another tool; DOCX and XLSX extraction requires host `unzip`. |
| `list_dir` | Recursively list files under a workspace directory. | Directories are not returned. The full list is built before the central result cap. |
| `grep` | Search file contents with a regular expression. | Maximum 100 hits; 10 second process timeout; skips `.delta`. |
| `write_file` | Create or replace a workspace file. | Confined to the workspace. No per-file or workspace quota is enforced. Only protected names at the workspace root are blocked. |
| `move_file` | Move or rename a workspace file. | Destination overwrite must be explicit. |
| `delete_file` | Move a file or directory to recoverable trash. | Entries older than seven days are swept at daemon startup, not periodically while it runs. |
| `remember` | Replace `DELTA.md`. | Full-file replacement, size-capped, revisioned, visible on the next run. |
| `search_tools` | Find and activate non-resident allowed tools for the current run. | Activates up to five name or description matches per call; lexical matching only. |
| `code` | Delegate a task to a configured coding CLI. | No harness timeout or Delta filesystem sandbox. The child has every path and capability available to the daemon's OS user, subject to any sandbox implemented by the selected CLI. |
| `spawn_subagent` | Run one isolated side task through `delta run`. | One nesting level; fresh in-memory conversation and narrow environment. |
| `eval_n` | Run 2 to 5 independent variants and judge the best. | Best for reasoning or drafting that does not mutate shared files. |
| `schedule_self` | Ask a control plane to wake the agent later. | Registered only when control-plane URL and token are configured. |
| `list_schedules` | List the agent's schedules through the control plane. | Same requirement. |
| `cancel_schedule` | Cancel a schedule through the control plane. | Same requirement. |

`DELTA_TOOL_TIMEOUT_MS` supplies the outer timeout for ordinary queued-run tools and defaults to 120 seconds. In normal queued execution, that outer signal replaces the search and fetch helpers' fallback 30-second signal; setting it to `0` therefore leaves those tools without a harness ceiling. MCP calls have an internal 60-second ceiling, and scheduling calls use 15 seconds. `code`, `spawn_subagent`, and `eval_n` deliberately use no outer timeout. Asynchronous work that ignores abort can continue detached, and synchronous blocking code cannot be preempted.

### Workspace safety

Normal file tools resolve every model-supplied path inside the workspace and reject traversal and escaping symlinks. Their protected-name rule applies only at the workspace root. They cannot write these root paths:

- `POLICY.md`
- `vocab.json`
- `PROMPT_CONTEXT.md`
- `DELTA.md`, except through `remember`
- root `.env`, `.env.*`, or `delta.env`
- root `.delta` and everything under it

The same names below a subdirectory are not protected, so `notes/POLICY.md` is writable. These are mutation guards, not read controls or a process sandbox. `read_file` can read workspace configuration, and the `code` tool runs a separate process with the daemon OS user's access. Never place secrets anywhere in the agent workspace. Use a dedicated OS user, VM, or purpose-built sandbox for stronger isolation.

### Large tool results

All tool results pass through one central cap, 20,000 characters by default. If a result is larger, Delta keeps its beginning and end in the conversation and saves the complete result under:

```text
.delta/spill/<run-id>.<call-id>.txt
```

The inline message tells the model where to re-read the full output. Change the inline cap with `DELTA_TOOL_RESULT_MAX_BYTES`.

### Coding CLI

The default command is:

```text
codex exec --sandbox workspace-write --skip-git-repo-check
```

Override it as a whitespace-separated command:

```dotenv
DELTA_CODE_CLI=claude --print
```

The command runs with the workspace as its current directory and has no harness timeout. Delta splits `DELTA_CODE_CLI` on spaces without shell or quote parsing, so quoted arguments and executable paths containing spaces are unsupported. The default container does not install a coding CLI. Add one to the image and provision its credentials if the `code` tool is required. Delta's default asks Codex for its own `workspace-write` sandbox; a custom CLI receives no equivalent sandbox from Delta.

### Subagents and `eval_n`

`spawn_subagent` starts the same Delta binary in one-shot `run` mode with:

- a new in-memory database and conversation
- the same workspace
- the same bundle files, loaded again under child defaults
- the remaining parent fresh-token and cost budget
- at most one level of nesting
- a default-deny child environment
- a narrow allowlist of provider and run variables plus one static primary credential

The child forwards the safe process environment plus the primary base URL, wire type, legacy model name, model fallbacks, utility model, profile, model and stream timeouts, result cap, remaining budget values, and one static primary key. It does not inherit the parent's MCP configuration, Exa key, telemetry, control-plane token, subscription broker token, provider cascade objects or secrets, model headers, custom prices, reasoning, vision settings, coding CLI, stable agent ID, learning and hydration settings, or custom self and policy caps. A broker-only parent therefore cannot currently power a spawned subagent unless a static primary model key is also available. The same bundle does not guarantee the same resolved behavior: the child can reset to the default coding CLI, default identity, and 800-token file caps.

The child allowlist forwards both `DELTA_MODEL_PRIMARY` and the legacy `DELTA_MODEL` alias, so a subagent runs on the parent's configured model. The child also does not receive `MODEL_HEADERS`, `DELTA_MODEL_PRICES`, or reasoning settings, so a custom-header route, custom metering, or parent reasoning configuration is not reproduced in the child.

Subagents share the workspace. A subagent can also receive the `remember` tool under the `work` profile, so it can replace the shared `DELTA.md`; its revision database is temporary. Use delegation only for tasks whose file and self-memory effects are intentional.

`eval_n` runs variants concurrently against the same workspace. Use it for drafting, analysis, or other non-mutating work. Do not use it for concurrent edits to the same files.

Each child prints a `DELTA_USAGE` marker. Valid parsed usage is added to the parent and constrained by the remaining fresh-token and dollar budget. Missing or malformed child usage fails open as zero. External spend by a coding CLI or subscription route is not discovered through this marker. The current `eval_n` judge call is not charged to the parent usage total.

All tool calls returned by one model turn execute concurrently, including mutations, and four different sessions can run concurrently. There is no compare-and-swap layer for files or external resources. Same-session serialization does not serialize sibling tool calls within one turn. Design mutating tools to be idempotent and conflict-aware, and avoid parallel tasks that can touch the same state.

### Scheduling

Delta does not keep a local alarm clock because a production VM may be suspended. When both settings are present, it exposes scheduling tools backed by the control plane:

```dotenv
DELTA_CONTROL_URL=https://control.example
DELTA_CONTROL_TOKEN=machine-token
```

Schedules support:

- one-time ISO timestamps
- intervals of at least 60 seconds
- five-field cron expressions with an optional IANA timezone

The control plane owns storage, time, and wake-up behavior. Delta only requests and manages schedules through its authenticated API.

## Connect MCP tools

Delta implements MCP Streamable HTTP and newline-framed stdio without an SDK dependency. It initializes every configured server at daemon boot, discovers its tools, and registers them as `<server>__<tool>`.

### HTTP server

`DELTA_MCP_SERVERS` should be a JSON array. The `transport` field is required:

```dotenv
DELTA_MCP_SERVERS=[{"name":"crm","transport":"http","url":"https://crm.example/mcp","headers":{"authorization":"Bearer service-token"}}]
```

The expanded JSON is:

```json
[
  {
    "name": "crm",
    "transport": "http",
    "url": "https://crm.example/mcp",
    "headers": {
      "authorization": "Bearer service-token"
    }
  }
]
```

An MCP tool named `get_account` becomes `crm__get_account`. Names that cannot fit the model API's tool-name rules are dropped.

Malformed JSON is treated as no configured servers. Delta does not structurally validate the array before connection setup, so validate it in deployment tooling and inspect boot logs plus `/v1/dev/config` rather than assuming a non-empty variable produced tools.

### Stdio server

```dotenv
DELTA_MCP_SERVERS=[{"name":"local","transport":"stdio","command":["bun","run","server.ts"],"env":{"MODE":"production"}}]
```

The stdio child inherits the daemon environment plus the explicit `env` object. Treat a stdio MCP process as trusted code inside the same machine boundary.

### Authentication

Static HTTP headers apply to discovery and tool calls. For a user-scoped run, pass a short-lived token:

```json
{
  "input": "Update my account brief.",
  "metadata": {
    "user_id": "user_123",
    "authToken": "short-lived-user-token"
  }
}
```

For that run, Delta replaces the HTTP MCP `Authorization` header with `Bearer <authToken>`. One run has one shared `authToken`, and Delta applies it to every HTTP MCP server called by that run. Use tokens with the correct audience across all connected servers, or place differently scoped connectors on separate daemons. Each MCP service must enforce the user's permissions.

Delta also supports one rotating MCP credential attached to a named HTTP server:

```dotenv
DELTA_MCP_REFRESH_URL=https://auth.example/token
DELTA_MCP_REFRESH_FILE=/data/mcp-refresh-token
DELTA_MCP_REFRESH_SERVER=crm
DELTA_MCP_REFRESH_CLIENT_ID=delta-agent
DELTA_MCP_REFRESH_TOKEN=first-boot-refresh-token
```

The required fields are URL, file, and server. The seed token and client ID are optional. On an MCP `401`, Delta rotates once and retries unless a per-run user token supplied the authorization.

The refresh file is authoritative persistent state. Delta seeds it only when absent, does not create its parent directory, and does not repair an existing empty or corrupt file. Pre-create a private writable parent outside the agent workspace, use one refresh-token file per daemon or machine, and include its current value in the recovery design. Never restore a stale backup of a refresh token that may already have been exchanged. Refresh coalescing is process-local.

Do not also set a static `Authorization` header on the selected rotating server. Static headers are applied after the rotating credential and can overwrite it, including on the `401` retry. A partial or unmatched refresh configuration only warns and may leave the server unauthenticated, so assert the expected connection at startup.

### Failure and reload behavior

One unavailable MCP server does not prevent the daemon from starting. Its tools are absent and the failure is logged. MCP configuration is boot-time in the shipped daemon, so restart after changing `DELTA_MCP_SERVERS`.

Delta implements a deliberately small MCP subset around protocol version `2025-06-18`. It calls `tools/list` once at boot, does not paginate or consume list-changed notifications, and requires a restart for rediscovery. HTTP accepts plain JSON or one complete JSON object on a single SSE `data:` line; multiline SSE events are unsupported. Stdio is newline-delimited JSON, not `Content-Length` framing. Tool results retain text and image content only; structured content, resources, audio, and embedded resources are not passed to the model.

Every MCP result is framed as untrusted data before it reaches the model. The server still owns the side effects and authorization of its tools.

Crash idempotence is inferred from the MCP tool name. Names containing an underscore- or dot-delimited segment such as `get`, `list`, `search`, `read`, `version`, `versions`, or `file` are treated as read-only and may be re-executed after interruption. All other MCP tools are treated as non-idempotent. Name mutations so they do not contain those read segments. In particular, a mutating name such as `get_or_create` is unsafe because Delta will classify it as idempotent.

### Progressive tool loading

A large connector surface should not put hundreds of schemas in every prompt. The `work` profile:

1. pins all built-in tools
2. pins MCP tools whose suffix appears in `vocab.coreVerbs`
3. leaves other allowed tools searchable through `search_tools`
4. activates up to five matches at a time
5. persists those activations with the run

Delta applies a 60-name threshold to the initially requested pinned set. If that set is larger, it warns and falls back to the built-ins plus `vocab.coreVerbs`. The fallback is not capped a second time, so an oversized `coreVerbs` list can still exceed 60. Keep the declared core small; this threshold is a guardrail, not a strict invariant or a restriction on the total MCP registry.

## Memory and self-improvement

Delta has three separate learning surfaces. They solve different problems and should not be conflated.

### 1. The living self-file

`DELTA.md` carries a small lesson into every future request. Use it for a compact operating preference or identity change that is important enough to pay for on every model call.

The `remember` tool is explicit, reversible, and visible in the workspace. It is not the same as automatic post-run reflection. Concurrent updates are atomic but last-writer-wins, so two runs can overwrite each other's lesson without corrupting the file.

### 2. Governed local memory

Optional reflection runs after a successful response and distills at most one reusable artifact:

- fact
- preference
- pitfall
- procedure

Enable it for every successful run:

```dotenv
DELTA_REFLECT=1
```

Or enable it for one request:

```json
{
  "input": "Prepare the weekly revenue review.",
  "metadata": {
    "reflect": true,
    "task_type": "weekly-revenue-review"
  }
}
```

Reflection runs best-effort in the background after the response has been released. It has no durable work queue or retry, and shutdown or a crash can drop it. A failure never changes the completed user response. A per-run `reflect: false` does not disable a daemon that has `DELTA_REFLECT=1`. Reflection usage is added later to the run row, but it is not added to the already stored terminal response payload or the earlier `run.finished` event and does not emit a normal `model.call` usage event. Cockpit can therefore later show more run usage than the API result or exported terminal telemetry.

Local memory is structured by four independent axes:

| Axis | Values |
|---|---|
| Audience | `user`, `task_type`, `agent`, `org` |
| Artifact | `fact`, `preference`, `pitfall`, `procedure` |
| Trust | `trusted`, `untrusted` |
| Source | `self`, `review` |

It is also keyed by product namespace, agent ID, user ID when private, and caller-declared task type when shared by use case. The local recall query currently returns agent, current-user, and matching-task-type rows. `org` rows can participate in shared promotion state but are not recalled by the local rail.

Governance rules:

- self-rated confidence below `0.6` is rejected
- a human-review correction receives at least `0.8` confidence
- content is capped at 500 characters
- duplicate content confirms one row and records the distinct producing run
- one identity is normally capped at 200 evictable rows; rows protected by staged or claimed promotion can temporarily take it over that limit
- memory unused for 90 days stops being recalled
- recall scores lexical relevance, aliases, confidence, recency, and prior use, but applies no minimum relevance threshold, so a zero-overlap row can still rank into the bounded result
- recall is inserted only at the first run of a session

Intended privacy routing, after a trusted gateway has supplied canonical metadata, is:

- a run tied to a user writes user-scoped memory
- a model cannot widen that private memory to a shared audience
- widening user-derived learning requires a human review turn with explicit `widen_authorized`
- user memory is never promoted to an external shared store
- a userless run with `task_type` can create and recall memory shared only for that caller-declared use case

These rules are not an authentication layer. Caller-controlled identity and review fields can change scopes unless a gateway normalizes them as described under request fields. Agent recall also includes legacy rows whose `agent_id` is empty. Separate databases or migrate and delete legacy rows before relying on agent-level isolation.

The local memory rail is deterministic SQLite retrieval, not vector search. It gives the harness a useful no-backend fallback while leaving semantic enterprise knowledge to an optional product store.

### 3. External context and reusable skills

Task-start hydration can call product MCP reads before the first model turn of a new session:

```dotenv
DELTA_HYDRATE_TOOLS=crm__get_dashboard,crm__list_recent_notes
DELTA_HYDRATE_SEARCH_TOOL=crm__search_knowledge
```

Subject-scoped reads run only when request metadata contains a key declared by `vocab.subjectKeys`. If the vocabulary contains `"account"`, Delta checks `account`, `account_id`, and `accountId`.

Task-keyed search requires `metadata.authToken`, even when no subject is present. With a trusted gateway, this avoids falling back to a shared daemon credential for user knowledge. Hydration is best-effort, waits at most 20 seconds, and injects at most about 16,000 characters across its blocks. The wait race does not abort the underlying calls, which can continue detached. Hydration calls configured tools directly, without the normal tool journal, idempotence classifier, or central result cap. Configure read-only, least-privilege tools only.

Each configured hydration read receives the resolved subject fields plus `limit: 20`. The search tool receives both `q` and `query`, the same subject fields, and `limit: 8`; the task text is truncated to 500 characters and must contain at least two non-space characters. Delta sends that whole object unchanged. A strict MCP schema must declare every supplied property or tolerate extras.

Separately, the capability adapter searches once per execution attempt for a reusable procedure, so it can repeat after crash recovery. Its 20-second wait likewise does not abort a late underlying call. Delta loads the first reference returned by the adapter and exposes other matches as references. A custom adapter may rank by task relevance; the built-in skill-registry adapter currently uses its returned index order. The block is ephemeral, bounded, and framed as untrusted directory data.

The built-in adapter recognizes skill-registry-style MCP tools with this concrete contract:

- it is considered bound only when a matching skill create, update, or propose tool exists; `skill_search` and `skill_get` alone do not activate retrieval
- directory search uses a tool whose name ends in `skill_search`, normally `<server>__skill_search`, and calls it with `{ "limit": 25 }`
- loading a procedure uses a tool whose name ends in `skill_get` and calls it with `{ "name": "<exact-name>" }`
- creation or update discovers a tool whose name matches `skill` followed by `create`, `update`, or `propose`
- a create sends `name`, `body`, and a bounded `description`; an update sends `name`, `body`, `base_version`, and `baseVersion`; reflected promotions also send both `change_summary` and `changeSummary`
- an update retries once after a reported version conflict by loading and rebuilding from the fresh version
- the current built-in search does not send the task query and keeps the returned index order; custom capability adapters can rank by relevance
- only one matching capability-tool family is bound, selected by insertion order
- `skill_search` extracts JSON-like objects with a string `name` and optional string `description`
- `skill_get` accepts only a string `body` and integer `version` of at least 1; other response shapes are treated as absent

Strict skill-registry tool schemas must accept the paired snake-case and camel-case fields above.

The engine boundary remains generic:

- a capability store searches, reads, and proposes versioned procedures
- a curated store accepts proposed facts, preferences, and pitfalls

Facts, preferences, and pitfalls go to the MCP tool selected by `vocab.writeVerbSuffix`; `vocab.writeShape` maps them into that product's exact arguments. Procedures use the capability adapter instead.

These external stores are optional. A plain Delta works with local memory only.

### Promotion to shared knowledge

Non-user learning enters a durable SQLite outbox before any external proposal:

- procedures target the capability adapter
- facts, preferences, and pitfalls target the curated adapter
- a review-grounded correction may promote immediately
- the same lowercased, whitespace-normalized reflection content must recur in two distinct runs by default; a semantic paraphrase counts as different content
- only trusted memory can promote
- the local outbox carries an idempotency key, but the bundled skill-registry and curated MCP adapters do not transmit it to their remote tools; a crash after remote success can therefore duplicate a proposal
- a failed proposal can be retried when a later successful reflection drains the outbox and becomes terminal after five attempts; there is no independent retry timer

Change the recurrence threshold with `DELTA_PROMOTE_MIN_RUNS`. Agent, user, and task-type rows remain locally useful when no external adapter is bound. An `org` row is not part of local recall.

Promotion rows are scoped by the normalized content, full identity and artifact dimensions, namespace, and selected adapter. Changing the memory namespace, write noun, suffix, or adapter can strand staged rows. Drain or deliberately migrate the outbox before changing those bindings.

### Learn from human review

Delta is ready to participate in a review loop, but it does not ship a universal approval service. The connected product must provide the proposal tool, review state, user interface, and eventual side effect.

The recommended loop is:

```text
agent work
  -> one proposal through <server>__<writeVerbSuffix>
  -> human accepts, rejects, or edits it in the product
  -> control plane sends the disposition back as a new Delta run
  -> review reflection learns from proposed versus accepted work
```

The review run must be explicit:

```json
{
  "input": "Review outcome: item 1 accepted with edits. Proposed: ... Accepted: ... Reviewer note: ...",
  "metadata": {
    "review_kind": "submission_disposition",
    "submission_id": "submission_123",
    "reflect": true,
    "widen_authorized": false
  }
}
```

Only the exact `review_kind` value `submission_disposition` switches reflection to the correction-focused rubric. Delta does not validate reviewer identity, fetch the submission, or structurally compare proposed and accepted work. It asks the reflection model to ground learning in the supplied digest. The trusted control plane must authenticate the disposition and construct the real proposed-versus-accepted content rather than forwarding an end-user claim that review happened.

## Durable execution and budgets

### Profiles

Two placement profiles ship:

| Profile | Allowed tools | Initial schemas | Steps | Fresh tokens | Cost |
|---|---|---|---:|---:|---:|
| `work` | All registered tools | Lean core | 100 | 2,000,000 | $5.00 |
| `chat` | `web_search`, `web_fetch`, `read_file`, `list_dir` | All four | 10 | 100,000 | $0.25 |

Set the daemon ceiling:

```dotenv
DELTA_PROFILE=work
```

A request can choose `metadata.profile: "chat"` on a `work` daemon. It cannot choose `work` on a `chat` daemon. Unknown or more-permissive request values stay at the placement ceiling. This protection assumes the daemon ceiling itself is valid: an unknown `DELTA_PROFILE` currently falls open to `work`. Validate the environment before launch and allow only `work` or `chat`.

Lower the token and cost ceilings:

```dotenv
DELTA_MAX_TOKENS=250000
DELTA_MAX_COST_USD=1
```

There is no environment setting for maximum steps. Profiles are defined in the engine.

### What the budget measures

One step is one successfully completed main-loop model call. Failed provider attempts, compaction, reflection, hydration, capability retrieval, and the `eval_n` judge are not steps.

The fresh-token guard uses recorded main and child usage:

```text
fresh input tokens + output tokens
```

Prompt-cache reads do not repeatedly consume the fresh-token budget. Dollar usage comes from the provider when available or from Delta's price table. A compatible provider that omits or misreports usage weakens both token and dollar enforcement, so verify metering with production routes before relying on caps.

For a model that is not priced, add dollars per million tokens:

```dotenv
DELTA_MODEL_PRICES={"my-model":{"in":2,"out":10,"cacheRead":0.2}}
```

Without a known price, Delta warns and records zero model cost for that path. A dollar cap cannot protect an unpriced model. Table lookup follows the served model ID and prefix matching; verify the selected row. A price override without `cacheWrite` values cache writes at 1.25 times input. Current parsing also accepts negative prices, so validate overrides externally because a negative value can weaken the cost guard.

Budgets are hard loop guards against usage Delta records, checked between model calls. The final call, its parallel tools, or background reflection can move recorded usage past the nominal threshold before the next guard. They do not cap failed provider attempts without usage, a child with a missing or malformed usage marker, provider under-reporting, coding CLI or subscription-account spend, MCP or search API fees, cloud cost, or the current `eval_n` judge. Subscription calls record API-rate-equivalent cost rather than the subscription's actual marginal bill. Treat these values as one-call-granularity model-loop guards, not prepaid authorization or a complete spend limit.

Environment overrides use JavaScript number conversion. An exported empty `DELTA_MAX_TOKENS` or `DELTA_MAX_COST_USD` becomes zero rather than unset. Validate all budget variables before starting the daemon.

### Compaction

Delta compacts when the previous model request exceeded `DELTA_COMPACT_AT_TOKENS`, default 120,000, and there are more than five active messages. It preserves the last four active messages, not four complete turns, and asks the utility model for a summary under 350 words from at most 60,000 characters of older history. A failed compaction is a no-op. The compaction call is charged to run usage but not the step count.

If a provider reports a context-window overflow earlier, Delta forces one compaction and retries the same model turn once. Forced overflow handling may also elide an oversized tool message. If compaction cannot reduce the context, the run fails cleanly.

### Checkpoints and crash recovery

SQLite uses WAL mode, foreign keys, transactional schema migrations, and a five-second busy timeout. Durable state includes:

- sessions and runs
- active and compacted messages
- model step count and usage
- active tool names, whose schemas are reconstructed from the boot registry
- tool intents and results
- events
- local memory and promotion state
- writer lease
- exact model-call captures when enabled
- `DELTA.md` revisions

The queue writes a run before acknowledging it. Each assistant message and all tool intents it creates commit atomically. Each tool result and its conversation message also commit atomically.

On restart:

- rows left as `running` resume before queued rows drain
- an unfinished model call can run again because no response was checkpointed; the provider may already have billed the interrupted attempt, so recovery can duplicate model charges
- a completed tool journal result is replayed without re-executing the tool
- an interrupted idempotent tool may execute again
- an interrupted non-idempotent tool is not blindly re-fired
- the model receives an `[interrupted]` result and must verify whether the side effect happened
- step count, usage, compaction, and activated tools survive

A resumed execution is recovery, not deterministic replay. It reloads current boot configuration, `POLICY.md`, prompt context, vocabulary, MCP registry, provider routes, and a fresh `DELTA.md` snapshot. Keep bundle and infrastructure changes coordinated with in-flight recovery.

Events and all run-state transitions are not one atomic log. A crash at a boundary can leave a durable state change without its expected event or can produce a repeated lifecycle event. Treat the event stream as operational observability, not an exactly-once audit ledger, and reconcile against task and run state.

### Single writer

Delta uses a renewable writer lease to reject a different machine holder. The lease defaults to 30 seconds and never goes below 5 seconds. A process exits if it loses renewal.

The holder ID defaults to `FLY_MACHINE_ID`, then the host name. A process with the same holder can immediately reacquire the lease so a crash restart does not wait for expiry. That also means the lease does not distinguish two live processes on the same machine. Do not set one manual `DELTA_LEASE_HOLDER` across different machines, because that defeats cross-machine exclusion too.

Binding the same port catches an ordinary duplicate start before work resumes. It does not protect two processes using different ports. In particular, two `delta dev` launches choose different free ports and can open the same bundle database under the same host identity. Never run two daemons for one database or bundle. Enforce one replica in the process manager or control plane rather than treating the current lease as a complete same-machine mutex.

The lease is coarse, best-effort exclusion, not per-write fencing. Clock skew, an event-loop pause longer than the TTL, or identical holder identities can permit overlapping work. Infrastructure must enforce one live owner for each database and volume.

### Local retention

Defaults:

| Data | Age | Row cap |
|---|---:|---:|
| Events | 7 days | 50,000 |
| Tool journal | 7 days | 50,000 |

The sweep runs once at boot and then hourly. Set `DELTA_RETENTION_SWEEP_MS=0` to disable only the periodic sweep. When telemetry export is active, the ordinary event sweep is skipped entirely and exporter overflow owns event deletion, while the sweep still prunes the journal. Set journal retention longer than the maximum run duration: deleting an old completed intent or result from an active multi-day run can remove restart replay protection.

This is not whole-database retention. Sessions, runs, messages, memory, promotions, captured calls, `.delta/spill`, and `.delta/media` are not age-pruned. Workspace trash is swept only at startup. SQLite reuses deleted pages but Delta does not run `VACUUM`. Plan database and file maintenance according to workload.

Shutdown is interruption-oriented, not drain-aware. On a termination signal Delta clears timers, force-stops the server, and closes the database without waiting for queued work, background reflection, or telemetry flush. Before planned maintenance, gate new traffic and use external queue and activity checks to wait for an acceptable state, or rely on documented crash recovery. The four-worker queue cap does not bound background reflection, because completed runs can start multiple untracked reflections concurrently.

## Long-running tasks and context management

Delta is built to run for hours across dozens of tool calls without the active context window filling up and without dropping earlier findings. The mechanism is a single principle: **restorable context — nothing load-bearing is ever unrecoverable.** Every compression the engine performs leaves a pointer back to the full thing on disk or in the local database, so a fact found at step 3 is still available at step 50.

### The active window stays bounded

Before every model call, the engine estimates the fully assembled request — system spine, tool schemas, ephemeral blocks, message history, and reserved output — using serialized byte size rather than a naive character count, and treating attached images as a fixed token reserve rather than their base64 length. If the estimate exceeds `DELTA_COMPACT_AT_TOKENS`, it compacts **before** sending, so a resumed or continued session cannot overflow on its first call. It also compacts when the previous call's real gross prompt size crossed the threshold, since cached tokens still occupy the model's window.

Compaction is archive-safe. Older turns are summarized into a structured note and their message rows are marked inactive — never deleted or overwritten. The recent tail is kept verbatim, sized by a token budget rather than a fixed message count, and snapped to a turn boundary so an assistant tool call always travels with its result. The original request is pinned verbatim, read fresh from the run record, and the summary is wrapped in a trusted-request / untrusted-history envelope with an explicit end marker so a weak model cannot read the historical note as fresh instructions.

The context window is one dial:

```dotenv
DELTA_COMPACT_AT_TOKENS=120000
```

Tight (60,000–90,000) is cheaper and lower latency and compacts more often. The default 120,000 is safe on any model with a 200,000-token window. Large (160,000+) keeps more continuity and performance and is safe to run because compaction is restorable — raise it only up to the model's real window minus output headroom.

### The summary preserves facts across many generations

When a prior summary is already present, the engine merges forward — it instructs the summarizer to preserve every prior fact and only add new ones, rather than lossily re-summarizing a summary each generation. After each summary it **audits** the result: it harvests load-bearing identifiers (numbers, years, and on-disk paths) from the recent turns and from the carried-forward summary, verifies the new summary reproduced them, and retries once with the misses named if more than a quarter were dropped. In practice a task that fires a dozen compactions keeps its numbers intact through every generation.

### Recovering what scrolled out

Two tools let an agent reach past the live window:

- `recall` searches this conversation's earlier turns, including ones compacted out of the active window, by keyword. It returns the matching finding — the whole message when it is reasonably sized, not a fragment — along with the on-disk path of any large result that was spilled. Searches are scoped to the current session; a caller cannot search another session's transcript.
- Tool results larger than the inline cap are spilled to a file under `.delta/spill`, and compaction records every spill path in an artifact ledger inside the summary, so a large result is always one `read_file` away.

An agent can also keep its own working plan with the `todo` tool. The plan is re-injected every turn as an ephemeral block that survives compaction, because it is rebuilt from a per-session store rather than living in the message history. It is the cheapest way to hold a running list of findings across a long run, and the tool tells the agent when the plan outgrows its budget so it can offload longer notes to a workspace file instead of silently losing them.

### Delegating heavy exploration

For work that would bloat the primary window, the `research` tool runs one to three read-only sub-agents in parallel, in-process. Each explores in its own bounded context with web and file-read tools, writes its full findings to a file the parent owns, and returns only a short summary plus that path — so the primary conversation absorbs the signal, not the exploration. Research sub-agents cannot write, run code, or take actions; their tool set is an operator-controlled read-only allowlist, and they only reach MCP tools when an act-as token is present.

### Boundaries

The token estimate is a conservative heuristic, not exact provider tokenization, so the post-provider overflow path remains a backstop that sheds aggressively and retries once. The summary audit tracks numbers, years, and paths; it does not track proper names, which the summarizer preserves but the engine does not verify. `recall` is a lexical search over the most recent window of the session, not a full-text index over an unbounded transcript. The re-injected plan is bounded and meant for a running list, not a large document — large findings belong in a workspace file. These are the seams to watch on genuinely long, high-volume runs.

## Debug and inspect with Cockpit

The Cockpit is an active JavaScript application embedded in every compiled binary at `/dev`. Its asset contains no embedded runtime data or credentials; it reads the separate `/v1/dev/*` inspection API after loading.

`delta dev` is the fastest local path because it defaults editing and normalized successful-call capture to on unless `delta.env` explicitly overrides those settings.

### Five tabs

| Tab | What it shows |
|---|---|
| Thread | Sessions, user and assistant messages, live reasoning, model turns, tool calls, hydration, recall, checkpoints, usage, and final status. It also has a task composer and file upload. |
| Runs | Recent runs with status, served model, input and output tokens, cost, and input preview. Selecting a run opens its thread. |
| Files | Workspace and operator bundle trees, text editing when enabled, and previews for supported files. Text preview is capped at 1 MiB and raw reads at 10 MiB. PNG, JPEG, GIF, WebP, and PDF can render inline; other raw types download. |
| Data | Fixed, redacted projections of internal SQLite tables for sessions, memory, occurrences, promotions, events, metadata, and the writer lease. |
| Setup | Resolved safe configuration, model, profile, namespace, credential-presence booleans, MCP servers, tools, vocabulary, and operator files. |

The header shows the stable agent ID plus cumulative tokens, cost, and the count of distinct runs that have at least one completed captured model call in the current live view.

### Normalized model-call inspection

With `DELTA_CAPTURE_CALLS=1`, each successfully served main-loop model turn stores Delta's normalized request and response representation:

- the assembled system spine
- active conversation messages
- ephemeral context, request instructions, and retrieved capability blocks
- active tool schemas
- reasoning effort and cache key
- returned assistant message and tool calls
- actual model and provider
- token usage, cost, and latency

Images remain file markers instead of copied base64. Capture occurs before provider-specific wire transformation. It is not raw HTTP and does not include the final URL, headers, SSE chunks, failed attempts, or retry traffic. The Cockpit's turn detail shows this normalized request and response after redaction on read.

Captured rows contain full prompts and outputs in SQLite before the read-time redaction. There is no automatic retention for the `calls` table. Leave capture off in production unless that storage and sensitivity are intentional.

Capture records the provider call that successfully served a model turn. Failed provider attempts, internal transport retries, and cascade candidates that fail before a successful result are not stored as call rows.

Hydration, capability lookup, reflection, promotion, compaction, and judging can call models or tools through internal paths that do not all pass through the ordinary tool journal, checkpoint, or call capture. Cockpit provides deep visibility into the main execution loop, but it is not a complete record of every internal invocation or decision.

### Replayable event stream

The Cockpit and `delta watch` use:

```text
GET /v1/dev/stream?since=<event-id>&run=<run-id>&session=<session-id>&live=1
```

Persisted frames have monotonically increasing IDs and can be replayed. Live text and reasoning deltas are ephemeral and have no durable ID. The Cockpit stream terminates a client after its buffer grows beyond 2,048 frames. Bundled Cockpit and `delta watch` do not automatically resume, so a robust custom client must persist the last durable ID and reconnect with `since`.

### Inspection API

| Route | Purpose |
|---|---|
| `GET /v1/dev/config` | Safe resolved configuration and secret-presence booleans. |
| `GET /v1/dev/stream` | Replay and follow correlated events. |
| `GET /v1/dev/runs` | List runs with optional session cursoring. |
| `GET /v1/dev/runs/:id` | Inspect a redacted transcript and run metadata. |
| `GET /v1/dev/runs/:id/calls` | Inspect captured model calls. |
| `GET /v1/dev/files` | Browse or read workspace and operator paths. Treat it as root inspection. |
| `PUT /v1/dev/files` | Edit when `DELTA_INSPECT_WRITE=1`. |
| `GET /v1/dev/self/revisions` | Read current and previous `DELTA.md` versions. |
| `POST /v1/dev/self/revert?id=N` | Restore a revision when writes are enabled. |
| `GET /v1/dev/tables` | List fixed peekable tables. |
| `GET /v1/dev/tables/:name?ack=root` | Read a fixed redacted projection. |

### Apply edits

Cockpit edits write bytes to disk. They do not hot-reload the daemon:

- an edited `DELTA.md` applies to the next run
- an edited `POLICY.md`, `PROMPT_CONTEXT.md`, or `vocab.json` requires restart
- changed provider, MCP, or environment configuration requires restart

This keeps the dev launcher behavior equal to production behavior.

The Files tree hides `.delta`, but that is presentation, not an access-control boundary. With root inspection, a direct `/v1/dev/files` request can currently address paths under the workspace `.delta` directory; when inspection writes are enabled, it can damage live state such as the development database. Treat the inspection token as root-equivalent, keep writes off in production, and block arbitrary inspection-file calls at a proxy unless the operator explicitly needs them.

### Inspect production safely

`delta send` and `delta watch` connect only to localhost. `delta dev` is a local launcher that opens a localhost Cockpit URL; it is not a remote-attachment command, although an explicit bind override can make its child daemon listen elsewhere.

Production inspection uses the same `/dev` and `/v1/dev/*` surfaces, with these gates:

- `DELTA_INSPECT_TOKEN` protects inspection data with a distinct bearer
- without that token, inspection data is loopback-only
- `DELTA_INSPECT_WRITE=1` separately enables edits and self-file revert
- `DELTA_INSPECT=off` removes both `/dev` and the inspection API
- `DELTA_CONTROL_TOKEN` protects run-driving endpoints but does not grant inspection

The bundled browser UI does not store or attach bearer tokens. For remote use, put a trusted same-origin proxy in front of the daemon. It must authenticate the operator, inject the inspect bearer for `/v1/dev/*`, and inject the control bearer for Cockpit task and upload requests. Loopback is checked from the immediate socket peer, so a same-host reverse proxy makes remote traffic appear local. Never rely on tokenless loopback inspection behind a proxy; set a distinct inspect token or disable inspection, and block `/dev` plus `/v1/dev/*` unless the operator is authenticated.

## Telemetry and events

Delta emits one correlated event stream and uses it in three ways:

1. every durable event is written to the local SQLite `events` table
2. in-process subscribers drive task and Cockpit SSE
3. an optional background exporter sends NDJSON envelopes from those records, with a privacy filter for model and tool attributes

The schema is custom NDJSON and uses a subset of OpenTelemetry GenAI-inspired names. It is not semantic-convention complete: fields such as `gen_ai.provider`, `gen_ai.usage.cached_tokens`, `gen_ai.usage.cost_usd`, and `latency_ms` are Delta-specific or legacy-shaped. Delta does not embed an OpenTelemetry SDK and does not emit OTLP.

### Enable export

```dotenv
TELEMETRY_URL=https://collector.example/delta/events
TELEMETRY_TOKEN=collector-token
```

If `TELEMETRY_TOKEN` is absent, Delta falls back to `DELTA_CONTROL_TOKEN`. The exporter does not currently enforce HTTPS or an allowlist, so validate `TELEMETRY_URL` carefully. Never send a control token to an untrusted or plaintext endpoint.

### Delivery contract

The exporter:

- sends `application/x-ndjson`
- wakes every two seconds
- sends up to 200 records per batch
- gives each request a 15-second timeout
- marks rows exported only after a `2xx`
- retries network and non-`2xx` failures
- provides at-least-once delivery only while an unexported row remains in the bounded outbox
- gives every record a restart-stable `<daemon-id>:<row-id>` deduplication key
- bounds its outbox at 50,000 rows by default
- deletes exported rows first on overflow
- drops the oldest unexported records only when the unexported backlog alone exceeds the cap

Retries are serial on a fixed two-second cadence with no exponential backoff or jitter. When telemetry is active, normal event retention is disabled; exported rows can remain until overflow, and visibility reports backlog count rather than oldest age. The collector should deduplicate on `event.id`, and operators should monitor collector health and backlog externally.

### Record shape

With `DELTA_CAPTURE_PAYLOADS=1`, an exported `model.call` record has this shape:

```json
{
  "event.id": "daemon-uuid:123",
  "event.name": "model.call",
  "event.time_unix_ms": 1783950000000,
  "user.id": "user_123",
  "agent.id": "agent_123",
  "session.id": "sess_123",
  "run.id": "resp_123",
  "task.id": "task_123",
  "entity.id": "entity_123",
  "turn": 2,
  "attributes": {
    "gen_ai.request.model": "anthropic/claude-sonnet-5",
    "gen_ai.usage.input_tokens": 1200,
    "gen_ai.usage.output_tokens": 300,
    "gen_ai.usage.cached_tokens": 900,
    "gen_ai.usage.cost_usd": 0.004,
    "latency_ms": 1800
  }
}
```

Important event types include run enqueue, start, resume, cancel, and finish; turn start and end; model call; tool call and result; checkpoint; compaction; hydration; recall; capability retrieval; reflection; promotion failure; and structured errors.

Local model and tool events carry operational attributes such as usage, provider, tool name, duration, and error state. They do not contain full prompts, responses, tool arguments, or tool results.

By default, exported `model.call`, `tool.call`, and `tool.result` envelopes omit the `attributes` key entirely. Other event types keep their attributes. `DELTA_CAPTURE_PAYLOADS=1` lets the model and tool attributes shown above survive that export filter. It still does not add full prompt or tool payloads because those fields are never placed in these events. Normalized successful main-loop request and response capture belongs to the separate `DELTA_CAPTURE_CALLS` Cockpit feature.

Payload filtering does not mean content-free telemetry. Other events retain attributes: recall can include a bounded memory excerpt, and errors or promotion events can include diagnostic strings. Credential-like patterns are scrubbed, but personal or business data can remain. Send telemetry only to a trusted collector with an explicit data-classification and retention policy.

Send NDJSON directly to a collector that understands this contract, or add a translation layer before an OTLP-only collector.

## Deploy Delta

### Production shape

The intended unit is one daemon per agent:

```text
trusted gateway or control plane
  -> one Delta process or VM
     -> one persistent SQLite database
     -> one persistent workspace
     -> model providers and MCP services
     -> optional telemetry collector
```

Do not run multiple writers against one database. Do not share one workspace between unrelated agents. A single persistent mount may contain both, but they remain separate logical state.

### Run the compiled binary directly

Create a production workspace containing only the four non-secret bundle files. Do not reuse a development workspace that still contains a populated `delta.env`:

```sh
mkdir -p runtime/workspace
cp my-agent/DELTA.md my-agent/POLICY.md my-agent/PROMPT_CONTEXT.md my-agent/vocab.json runtime/workspace/
```

Set real environment variables, then launch the daemon:

```sh
export PORT=8080
export DELTA_BIND=127.0.0.1
export DELTA_DB="$PWD/runtime/delta.db"
export DELTA_WORKSPACE="$PWD/runtime/workspace"
export DELTA_AGENT_ID=my-research-agent
export OPENROUTER_API_KEY=your-key
export DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5
export DELTA_CONTROL_TOKEN=replace-with-a-long-random-token
export DELTA_INSPECT_TOKEN=replace-with-a-different-long-random-token

./dist/delta
```

The direct defaults are `PORT=8080`, `DELTA_DB=data/delta.db`, and `DELTA_WORKSPACE=workspace`. The default bind is Bun's all-interface behavior, so set `DELTA_BIND` deliberately.

Check liveness and build identity:

```sh
curl -sS http://127.0.0.1:8080/healthz
```

```json
{"ok":true,"version":"0.1.0","build":"optional-commit"}
```

`build` appears only when `DELTA_BUILD` is set. This endpoint does not test the model, MCP servers, telemetry, or other dependencies. It is liveness and version metadata, not readiness.

### Run a production acceptance smoke

Use the gateway URL and the two distinct credentials provisioned on that agent. Replace `crm__get_dashboard` with one required, read-only MCP tool and include any arguments its policy expects. Run this on a placement with reflection off if the smoke must not create local memory or external proposals; request metadata cannot disable a daemon-wide `DELTA_REFLECT=1`.

```sh
export DELTA_URL=https://agent.example
export DELTA_CONTROL_TOKEN=run-api-token
export DELTA_INSPECT_TOKEN=separate-root-inspection-token

curl -fsS "$DELTA_URL/healthz"

SMOKE_RESPONSE="$(curl -fsS "$DELTA_URL/v1/responses" \
  -H "authorization: Bearer $DELTA_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"input":"Call crm__get_dashboard once using read-only smoke-test arguments, then report its result and the exact tool name."}')"

SMOKE_RUN_ID="$(SMOKE_RESPONSE="$SMOKE_RESPONSE" bun -e '
const response = JSON.parse(process.env.SMOKE_RESPONSE ?? "{}");
if (!response.id || response.status !== "completed") {
  console.error(JSON.stringify(response));
  process.exit(1);
}
process.stdout.write(response.id);
')"

curl -fsS "$DELTA_URL/v1/dev/config" \
  -H "authorization: Bearer $DELTA_INSPECT_TOKEN"

curl -fsS "$DELTA_URL/v1/dev/runs/$SMOKE_RUN_ID" \
  -H "authorization: Bearer $DELTA_INSPECT_TOKEN"
```

The status assertion matters because a terminal Delta failure is a valid Responses object returned with HTTP `200`; `curl -f` alone cannot detect it. In `/v1/dev/config`, verify the harness version and build, model route, `mcp_servers`, required names under `tools.mcp`, and credential-presence booleans. Inspect `/v1/dev/runs/$SMOKE_RUN_ID/calls` as an additional check when normalized successful-call capture is deliberately enabled.

Finally, verify that the collector received correlated run, model, and expected tool events for `SMOKE_RUN_ID`, with stable `event.id` values. Delta has no dependency-readiness endpoint, so provider, MCP, and telemetry verification must exercise those paths.

### Build and run the container

Build with optional commit provenance:

```sh
docker build \
  --build-arg DELTA_BUILD="$(git rev-parse HEAD)" \
  -t delta:local .
```

`DELTA_BUILD` is exact provenance only when the build context is a clean, immutable checkout of that commit. On a dirty tree it is merely a HEAD label and does not describe the changed bytes. The root `.dockerignore` allowlists only the Dockerfile, build metadata, source, Cockpit asset, and entrypoint, so credentials and unrelated workspace state are not sent to the builder.

The final image contains the compiled binary, CA certificates, `unzip` for lightweight document extraction, Litestream, and the entrypoint. It does not contain Bun or a coding CLI.

Seed the four non-secret bundle files on the first start:

```sh
DELTA_SELF_MD_B64="$(base64 < my-agent/DELTA.md | tr -d '\n')"
DELTA_POLICY_MD_B64="$(base64 < my-agent/POLICY.md | tr -d '\n')"
DELTA_CONTEXT_MD_B64="$(base64 < my-agent/PROMPT_CONTEXT.md | tr -d '\n')"
DELTA_VOCAB_JSON_B64="$(base64 < my-agent/vocab.json | tr -d '\n')"

export DELTA_SELF_MD_B64 DELTA_POLICY_MD_B64 DELTA_CONTEXT_MD_B64 DELTA_VOCAB_JSON_B64
```

Run with persistent `/data` and real API protection:

```sh
docker volume create delta-data

docker run -d \
  --name delta-agent \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file my-agent/delta.env \
  -e DELTA_DB=/data/delta.db \
  -e DELTA_WORKSPACE=/data/workspace \
  -e DELTA_CONTROL_TOKEN=replace-with-a-long-random-token \
  -e DELTA_INSPECT_TOKEN=replace-with-a-different-long-random-token \
  -e DELTA_SELF_MD_B64 \
  -e DELTA_POLICY_MD_B64 \
  -e DELTA_CONTEXT_MD_B64 \
  -e DELTA_VOCAB_JSON_B64 \
  -v delta-data:/data \
  delta:local
```

The entrypoint writes seed files only when the target does not exist. A later image or environment change does not overwrite an evolved `DELTA.md` or other workspace file. Malformed base64 is skipped with a warning, so startup can continue with a missing or neutral bundle; verify all four files after first boot. Explicit `/data` paths after `--env-file` prevent an edited local `delta.env` from relocating persistent state.

The container defaults are:

```text
PORT=8080
DELTA_DB=/data/delta.db
DELTA_WORKSPACE=/data/workspace
```

Persist the entire `/data` mount. Persisting only the database loses uploaded files, working artifacts, and the current self-file. Persisting only the workspace loses conversations, checkpoints, memory, events, and revisions.

The checked-in Dockerfile has no `USER` instruction, so the standard image runs as root. Before a production deployment, derive an image or set a runtime user with only the permissions Delta needs, and make sure that identity owns the persistent `/data` paths. The restart policy in this example is only a local Docker baseline; a production orchestrator or service manager must also supervise the process and its persistent volume.

### Add the coding tool to an image

The `code` tool degrades to a normal tool error when its executable is missing. Build a derived image when advanced coding is required:

```dockerfile
FROM delta:local

# Install the chosen coding CLI here, then run Delta as a dedicated user.
# Provision CLI authentication at runtime rather than baking it into the image.
```

Exact installation depends on the chosen CLI. Confirm that `DELTA_CODE_CLI` resolves inside the final image and that its home-directory credentials survive VM restarts without being baked into a public layer.

### Deploy on Fly Machines

`fly.toml.sample` is a topology example, not a one-command managed service. It describes:

- one agent per app or Machine
- one shared CPU
- 512 MB starting memory, to be load-tested against the real workload
- `/data` on a persistent volume
- health checks against `/healthz`
- no Fly Proxy service; a trusted private 6PN control plane or gateway owns access
- lifecycle owned by an external controller

Create an app-specific `fly.agent.toml` from this checked-in topology, replacing the app name and region:

```toml
app = "delta-<agent>"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  DELTA_BIND = "0.0.0.0"
  DELTA_DB = "/data/delta.db"
  DELTA_WORKSPACE = "/data/workspace"
  DELTA_AGENT_ID = "my-research-agent"
  DELTA_BUILD = "<source-commit>"
  DELTA_MODEL_PRIMARY = "anthropic/claude-sonnet-5"

[[mounts]]
  source = "delta_state"
  destination = "/data"

[checks]
  [checks.delta_health]
    type = "http"
    port = 8080
    method = "get"
    path = "/healthz"
    interval = "15s"
    timeout = "2s"
    grace_period = "5s"

[[vm]]
  memory = "512mb"
  cpus = 1
  cpu_kind = "shared"
```

Create the Fly app and a persistent volume named `delta_state` in the configured region. Provision the provider, control, inspection, MCP, and telemetry credentials as Fly secrets. On the first boot, also provide `DELTA_SELF_MD_B64`, `DELTA_POLICY_MD_B64`, `DELTA_CONTEXT_MD_B64`, and `DELTA_VOCAB_JSON_B64` from the bundle-seeding step above, or populate `/data/workspace` through another trusted provisioning path. Without a stable `DELTA_AGENT_ID` and those bundle files, the Machine starts a neutral daemon rather than the intended agent.

Deploy with `fly.agent.toml` after adapting the provider, region, tools, telemetry, and exact source commit. This private topology intentionally declares neither `[[services]]` nor `[http_service]`, so it does not create a direct Fly Proxy URL. A `[[services]]` block requires at least one `[[services.ports]]` entry; do not add an incomplete service merely to attach a health check. The top-level check reaches port 8080, and Delta must listen on `0.0.0.0` inside the Machine. Route access through the trusted private control plane, or add a deliberate public gateway using Fly's current service-port syntax. The repository sample does not automate app, volume, secret, gateway, or lifecycle provisioning. Never put secret values in the TOML file.

Because the sample has no Fly Proxy service, it has no proxy auto-start or auto-stop policy. Suspend and resume through an external lifecycle controller using the Machines API. That controller must gate new traffic and avoid stopping while `/v1/queue` reports queued or running work unless it deliberately accepts interruption and recovery. Enforce exactly one Machine for the volume, for example by deploying without high availability and asserting the invariant in the controller. A standalone deployment without that controller should keep the Machine running. Delta itself does not provision, suspend, or resume cloud infrastructure.

The 100 MB upload batch limit is not a streaming memory guarantee: multipart parsing buffers and copies request data. A 256 MB microVM can exhaust memory near the cap, especially with document extraction, coding CLIs, or subagents. Set a lower gateway upload limit or size and load-test the Machine for worst-case concurrent work.

### Back up SQLite with Litestream

The entrypoint uses Litestream when either of these is configured:

- a mounted `LITESTREAM_CONFIG`, default path `/etc/litestream.yml`
- a direct `LITESTREAM_REPLICA_URL`

Use this S3-compatible configuration. It gives the checked-in template's one-second replication, hourly snapshots, and seven-day retention:

```yaml
dbs:
  - path: ${DELTA_DB}
    replicas:
      - type: s3
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_S3_PATH}
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        region: ${AWS_REGION}
        access-key-id: ${AWS_ACCESS_KEY_ID}
        secret-access-key: ${AWS_SECRET_ACCESS_KEY}
        sync-interval: 1s
        snapshot-interval: 1h
        retention: 168h
```

Save it outside the image or use `etc/litestream.yml`. The image does not copy that file to `/etc/litestream.yml`, so mount it explicitly:

```text
-e LITESTREAM_CONFIG=/etc/litestream.yml
-e LITESTREAM_S3_BUCKET=your-bucket
-e LITESTREAM_S3_PATH=agents/my-agent
-e LITESTREAM_S3_ENDPOINT=https://your-s3-endpoint
-e AWS_REGION=auto
-e AWS_ACCESS_KEY_ID=your-key
-e AWS_SECRET_ACCESS_KEY=your-secret
-v "$PWD/etc/litestream.yml:/etc/litestream.yml:ro"
```

Add those options to the earlier `docker run` command. Keep the model, bundle seed, authentication, port, and `/data` volume options from that command.

For one genuine first boot against an empty replica, also add:

```text
-e DELTA_BOOTSTRAP=1
```

Recreate the container without that option as soon as the first database exists.

First-boot rules are intentionally strict:

1. If the local DB exists, Delta keeps it and Litestream starts replication.
2. If the DB is missing and a replica is configured, restore must succeed.
3. A genuine first boot against an empty replica must set `DELTA_BOOTSTRAP=1`.
4. Remove `DELTA_BOOTSTRAP=1` after the database exists.
5. If the volume is later lost while bootstrap remains enabled, the container starts blank instead of restoring.

`DELTA_BOOTSTRAP` has an effect only when backup is configured and the local database is absent. An existing local database always wins, even when a replica contains newer state. A restored stale volume can therefore start and replicate from stale local data. The entrypoint has no replication-freshness watchdog, and `/healthz` remains green if backup export has stalled. Monitor Litestream's last successful sync externally and alert on lag.

Litestream backs up only `DELTA_DB`. It does not back up the workspace, including the current `DELTA.md`, uploads, working files, spill files, or trash. Use volume snapshots, object-storage synchronization, or another file backup for `DELTA_WORKSPACE`. Complete recovery also needs the current rotating MCP refresh-token file when that feature is enabled; never restore a stale, already-spent token. Database, workspace, and refresh state have no coordinated point-in-time snapshot. For a consistent backup, quiesce new and active work before capturing them together, or define and test an ordering plus reconciliation procedure for database rows that refer to missing files.

### Upgrade and roll back

Delta runs SQLite migrations transactionally when opening the database. It records harness and schema versions and refuses to open a database whose schema is newer than the binary understands.

Before a production upgrade:

1. record `/healthz` version and `DELTA_BUILD`
2. confirm SQLite replication and workspace backup freshness
3. stop or suspend the single writer cleanly
4. take a database and workspace snapshot
5. deploy the pinned image digest
6. verify `/healthz`, a model request, required MCP tools, Cockpit access, and telemetry
7. monitor resumed runs and promotion failures

There is no automatic pre-migration snapshot. A rollback after a schema-changing release may require restoring the pre-upgrade database together with a compatible workspace snapshot.

## Security model

### Put a trusted gateway in front

Set both credentials in production:

```dotenv
DELTA_CONTROL_TOKEN=run-api-token
DELTA_INSPECT_TOKEN=separate-root-inspection-token
```

When `DELTA_CONTROL_TOKEN` is set, every `/v1/*` route except the separately gated `/v1/dev/*` routes requires `Authorization: Bearer <token>`. `/healthz` remains public and data-light.

The run API is a daemon seam for a trusted control plane, not a complete public multi-tenant API:

- task lookup and cancellation are ID-based, without per-user ownership checks
- `x-delta-user` is trusted only for queue projection
- the request JSON endpoints have no built-in body-size limit
- the daemon has no rate limiter
- one control token can drive every run on that daemon

The gateway should authenticate users, authorize every task and `previous_response_id`, inject one canonical user identity and the machine token, strip caller-supplied privileged metadata, cap request bodies and queue depth, rate limit, log access, and expose only required routes. It must construct review and widening claims from verified control-plane state. `POLICY.md` is model guidance and cannot replace these checks.

### Separate run access from root inspection

The inspect token grants access to transcripts, prompts, memory, configuration shape, files, and selected database state. It is intentionally different from the control token. Keep Cockpit writes off unless an authenticated operator needs them:

```dotenv
DELTA_INSPECT_WRITE=0
```

For hardened agents with no inspection requirement:

```dotenv
DELTA_INSPECT=off
```

Without an inspect token, `/v1/dev/*` is available only to the immediate loopback socket peer. A same-host proxy defeats the intended remote distinction unless it injects a token. The `/dev` application contains no embedded runtime data, but direct public access to it is still unnecessary when inspection is disabled.

### Treat the VM as the execution boundary

The built-in file tools are workspace-confined, and model-directed `code` and subagent processes receive a narrowed service-token environment. That does not make Delta a general untrusted-code sandbox:

- `read_file` can read workspace files, including a workspace `delta.env`
- the delegated coding CLI has every filesystem and process capability available to the daemon's OS user; only the CLI's own sandbox can narrow it
- stdio MCP servers are trusted local child processes and inherit the daemon environment plus their explicit `env` object
- HTTP MCP tools can perform whatever side effects their servers authorize
- subagents share the workspace

Run one agent under a dedicated OS identity or isolated VM. Keep provider, control, telemetry, and MCP credentials in the process environment or secret manager, not workspace files. Add a purpose-built sandbox if arbitrary generated code must be treated as hostile.

### Protect stored state

SQLite contains raw run requests, which can include `metadata.authToken`, plus messages, tool arguments and results, memory, and optional normalized call captures. Cockpit projections redact on read, but the database and its replica retain the original bytes.

Use short-lived user tokens, encrypted storage, restricted backup credentials, and an explicit retention policy. Do not enable call capture by default in production. Remember that Litestream copies the sensitive database to the replica.

### Network protections

`web_fetch` blocks private, loopback, link-local, and cloud-metadata destinations and revalidates redirects. Keep that protection on in production. Validation and the actual fetch perform separate DNS resolution, so a hostile hostname can still attempt a public-to-private DNS rebinding between them. Use network egress controls when SSRF is a hard security boundary. `DELTA_FETCH_ALLOW_PRIVATE=1` is an explicit local-development escape hatch and lets model-driven fetches reach private services.

Subscription model tokens are sent only to exact HTTPS hosts in `DELTA_BROKER_ALLOWED_HOSTS`. Static `MODEL_HEADERS` cannot override authentication or protocol headers. MCP HTTP authorization can be replaced per run, so the MCP service must validate token audience and scope.

That broker route is the exception. Static model credentials sent to `MODEL_BASE_URL`, static and per-run MCP credentials, rotating MCP refresh credentials, scheduling control tokens, and telemetry credentials do not receive an equivalent harness-enforced HTTPS host allowlist. Treat every configured endpoint as trusted operator input, require validated HTTPS outside local development, and apply outbound allowlists where credentials are valuable. Be especially careful with `TELEMETRY_URL` because it can fall back to the production control token.

## Configuration reference

The values below are the current public operating surface. Unless noted otherwise, changing them requires a daemon restart.

### Process, identity, and state

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port. `delta dev` replaces it with the selected port. |
| `DELTA_BIND` | all interfaces | Bind host. `delta dev` defaults it to `127.0.0.1`. |
| `DELTA_DB` | `data/delta.db` | SQLite path. Container default is `/data/delta.db`. |
| `DELTA_WORKSPACE` | `workspace` | Agent bundle and working-file root. Container default is `/data/workspace`. |
| `DELTA_AGENT_ID` | unset | Stable identity for memory and telemetry. Set it in every real deployment. |
| `DELTA_BUILD` | unset | Build or commit identifier returned by `/healthz`. |
| `DELTA_LEASE_HOLDER` | `FLY_MACHINE_ID`, then hostname | Override the machine-scoped writer identity. Usually leave unset. |
| `DELTA_LEASE_TTL_MS` | `30000` | Writer lease TTL, clamped to at least 5 seconds. |

### Primary model

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_MODEL_PRIMARY` | `anthropic/claude-sonnet-5` | Primary model. Deprecated alias: `DELTA_MODEL`. |
| `DELTA_MODEL_FALLBACKS` | empty | Comma-separated model fallback list on the primary endpoint. |
| `MODEL_BASE_URL` | `https://openrouter.ai/api/v1` | Provider base URL, without the final API path. |
| `MODEL_API_KEY` | unset | Primary provider key. Falls back to `OPENROUTER_API_KEY`. |
| `OPENROUTER_API_KEY` | unset | OpenRouter key and primary-key fallback. |
| `MODEL_API` | compatible chat | `anthropic` or `responses`; any other value uses `/chat/completions`. |
| `MODEL_HEADERS` | unset | JSON object of non-reserved static request headers. |
| `DELTA_REASONING_EFFORT` | provider default | Main-model reasoning effort. Request metadata can override it. |
| `DELTA_UTILITY_MODEL` | `anthropic/claude-haiku-4.5` | Model for compaction, reflection, and judging. Empty uses the main cascade. |
| `DELTA_MODEL_PRICES` | built-in table | JSON map of model prices per million input, output, and cache-read tokens. |
| `DELTA_PROVIDERS` | empty | JSON array of fallback provider objects. |
| `DELTA_MODEL_TIMEOUT_MS` | `600000` | Absolute model-call ceiling. |
| `DELTA_STREAM_IDLE_MS` | `60000` | Abort a model stream after this long without a network chunk. `0` disables. |
| `DELTA_VISION` | auto | `1` forces vision support; `0` disables it. |
| `DELTA_VISION_MODELS` | built-in regex | Custom regular expression for automatic vision detection. |

`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are not read automatically as the primary key. Put the chosen value in `MODEL_API_KEY`, or reference another key with `apiKeyEnv` inside `DELTA_PROVIDERS`.

### Codex subscription broker

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_BROKER_TOKEN_URL` | unset | HTTPS endpoint that mints a short-lived Codex bearer. Deprecated alias: `DELTA_BROKER_MINT_URL`. |
| `DELTA_BROKER_AUTH` | unset | Bearer sent to the broker endpoint. |
| `DELTA_BROKER_ALLOWED_HOSTS` | `chatgpt.com` | Comma-separated exact hosts allowed to receive subscription tokens. |

### Tools, MCP, and context

| Variable | Default | Purpose |
|---|---|---|
| `EXA_API_KEY` | unset | Enables `web_search`. |
| `DELTA_FETCH_ALLOW_PRIVATE` | off | `1` allows `web_fetch` to private addresses. Local development only. |
| `DELTA_CODE_CLI` | Codex command | Space-separated coding CLI command. No shell parsing is performed. |
| `DELTA_SUBAGENT_DEPTH` | `0` | Internal depth guard. Top-level agents should keep `0`. |
| `DELTA_MCP_SERVERS` | `[]` | JSON array of HTTP or stdio MCP servers. |
| `DELTA_MCP_REFRESH_URL` | unset | Rotating MCP token endpoint. |
| `DELTA_MCP_REFRESH_FILE` | unset | Persistent refresh-token file. |
| `DELTA_MCP_REFRESH_SERVER` | unset | Name of the HTTP MCP server receiving the rotating credential. |
| `DELTA_MCP_REFRESH_TOKEN` | unset | Optional first-boot refresh token. |
| `DELTA_MCP_REFRESH_CLIENT_ID` | `delta-agent` | Refresh client ID. |
| `DELTA_HYDRATE_TOOLS` | empty | Comma-separated product read tools called at first session run. |
| `DELTA_HYDRATE_SEARCH_TOOL` | unset | Task-keyed knowledge search tool. Requires per-run user auth. |
| `DELTA_CAPABILITY_SEARCH_K` | `5` | Number of capability references surfaced per run, capped internally. |
| `DELTA_TOOL_TIMEOUT_MS` | `120000` | Outer ordinary-tool timeout. `0` removes it; queued search and fetch then have no separate fallback ceiling. MCP and scheduling keep internal ceilings. |
| `DELTA_TOOL_RESULT_MAX_BYTES` | `20000` | Inline character cap before a full result spills to disk. |

### Identity, policy, and learning

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_SELF_MAX_TOKENS` | `800` | `DELTA.md` budget. Prompt loading estimates JavaScript characters times four; writes estimate UTF-8 bytes times four, so non-ASCII limits can differ. |
| `DELTA_POLICY_MAX_TOKENS` | `800` | Maximum custom `POLICY.md`; overflow fails boot. |
| `DELTA_VOCAB` | file or neutral | JSON vocabulary override with precedence over `vocab.json`. |
| `DELTA_REFLECT` | off | `1` enables post-success reflection by default. |
| `DELTA_MEMORY_NAMESPACE` | derived | Stable product namespace for local memory and promotion. |
| `DELTA_PROMOTE_MIN_RUNS` | `2` | Distinct self-reflection occurrences before shared promotion. |
| `DELTA_PROMOTE_CLAIM_TTL_MS` | `60000` | Reclaim timeout for a stuck promotion claim. |

### Profiles, context, and retention

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_PROFILE` | `work` | Placement ceiling. Validate exactly `work` or `chat`; another value currently widens to `work`. |
| `DELTA_MAX_TOKENS` | profile value | Optional lower fresh-token cap. |
| `DELTA_MAX_COST_USD` | profile value | Optional lower model-cost cap. |
| `DELTA_COMPACT_AT_TOKENS` | `120000` | Previous-input threshold for automatic compaction. |
| `DELTA_RETENTION_MS` | 7 days | Event and tool-journal age limit. With telemetry active, the ordinary event sweep is skipped. |
| `DELTA_RETENTION_MAX_EVENTS` | `50000` | Event row cap when the local sweep owns events. |
| `DELTA_RETENTION_MAX_JOURNAL` | `50000` | Tool-journal row cap. |
| `DELTA_RETENTION_SWEEP_MS` | `3600000` | Periodic sweep interval. `0` disables periodic, not boot, sweep. |

### API, Cockpit, scheduling, and telemetry

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_CONTROL_TOKEN` | unset | Bearer for run-driving `/v1/*` routes and scheduling. |
| `DELTA_CONTROL_URL` | unset | External control-plane base URL; enables scheduling tools with the token. |
| `DELTA_INSPECT_TOKEN` | unset | Separate bearer for `/v1/dev/*`; otherwise loopback-only. |
| `DELTA_INSPECT_WRITE` | off | `1` enables Cockpit edits and self-file revert. `delta dev` enables it. |
| `DELTA_INSPECT` | on | `off` removes `/dev` and every `/v1/dev/*` route. |
| `DELTA_CAPTURE_CALLS` | off | `1` stores normalized successful main-loop model request and response captures. `delta dev` enables it. |
| `TELEMETRY_URL` | unset | NDJSON collector URL. |
| `TELEMETRY_TOKEN` | control token fallback | Dedicated collector bearer. |
| `DELTA_CAPTURE_PAYLOADS` | off | `1` keeps model and tool event attributes in export. It does not add full payloads. |

### Container backup and bundle seeding

| Variable | Default | Purpose |
|---|---|---|
| `LITESTREAM_CONFIG` | `/etc/litestream.yml` | Explicit config path. A set but missing path fails startup. |
| `LITESTREAM_REPLICA_URL` | unset | Direct Litestream replica alternative. |
| `DELTA_BOOTSTRAP` | off | With backup configured and no local DB, `1` permits a fresh DB instead of requiring restore. Use only for genuine first boot. |
| `DELTA_SELF_MD_B64` | unset | First-boot `DELTA.md` seed. |
| `DELTA_POLICY_MD_B64` | unset | First-boot `POLICY.md` seed. |
| `DELTA_CONTEXT_MD_B64` | unset | First-boot `PROMPT_CONTEXT.md` seed. |
| `DELTA_VOCAB_JSON_B64` | unset | First-boot `vocab.json` seed. |

The checked-in Litestream template also expects `LITESTREAM_S3_BUCKET`, `LITESTREAM_S3_PATH`, `LITESTREAM_S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

Configuration validation is intentionally uneven in the current runtime. Invalid or reserved `MODEL_HEADERS` and an invalid vision regular expression fail startup. Malformed model-price JSON falls back, while negative prices are accepted. Many positive count settings are floored or clamped to at least one, the lease TTL is clamped to five seconds, and a zero retention sweep disables only periodic work. Other numeric values use raw JavaScript `Number` conversion with limited range validation. Empty exported budget values become zero. Validate the full environment against an operator-owned schema before launching production.

Removed bundle variables are ignored with a migration warning: `DELTA_PLAYBOOK_FILE`, `DELTA_STEERING_FILE`, `DELTA_CHARTER_FILES`, `DELTA_CHARTER_TOOL`, `DELTA_PLAYBOOK_MAX_TOKENS`, and `DELTA_STEERING_MAX_TOKENS`. Move their content or limits to the fixed files and current variables shown above rather than relying on those names.

## Production checklist

Before serving real work:

- [ ] Assign one stable `DELTA_AGENT_ID`.
- [ ] Keep one daemon, one database, and one workspace per agent.
- [ ] Prevent a second same-host process from opening that database, even on another port.
- [ ] Enforce one live Machine or volume owner outside the best-effort writer lease.
- [ ] Use a persistent volume for both database and workspace.
- [ ] Seed all four non-secret bundle files before the first container or Fly run.
- [ ] Set `DELTA_CONTROL_TOKEN` and put a trusted gateway in front.
- [ ] Have the gateway authorize task and prior-response ownership, inject `user_id`, and strip all caller-supplied privileged metadata.
- [ ] Set a different `DELTA_INSPECT_TOKEN`, or set `DELTA_INSPECT=off`.
- [ ] Keep `DELTA_INSPECT_WRITE` and `DELTA_CAPTURE_CALLS` off unless explicitly needed.
- [ ] Configure a real provider fallback for long-running production work.
- [ ] Add exact pricing for every non-OpenRouter model used by a dollar budget.
- [ ] Verify that every provider and child route reports usage; treat budgets as tracked-model loop guards, not total spend caps.
- [ ] Validate `DELTA_PROFILE`, budgets, prices, headers, regular expressions, and every numeric setting before launch.
- [ ] Give MCP calls the least privilege and use per-run user tokens where required.
- [ ] Validate MCP discovery, framing, result shapes, and rotating-token persistence against the actual server.
- [ ] Validate every model, MCP, refresh, control, and telemetry endpoint as trusted HTTPS.
- [ ] Name mutating MCP tools without read-like underscore or dot segments.
- [ ] Review `POLICY.md` and verify the product's human-review rail end to end.
- [ ] Verify that `vocab.json` matches real MCP names and schemas.
- [ ] Test workspace path, upload, image, and document behavior with production-like files.
- [ ] Size or cap upload memory and queue depth at the gateway.
- [ ] Install and authenticate the coding CLI only if the agent needs it.
- [ ] Run the container as a dedicated non-root identity with writable persistent paths.
- [ ] Test one subagent task if delegation is part of the agent design.
- [ ] Send telemetry only to a validated HTTPS endpoint and deduplicate event IDs.
- [ ] Classify recall and error attributes as potentially sensitive, and monitor exporter backlog and age externally.
- [ ] Back up SQLite and the workspace separately.
- [ ] Quiesce or reconcile unmatched database, workspace, and rotating refresh-token snapshots.
- [ ] Remove `DELTA_BOOTSTRAP=1` after first boot.
- [ ] Put body limits, rate limits, user authorization, and task ownership at the gateway.
- [ ] Set journal retention longer than the longest possible run.
- [ ] Gate new work and check queue activity before planned stop or cloud suspension.
- [ ] Test a kill and restart during a tool-using task, then verify recovery behavior.
- [ ] Record the image digest, harness version, schema version, and build commit.

## Troubleshooting

### `delta send` cannot connect

`delta dev` chooses a free port unless `--port` is supplied. Read the launcher output and pass that port to `delta send`. The CLI always connects to localhost.

The default async `delta send` creates work through the control API and then tails the inspection stream. A gated daemon therefore needs both `DELTA_CONTROL_TOKEN` and `DELTA_INSPECT_TOKEN` in the CLI process. `delta send --json` needs only the control token. `delta watch` needs the inspect token. None of these clients loads the bundle's `delta.env` automatically.

### The daemon has no usable model credential

For the primary provider, use `MODEL_API_KEY` or `OPENROUTER_API_KEY`. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are not primary-key aliases. Confirm that the direct daemon actually received the variables, because only `delta dev` loads `delta.env`.

### Direct Anthropic or Responses calls hit the wrong path

Set `MODEL_BASE_URL` to the versioned base, such as `https://api.anthropic.com/v1` or `https://api.openai.com/v1`. Delta appends `/messages`, `/responses`, or `/chat/completions`.

### An MCP server or tool is missing

Check that `DELTA_MCP_SERVERS` is valid JSON and every entry has an explicit `transport`. Malformed JSON silently behaves like an empty array. Restart the daemon after changes. Read boot logs for the server-specific connection failure. Confirm that the combined `<server>__<tool>` name uses only letters, numbers, underscores, and hyphens and fits within 128 characters.

If the tool is connected but not initially visible, ask the model to use `search_tools`, or add its exact suffix to `vocab.coreVerbs`.

### A bundle edit has no effect

`POLICY.md`, `vocab.json`, all of `PROMPT_CONTEXT.md`, provider config, and MCP config require restart. `DELTA.md` changes apply to the next run. An existing session still carries prior conversation history, so start a new thread when testing a changed identity.

### `POLICY.md` prevents startup

A custom policy over `DELTA_POLICY_MAX_TOKENS` is a fatal configuration error. Trim it or deliberately increase the budget. Delta never truncates fixed rules.

### The `code` tool returns an executable error

The standard container does not include Codex or Claude Code. Install the selected CLI, confirm it is on `PATH`, set `DELTA_CODE_CLI`, and provision its home-directory authentication. Delta does not parse shell quoting, so use an executable path and arguments without spaces.

### A subagent cannot call the model or tools

Children have a restricted environment and do not inherit MCP, Exa, broker, telemetry, control, or fallback-provider secrets. A broker-only parent cannot currently power a child through its broker credential. Give the parent a supported static primary key, or avoid subagent delegation for that deployment.

If the child reaches the provider but selects the wrong model, set `DELTA_MODEL` to the same value as `DELTA_MODEL_PRIMARY`. The current child environment forwards the legacy name only. Routes that require `MODEL_HEADERS` are not reproducible in a child, and child usage does not use a parent `DELTA_MODEL_PRICES` override.

### A second local daemon opens the same bundle

Stop it immediately. Two processes on the same host share the default lease-holder identity, and different ports bypass the port-bind collision. Never run two `delta dev` commands against one bundle. Keep exactly one process per database and workspace.

### The production Cockpit loads but shows no data

The application asset contains no embedded runtime data, but its API calls need the inspect bearer, which the page does not attach itself. Use a trusted same-origin proxy that authenticates the operator and injects the correct inspect and control tokens. A `403` without an inspect token usually means the client is not loopback. A `404` can mean `DELTA_INSPECT=off`.

### Usage cost stays at zero

OpenRouter can report cost directly. Other paths use Delta's price table. Add the served model ID to `DELTA_MODEL_PRICES`, including input, output, and cache-read dollars per million tokens. If tokens also remain zero, the compatible endpoint may be omitting usage; do not rely on token or dollar caps until that route reports it correctly.

### A run reports an interrupted tool

The daemon restarted after arming a non-idempotent call but before recording its result. The tool may or may not have committed its side effect. Inspect the external system and the tool journal before retrying.

### A timed-out tool may still be running

Delta races the configured timeout and tells signal-aware asynchronous tools to abort. A tool that ignores the signal may continue detached, while synchronous blocking work cannot be preempted at all. Verify its outcome before another mutation.

### Telemetry does not arrive in an OTLP collector

Delta sends a custom newline-delimited JSON schema with a subset of GenAI-inspired fields, not OTLP. Point it at a compatible ingestion route or translate the records at the collector boundary.

### The container restores or starts incorrectly

If a backup is configured and the local DB is absent, restore must succeed unless `DELTA_BOOTSTRAP=1`. Use bootstrap only for the initial empty replica, then remove it. A missing explicitly configured Litestream file is fatal. An existing local DB always wins even if stale. Workspace and rotating MCP refresh-token recovery are separate from Litestream.

### An older binary refuses the database

The database schema is newer than the binary's migrations. Do not force it open. Deploy a compatible binary or restore a database snapshot taken before the schema upgrade.

## Current boundaries

These are deliberate truths of the current codebase:

- The repository builds `dist/delta`; it does not yet publish a package installer or shell install command.
- Human-review rails are prewired through policy, vocabulary, MCP, and reflection. Delta does not include a universal approval backend or UI.
- `delta send` and `delta watch` are localhost-only clients; `delta dev` is a local launcher, not remote attachment.
- MCP configuration, policy, vocabulary, and all prompt context do not hot-reload.
- The writer lease blocks different machine identities but is not a same-machine mutex when processes use different ports.
- A Fly sample exists, but cloud provisioning and suspend or resume lifecycle remain external control-plane work.
- Litestream protects SQLite only. The workspace needs its own backup.
- The run API needs a trusted gateway for end-user authentication, authorization, body limits, and rate limits.
- Task, response, session, metadata identity, and review claims have no built-in tenant-ownership enforcement.
- `/healthz` is liveness and version metadata, not dependency readiness.
- Captured calls, conversations, and most database tables are not automatically age-pruned.
- Captured calls are normalized successful main-loop calls, not raw provider traffic or complete internal-call traces.
- Root inspection can directly address hidden workspace `.delta` paths; its token is root-equivalent and writes can corrupt live state.
- Token and dollar budgets cover recorded model usage only and can overshoot by one call plus background work.
- An invalid daemon `DELTA_PROFILE` currently falls open to `work`; deployment validation must reject it.
- Four workers bound queued sessions, not sibling tools or untracked background reflections.
- Shutdown does not drain tasks, reflection, or telemetry, and long-lived SSE endpoints do not impose production backpressure.
- Events are operational, at-least-once observability rather than a transactionally complete audit ledger.
- Subagents share the workspace and receive a restricted provider and tool environment.
- Subagent model forwarding uses the legacy `DELTA_MODEL` name and omits parent headers, custom prices, and reasoning configuration.
- `eval_n` is not safe for concurrent edits to shared files.
- Exported model and tool events omit attributes unless `DELTA_CAPTURE_PAYLOADS=1`.
- Bundled promotion adapters do not guarantee remote idempotency, and retry drain depends on a later reflected run.
- Task-start hydration and capability lookup can outlive their 20-second wait and bypass the ordinary tool journal.
- Reflection is best-effort background work with no durable reflection queue.
- The standard container runs as root unless the deployment overrides it.
- `store` is accepted for compatibility but does not turn off durable state.

Within those boundaries, Delta gives a small bundle a capable execution core: start with one request, inspect the durable main loop, add the tools and learning rails the work needs, and keep the result understandable all the way to production.
