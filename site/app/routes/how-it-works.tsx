import { useEffect } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/how-it-works.css";

const canonicalUrl = "https://deltaharness.dev/how-it-works";
const pageTitle = "How Delta works — the agent runtime, end to end";
const socialTitle = "How a Delta agent works.";
const description =
  "A visual crash course on the Delta agent runtime: the run loop, the sub-2k-token spine, tools and the seam, context management, full-rights subagents, memory, and durability.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "article" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:title", content: socialTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: socialTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
  ];
}

export default function HowItWorks() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="hiw" tabIndex={-1}>
        {/* ---- HERO ---- */}
        <section className="section hiw-hero-sec" id="top">
          <div className="page">
            <span className="hiw-badge">
              <span className="hiw-dot" /> Delta runtime &nbsp;·&nbsp;{" "}
              <b>@carrara-labs/delta-harness</b> &nbsp;·&nbsp; v0.2.0 live on npm
            </span>
            <h1 className="hiw-h1">
              How a <span style={{ color: "var(--sage)" }}>△</span> Delta agent works
            </h1>
            <p className="hiw-sub">
              A Delta is the thin, fast, cache-friendly loop that turns a model into a working agent
              — one that does real work through tools, remembers what it learns, and runs for hours
              without choking. <em>Echoes think; Deltas do.</em>
            </p>
            <div className="hiw-eq">
              <span className="hiw-chip strong">
                <span className="k">agent</span>
              </span>
              <span className="hiw-plus">=</span>
              <span className="hiw-chip">
                <span className="k">engine</span> the loop
              </span>
              <span className="hiw-plus">+</span>
              <span className="hiw-chip">
                <span className="k">bundle</span> 5 config files
              </span>
              <span className="hiw-plus">+</span>
              <span className="hiw-chip">
                <span className="k">state</span> SQLite&nbsp;+&nbsp;workspace
              </span>
            </div>
          </div>
        </section>

        {/* ---- 1 ANATOMY ---- */}
        <section className="section" id="anatomy">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">01 · Anatomy</p>
                <h2 className="section-heading">Three parts, cleanly separated</h2>
              </div>
              <p className="section-intro">
                One idea carries the whole design: the code is generic, the agent is data. Change
                the bundle and you change the agent without touching a line of code.
              </p>
            </header>

            <div className="hiw-grid hiw-g3 hiw-block">
              <div className="hiw-card">
                <span className="hiw-tag">the engine</span>
                <h3>
                  <span className="hiw-ic">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path d="M12 3v18M3 12h18" />
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  </span>
                  The loop
                </h3>
                <p>
                  A budget-capped turn loop with a sub-2k-token spine. Owns almost nothing itself —
                  memory, skills, code, and review live behind adapters it composes.
                </p>
              </div>
              <div className="hiw-card">
                <span className="hiw-tag">the bundle</span>
                <h3>
                  <span className="hiw-ic clay">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path d="M4 5h16v14H4z" />
                      <path d="M4 9h16M9 9v10" />
                    </svg>
                  </span>
                  5 config files
                </h3>
                <p>
                  Backends &amp; budgets, the write rail, a living self-file, a fixed contract, and
                  dynamic vars. Swap them → a different agent on the same engine.
                </p>
              </div>
              <div className="hiw-card">
                <span className="hiw-tag">the state</span>
                <h3>
                  <span className="hiw-ic">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <ellipse cx="12" cy="6" rx="8" ry="3" />
                      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
                      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
                    </svg>
                  </span>
                  Durable state
                </h3>
                <p>
                  SQLite in WAL mode plus the on-disk workspace — checkpointed every turn, so a
                  crash resumes exactly where it stopped.
                </p>
              </div>
            </div>

            {/* 1a ENGINE */}
            <div className="hiw-detail">
              <div className="hiw-detail-head">
                <span className="lbl">1a · the engine</span>
                <h3>A conductor that owns almost nothing</h3>
              </div>
              <p className="hiw-p">
                The engine ships as one <code>bun build --compile</code> binary — under 10ms cold
                start, zero runtime dependencies until one earns its place. It is deliberately
                small: a sub-2k-token spine, a turn loop, compaction, budgets, and durability. It
                holds no product logic and no vendor lock-in. The intelligence it needs, it{" "}
                <b>composes through adapters</b> rather than building in:
              </p>
              <div className="hiw-adapters">
                <div className="hiw-adapter">
                  <div className="from">
                    <span className="a">▶</span> memory
                  </div>
                  <div className="to">
                    a knowledge base, reached over MCP — not a local vector store
                  </div>
                </div>
                <div className="hiw-adapter">
                  <div className="from">
                    <span className="a">▶</span> skills
                  </div>
                  <div className="to">a skill library the agent retrieves from per task</div>
                </div>
                <div className="hiw-adapter">
                  <div className="from">
                    <span className="a">▶</span> code
                  </div>
                  <div className="to">delegated coding CLIs, run in the workspace</div>
                </div>
                <div className="hiw-adapter">
                  <div className="from">
                    <span className="a">▶</span> review
                  </div>
                  <div className="to">the propose → approve rail — a human dispositions writes</div>
                </div>
              </div>
              <p className="hiw-p" style={{ marginTop: 16 }}>
                Because it is product-neutral, the same binary runs any agent — a meeting processor,
                a research assistant, an operations bot — differing only by bundle. Upgrades only
                ever move a database forward (migrations are additive and transactional), and a
                newer-schema database is refused by an older binary rather than corrupted. And
                nothing crashes it: a provider or tool failure returns a clean turn —{" "}
                <em>error-as-value</em>.
              </p>
            </div>

            {/* 1b BUNDLE */}
            <div className="hiw-detail">
              <div className="hiw-detail-head">
                <span className="lbl">1b · the bundle</span>
                <h3>Markdown owns the meaning</h3>
              </div>
              <p className="hiw-p">
                The binary owns the <em>mechanism</em>; these five files (fixed names, scaffolded by{" "}
                <code>delta init</code>) own the <em>meaning</em>. Two are the agent's mind — one
                writable by the agent, one fixed by its operator — and three wire it to the world.
              </p>
              <div className="hiw-files">
                <div className="hiw-file">
                  <span className="fn">DELTA.md</span>
                  <span className="hiw-mut write">agent-writable</span>
                  <span className="role">
                    <b>The living self.</b> Identity plus a <code>## Learned</code> section the
                    agent rewrites with <span className="hiw-kbd">remember</span>. Every edit is
                    snapshotted and revertible; a run reads an immutable snapshot, so a self-edit
                    takes effect next run.
                  </span>
                </div>
                <div className="hiw-file">
                  <span className="fn">POLICY.md</span>
                  <span className="hiw-mut fixed">operator-fixed</span>
                  <span className="role">
                    <b>The contract.</b> Non-overridable operating rules, rendered <em>last</em> in
                    the spine so nothing above — or any task instruction — can contradict them.
                  </span>
                </div>
                <div className="hiw-file">
                  <span className="fn">vocab.json</span>
                  <span className="hiw-mut">config</span>
                  <span className="role">
                    <b>The write rail.</b> Maps the agent's neutral "propose" verb onto a concrete
                    product action (its noun, shape, and the subjects it scopes to) — the seam that
                    lets one engine serve different products.
                  </span>
                </div>
                <div className="hiw-file">
                  <span className="fn">delta.env</span>
                  <span className="hiw-mut">config</span>
                  <span className="role">
                    <b>Backends &amp; budgets.</b> Providers and keys, plus the knobs: token / cost
                    ceilings, the compaction threshold, reasoning effort, the run profile.
                  </span>
                </div>
                <div className="hiw-file">
                  <span className="fn">PROMPT_CONTEXT.md</span>
                  <span className="hiw-mut">config</span>
                  <span className="role">
                    <b>Dynamic vars.</b> Values resolved per run — <code>{"{{model}}"}</code>,{" "}
                    <code>{"{{now.*}}"}</code>, <code>{"{{request.*}}"}</code>. A{" "}
                    <code>## Stable</code> block is boot-cached so it rides the spine's cached
                    prefix.
                  </span>
                </div>
              </div>
              <div className="hiw-callout clay" style={{ marginTop: 16 }}>
                <span className="k">why it matters</span>
                <p>
                  A new agent is a new bundle, not a new build. The same reviewed, battle-tested
                  engine backs every agent in the fleet — so a fix to the loop, compaction, or
                  subagents lands everywhere at once.
                </p>
              </div>
            </div>

            {/* 1c STATE */}
            <div className="hiw-detail">
              <div className="hiw-detail-head">
                <span className="lbl">1c · the state</span>
                <h3>What persists, and what gets wiped</h3>
              </div>
              <p className="hiw-p">
                State lives in two places — a local SQLite database and the on-disk workspace — and
                splits along a second axis that matters for privacy: what belongs to{" "}
                <em>one run</em> versus what carries <em>across runs</em>.
              </p>
              <div className="hiw-state">
                <div className="hiw-card">
                  <h3>
                    <span className="hiw-ic">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                      >
                        <ellipse cx="12" cy="6" rx="8" ry="3" />
                        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
                      </svg>
                    </span>
                    In SQLite (WAL)
                  </h3>
                  <p className="hiw-tree">
                    <b>sessions</b> <span className="c">threads of work</span>
                    {"\n"}
                    <b>turns</b> <span className="c">every step, replayable</span>
                    {"\n"}
                    <b>checkpoints</b> <span className="c">committed each turn</span>
                    {"\n"}
                    <b>messages</b> · <b>calls</b> · <b>journal</b>
                  </p>
                  <p className="hiw-p" style={{ marginTop: 12, marginBottom: 0, fontSize: 13.5 }}>
                    The WAL commits after every turn, so a killed process resumes at the last
                    committed turn — nothing lost, nothing double-run.
                  </p>
                </div>
                <div className="hiw-card">
                  <h3>
                    <span className="hiw-ic">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                      >
                        <path d="M3 7h6l2 2h10v11H3z" />
                      </svg>
                    </span>
                    On disk (workspace)
                  </h3>
                  <p className="hiw-tree">
                    <b>DELTA.md</b> <b>POLICY.md</b> <span className="c">…the bundle</span>
                    {"\n"}
                    <b>scratch/</b> <span className="c">per-run working files</span>
                    {"\n"}
                    <b>.delta/spill/</b> <span className="c">big tool results</span>
                    {"\n"}
                    <b>research/</b> <span className="c">subagent artifacts</span>
                  </p>
                  <p className="hiw-p" style={{ marginTop: 12, marginBottom: 0, fontSize: 13.5 }}>
                    Large tool results and subagent findings land here as files the agent can{" "}
                    <span className="hiw-kbd">recall</span> or{" "}
                    <span className="hiw-kbd">read_file</span> later.
                  </p>
                </div>
              </div>
              <div className="hiw-callout" style={{ marginTop: 16 }}>
                <span className="k">per-run vs cross-run</span>
                <p>
                  An <b>ephemeral</b> run (<code>store: false</code>) purges its turn content —
                  transcript, messages, spill, scratch — the moment it finishes, leaving no trace of
                  what it processed. What survives is deliberately narrow: the agent's{" "}
                  <b>learnings</b>, its <b>self-file revisions</b>, and thread state. Abstracted
                  lessons persist; the raw material doesn't. The wipe trigger is <em>forget</em>,
                  not end-of-run.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 2 RUN LOOP ---- */}
        <section className="section" id="run-loop">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">02 · The run loop</p>
                <h2 className="section-heading">Turns, not timers</h2>
              </div>
              <p className="section-intro">
                Every turn re-assembles a fresh request, calls the model, runs tools, then
                checkpoints — repeating until the agent is done or a budget runs out.
              </p>
            </header>
            <p className="hiw-lede hiw-block">
              Independent tool calls go out in parallel. Wall-clock never caps a run; a task can
              legitimately take minutes. The budget — steps, fresh tokens, or dollars — is the only
              ceiling, and hitting it finalizes the run cleanly instead of crashing.
            </p>

            <div className="hiw-panel hiw-scroll hiw-block">
              <svg
                className="hiw-dia"
                viewBox="0 0 960 250"
                role="img"
                aria-label="The Delta run loop: assemble spine, call the model, run tools, checkpoint, repeat until done or budget"
              >
                <title>The Delta run loop</title>
                <defs>
                  <marker
                    id="hiwah"
                    markerWidth={10}
                    markerHeight={10}
                    refX={7}
                    refY={3}
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="var(--sage)" />
                  </marker>
                </defs>
                <rect className="svg-box" x={14} y={64} width={168} height={72} rx={12} />
                <text className="svg-t" x={30} y={94}>
                  assemble
                </text>
                <text className="svg-td" x={30} y={112}>
                  spine + history +
                </text>
                <text className="svg-td" x={30} y={126}>
                  tool schemas
                </text>

                <rect className="svg-box-accent" x={222} y={64} width={150} height={72} rx={12} />
                <text className="svg-t" x={238} y={94}>
                  model call
                </text>
                <text className="svg-td" x={238} y={112}>
                  sub-first,
                </text>
                <text className="svg-td" x={238} y={126}>
                  OpenRouter backup
                </text>

                <rect className="svg-box" x={412} y={64} width={168} height={72} rx={12} />
                <text className="svg-t" x={428} y={94}>
                  run tools
                </text>
                <text className="svg-td" x={428} y={112}>
                  parallel calls,
                </text>
                <text className="svg-td" x={428} y={126}>
                  error-as-value
                </text>

                <rect className="svg-box" x={620} y={64} width={168} height={72} rx={12} />
                <text className="svg-t" x={636} y={94}>
                  checkpoint
                </text>
                <text className="svg-td" x={636} y={112}>
                  SQLite WAL,
                </text>
                <text className="svg-td" x={636} y={126}>
                  resume-safe
                </text>

                <rect className="svg-box-accent" x={828} y={64} width={118} height={72} rx={12} />
                <text className="svg-t" x={844} y={94}>
                  done?
                </text>
                <text className="svg-td" x={844} y={112}>
                  or budget
                </text>
                <text className="svg-td" x={844} y={126}>
                  exhausted
                </text>

                <path className="svg-flow" d="M182 100 H218" markerEnd="url(#hiwah)" />
                <path className="svg-flow" d="M372 100 H408" markerEnd="url(#hiwah)" />
                <path className="svg-flow" d="M580 100 H616" markerEnd="url(#hiwah)" />
                <path className="svg-flow" d="M788 100 H824" markerEnd="url(#hiwah)" />
                <path
                  className="svg-flow svg-dash"
                  d="M887 136 V192 H98 V136"
                  markerEnd="url(#hiwah)"
                />
                <text className="svg-lab" x={420} y={210}>
                  not done → next turn (compact first if the request is over budget)
                </text>
                <path className="svg-line" d="M946 100 H986" />
              </svg>
              <div className="hiw-figcap">
                {
                  "// every turn is a durable checkpoint — kill the process mid-run and it picks up at the last committed turn"
                }
              </div>
            </div>

            <div className="hiw-meters hiw-block">
              <div className="hiw-meter">
                <div className="lab">step budget</div>
                <div className="val">45 / 100</div>
                <div className="hiw-bar">
                  <i style={{ width: "45%" }} />
                </div>
              </div>
              <div className="hiw-meter">
                <div className="lab">token budget (fresh)</div>
                <div className="val">1.4M / 2M</div>
                <div className="hiw-bar">
                  <i style={{ width: "70%" }} />
                </div>
              </div>
              <div className="hiw-meter">
                <div className="lab">cost budget</div>
                <div className="val">$3.32 / $5</div>
                <div className="hiw-bar">
                  <i style={{ width: "66%" }} />
                </div>
              </div>
            </div>
            <p className="hiw-note">
              {
                '// the "work" profile. Tokens count only FRESH (non-cached) input + output. Hit any ceiling → the run finalizes cleanly, never crashes.'
              }
            </p>
          </div>
        </section>

        {/* ---- 3 SPINE ---- */}
        <section className="section" id="spine">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">03 · The spine</p>
                <h2 className="section-heading">A whole identity in under 2,000 tokens</h2>
              </div>
              <p className="section-intro">
                A lean, cached prefix rendered top-to-bottom in a deliberate order — the writable
                self can never appear after, and contradict, the fixed policy.
              </p>
            </header>

            <div className="hiw-spine hiw-block">
              <div className="hiw-layer">
                <span className="lname"># Delta</span>
                <span className="ldesc">
                  Who you are — an operator agent that does real work for the people who message
                  you.
                </span>
                <span className="lmeta">identity</span>
              </div>
              <div className="hiw-layer">
                <span className="lname"># Norms</span>
                <span className="ldesc">
                  Engine safety rules: work through tools, never fabricate, writes to shared systems
                  are <em>proposals</em>, web &amp; other people's docs are untrusted data — not
                  commands.
                </span>
                <span className="lmeta">fixed</span>
              </div>
              <div className="hiw-layer">
                <span className="lname"># Context</span>
                <span className="ldesc">
                  Boot-stable dynamic vars (model, time, operator-supplied) — cached.
                </span>
                <span className="lmeta">PROMPT_CONTEXT.md</span>
              </div>
              <div className="hiw-layer you">
                <span className="lname"># You</span>
                <span className="ldesc">
                  DELTA.md verbatim — the <b>writable</b> self-file: identity + everything the agent
                  has learned. The agent edits it with <span className="hiw-kbd">remember</span>.
                </span>
                <span className="lmeta">writable · snapshotted</span>
              </div>
              <div className="hiw-layer policy">
                <span className="lname"># Policy</span>
                <span className="ldesc">
                  POLICY.md — the fixed contract, rendered last so nothing above (or a task
                  instruction) can override it.
                </span>
                <span className="lmeta">non-overridable</span>
              </div>
              <div className="hiw-layer">
                <span className="lname"># Tools</span>
                <span className="ldesc">
                  The resident (pinned) tool index + a note that more exist behind{" "}
                  <span className="hiw-kbd">search_tools</span>.
                </span>
                <span className="lmeta">≤ 60 pinned</span>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 4 TOOLS + SEAM ---- */}
        <section className="section" id="tools">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">04 · Tools &amp; the seam</p>
                <h2 className="section-heading">Hands, and the door they're driven through</h2>
              </div>
              <p className="section-intro">
                The agent works entirely through tools — a lean pinned set rides every request; a
                big connector surface stays discoverable.
              </p>
            </header>

            <div className="hiw-split hiw-block" style={{ alignItems: "start" }}>
              <div>
                <p className="hiw-p" style={{ marginBottom: 18 }}>
                  A lean <b>pinned</b> set (≤60) rides in every request; a large connector surface —
                  a knowledge base can add 90+ tools — stays discoverable via{" "}
                  <span className="hiw-kbd">search_tools</span> so it never blows the token budget.
                </p>
                <div className="hiw-cat">
                  <h4>files</h4>
                  <div className="hiw-pills">
                    <span className="hiw-pill">read_file</span>
                    <span className="hiw-pill">write_file</span>
                    <span className="hiw-pill">list_dir</span>
                    <span className="hiw-pill">grep</span>
                    <span className="hiw-pill">move_file</span>
                    <span className="hiw-pill">delete_file</span>
                  </div>
                </div>
                <div className="hiw-cat">
                  <h4>memory &amp; plan</h4>
                  <div className="hiw-pills">
                    <span className="hiw-pill">remember</span>
                    <span className="hiw-pill">recall</span>
                    <span className="hiw-pill">todo</span>
                  </div>
                </div>
                <div className="hiw-cat">
                  <h4>work</h4>
                  <div className="hiw-pills">
                    <span className="hiw-pill">code</span>
                    <span className="hiw-pill">web_search</span>
                    <span className="hiw-pill">web_fetch</span>
                    <span className="hiw-pill">schedule_self</span>
                  </div>
                </div>
                <div className="hiw-cat">
                  <h4>delegation</h4>
                  <div className="hiw-pills">
                    <span className="hiw-pill new">research</span>
                    <span className="hiw-pill">spawn_subagent</span>
                    <span className="hiw-pill">eval_n</span>
                  </div>
                </div>
                <div className="hiw-cat">
                  <h4>connectors (MCP)</h4>
                  <div className="hiw-pills">
                    <span className="hiw-pill mcp">kb__search_text</span>
                    <span className="hiw-pill mcp">kb__get_context</span>
                    <span className="hiw-pill mcp">kb__… ×90</span>
                  </div>
                </div>
              </div>
              <div className="fig">
                <div
                  className="hiw-panel"
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <div className="hiw-endpoint">
                    <span className="hiw-verb">POST</span>
                    <div>
                      <span className="path">/v1/responses</span>
                      <p>
                        Synchronous turn — OpenAI-Responses compatible. Best for quick, interactive
                        work.
                      </p>
                    </div>
                  </div>
                  <div className="hiw-endpoint">
                    <span className="hiw-verb">POST</span>
                    <div>
                      <span className="path">/v1/tasks</span>
                      <p>
                        Async, durable, cancellable — fire-and-forget for long runs. Returns 202
                        immediately; the run keeps going on its own.
                      </p>
                    </div>
                  </div>
                  <div className="hiw-endpoint">
                    <span className="hiw-verb">GET</span>
                    <div>
                      <span className="path">/healthz</span>
                      <p>Liveness — autosuspend wake &amp; the reconciler tick.</p>
                    </div>
                  </div>
                  <p className="hiw-note" style={{ margin: "2px 0 0" }}>
                    {"// one binary, one agent per process or VM"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 5 CONTEXT ---- */}
        <section className="section" id="context">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">05 · Context management</p>
                <h2 className="section-heading">Staying sharp across a long run</h2>
              </div>
              <p className="section-intro">
                Two mechanisms keep the active window from choking — so the agent stays coherent
                instead of drowning in its own tool output.
              </p>
            </header>
            <div className="hiw-grid hiw-g2 hiw-block">
              <div className="hiw-card">
                <span className="hiw-tag">compaction</span>
                <h3>
                  <span className="hiw-ic">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path d="M4 7h16M7 12h10M10 17h4" />
                    </svg>
                  </span>
                  Fold the past
                </h3>
                <p>
                  When an assembled request would exceed the per-request ceiling, older turns are
                  summarized into a structured note while the recent tail is kept verbatim. Prior
                  summaries merge forward.
                </p>
              </div>
              <div className="hiw-card">
                <span className="hiw-tag">spill</span>
                <h3>
                  <span className="hiw-ic">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path d="M12 3v10m0 0l-3-3m3 3l3-3" />
                      <path d="M5 15v4h14v-4" />
                    </svg>
                  </span>
                  Big results to disk
                </h3>
                <p>
                  A tool result over ~20k bytes is written to a spill file, leaving a pointer in
                  context. The agent (or a subagent) can <span className="hiw-kbd">read_file</span>{" "}
                  or <span className="hiw-kbd">recall</span> it later — full fidelity, near-zero
                  token cost.
                </p>
              </div>
            </div>
            <div className="hiw-callout clay hiw-block">
              <span className="k">the honest edge</span>
              <p>
                Even with these, a single agent that pulls a huge transcript <em>and</em> dozens of
                mid-size tool results into one window can still brush the ceiling — the request
                becomes irreducible and the run burns budget. That failure is exactly what the next
                feature is built to defeat.
              </p>
            </div>
          </div>
        </section>

        {/* ---- 6 SUBAGENTS ---- */}
        <section className="section" id="subagents">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">
                  06 · Sub-agents{" "}
                  <span className="hiw-shipped" style={{ marginLeft: 8 }}>
                    △ new in v0.2.0
                  </span>
                </p>
                <h2 className="section-heading">The master planner delegates the noise</h2>
              </div>
              <p className="section-intro">
                The primary agent commissions sub-agents — up to three in parallel, each isolated —
                and absorbs only their distilled signal, never raw payloads.
              </p>
            </header>
            <p className="hiw-lede hiw-block">
              Instead of pulling every noisy lookup into its own window, the planner hands each
              sub-agent a self-contained task. Each does the messy work in a fresh context, writes
              its full findings to a file, and returns only a tight summary.
            </p>

            <div className="hiw-panel hiw-scroll hiw-block">
              <svg
                className="hiw-dia"
                viewBox="0 0 960 320"
                role="img"
                aria-label="Sub-agent fan-out: a parent delegates three tasks to isolated children; each writes full findings to a file and returns only a short summary"
              >
                <title>Sub-agent fan-out</title>
                <defs>
                  <marker
                    id="hiwah2"
                    markerWidth={10}
                    markerHeight={10}
                    refX={7}
                    refY={3}
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="var(--sage)" />
                  </marker>
                  <marker
                    id="hiwah2b"
                    markerWidth={10}
                    markerHeight={10}
                    refX={7}
                    refY={3}
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="var(--clay)" />
                  </marker>
                </defs>
                <rect className="svg-box-accent" x={360} y={18} width={240} height={60} rx={12} />
                <text className="svg-t" x={384} y={44}>
                  primary agent
                </text>
                <text className="svg-td" x={384} y={62}>
                  reads transcript · plans · files result
                </text>

                <rect className="svg-box" x={40} y={150} width={250} height={66} rx={12} />
                <text className="svg-t" x={60} y={178}>
                  child · task A
                </text>
                <text className="svg-td" x={60} y={196}>
                  fresh context · full rights
                </text>

                <rect className="svg-box" x={355} y={150} width={250} height={66} rx={12} />
                <text className="svg-t" x={375} y={178}>
                  child · task B
                </text>
                <text className="svg-td" x={375} y={196}>
                  reads KB · runs tools
                </text>

                <rect className="svg-box" x={670} y={150} width={250} height={66} rx={12} />
                <text className="svg-t" x={690} y={178}>
                  child · task C
                </text>
                <text className="svg-td" x={690} y={196}>
                  own budget slice
                </text>

                <path
                  className="svg-flow"
                  d="M420 78 C300 110, 200 120, 165 148"
                  markerEnd="url(#hiwah2)"
                />
                <path className="svg-flow" d="M480 78 V148" markerEnd="url(#hiwah2)" />
                <path
                  className="svg-flow"
                  d="M540 78 C660 110, 760 120, 795 148"
                  markerEnd="url(#hiwah2)"
                />
                <text className="svg-lab" x={250} y={120}>
                  fan out ≤3 tasks
                </text>

                <rect className="svg-box-clay" x={70} y={256} width={190} height={42} rx={9} />
                <text className="svg-td" x={88} y={282} style={{ fill: "var(--clay)" }}>
                  findings.md → disk
                </text>
                <rect className="svg-box-clay" x={385} y={256} width={190} height={42} rx={9} />
                <text className="svg-td" x={403} y={282} style={{ fill: "var(--clay)" }}>
                  findings.md → disk
                </text>
                <rect className="svg-box-clay" x={700} y={256} width={190} height={42} rx={9} />
                <text className="svg-td" x={718} y={282} style={{ fill: "var(--clay)" }}>
                  findings.md → disk
                </text>
                <path className="svg-flow-b" d="M165 216 V254" markerEnd="url(#hiwah2b)" />
                <path className="svg-flow-b" d="M480 216 V254" markerEnd="url(#hiwah2b)" />
                <path className="svg-flow-b" d="M795 216 V254" markerEnd="url(#hiwah2b)" />

                <path
                  className="svg-flow"
                  d="M255 150 C330 118, 420 96, 452 80"
                  markerEnd="url(#hiwah2)"
                />
                <path
                  className="svg-flow"
                  d="M600 150 C560 116, 520 96, 508 80"
                  markerEnd="url(#hiwah2)"
                />
                <text className="svg-lab" x={600} y={120} style={{ textAnchor: "end" }}>
                  ≤1,200-char summary returns
                </text>
              </svg>
              <div className="hiw-figcap">
                {
                  "// full findings stay on disk (recall them if a decision needs detail) — only the distilled summary re-enters the planner's window"
                }
              </div>
            </div>

            <div className="hiw-callout hiw-block">
              <span className="k">what shipped in 0.2.0</span>
              <p>
                <b>Sub-agents now have the parent's exact rights</b> — read, write, run code,{" "}
                <span className="hiw-kbd">remember</span>, knowledge-base reads <em>and</em> writes
                — not the old read-only subset. The only things withheld are the delegation tools
                and run-scheduling, which keeps nesting exactly <b>one level deep</b> (no
                fork-bombs). And they're built from the <b>same spine</b> as the parent, so a child
                inherits the parent's norms + policy along with its rights:{" "}
                <em>same rights, and same rules.</em>
              </p>
            </div>

            <div className="hiw-grid hiw-g3 hiw-block">
              <div className="hiw-card">
                <h3 style={{ fontSize: 15 }}>Fresh, isolated</h3>
                <p>
                  A child builds its own context and never pollutes the parent's window. Its
                  transcript stays inside the call.
                </p>
              </div>
              <div className="hiw-card">
                <h3 style={{ fontSize: 15 }}>Budget-shared</h3>
                <p>
                  The parent's remaining budget is split ÷(N+1), so the whole fan-out stays within
                  the run's ceiling.
                </p>
              </div>
              <div className="hiw-card">
                <h3 style={{ fontSize: 15 }}>Codex-hardened</h3>
                <p>
                  Three adversarial review rounds closed a nesting-cap escape, missing safety norms,
                  budget, and identity parity.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 7 MEMORY ---- */}
        <section className="section" id="memory">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">07 · Memory &amp; learning</p>
                <h2 className="section-heading">An agent that gets better by doing</h2>
              </div>
              <p className="section-intro">
                The agent rewrites its own self-file, and a review loop turns human corrections into
                durable lessons.
              </p>
            </header>
            <div className="hiw-split hiw-block">
              <div>
                <p className="hiw-p">
                  The agent's identity lives in <code>DELTA.md</code> — and it can rewrite its own{" "}
                  <code>## Learned</code> section with the <span className="hiw-kbd">remember</span>{" "}
                  tool. Every edit is snapshotted and revertible; a run always reads an immutable
                  snapshot, so a self-edit lands on the <em>next</em> run.
                </p>
                <p className="hiw-p">
                  Beyond the self-file, a review loop closes the circle: when a human accepts,
                  edits, or rejects what the agent proposed, that feedback becomes a <b>reflect</b>{" "}
                  turn that distills the lesson into memory. The agent learns the shape of good work
                  from real corrections.
                </p>
                <ul className="hiw-clean">
                  <li>
                    <b>remember</b> — write to the living self-file
                  </li>
                  <li>
                    <b>recall</b> — search this thread's own history, spilled results included
                  </li>
                  <li>
                    <b>reflect</b> — turn reviewer feedback into a durable lesson
                  </li>
                </ul>
              </div>
              <div className="fig">
                <div
                  className="hiw-callout clay"
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  <span className="k">the operating principle</span>
                  <p
                    style={{
                      fontSize: 22,
                      color: "var(--foreground)",
                      fontWeight: 600,
                      letterSpacing: "-0.02em",
                      margin: "10px 0 6px",
                      maxWidth: "none",
                    }}
                  >
                    Delta proposes,
                    <br />
                    Echo disposes.
                  </p>
                  <p style={{ margin: 0, fontSize: 14 }}>
                    Writes to shared systems are always proposals a human approves. The agent acts;
                    the human keeps the last word — and every disposition feeds the next lesson.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 8 DURABILITY ---- */}
        <section className="section" id="durability">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">08 · Durability &amp; resilience</p>
                <h2 className="section-heading">Built to survive the real world</h2>
              </div>
              <p className="section-intro">
                Restarts, dropped connections, and slow turns are recoverable events here, not
                failures.
              </p>
            </header>
            <div className="hiw-grid hiw-g3 hiw-block">
              <div className="hiw-card">
                <span className="hiw-tag">checkpoint-per-turn</span>
                <h3 style={{ fontSize: 16 }}>Crash-safe</h3>
                <p>
                  The SQLite WAL commits after every turn. A process restart resumes running work
                  from the last committed turn — nothing lost, nothing double-run.
                </p>
              </div>
              <div className="hiw-card">
                <span className="hiw-tag">async + reconciler</span>
                <h3 style={{ fontSize: 16 }}>Self-healing</h3>
                <p>
                  Long tasks dispatch fire-and-forget over <code>/v1/tasks</code>; a reconciler
                  sweep re-drives anything genuinely stuck. A run that hits its budget can be
                  retried and succeed on the next pass.
                </p>
              </div>
              <div className="hiw-card">
                <span className="hiw-tag">error-as-value</span>
                <h3 style={{ fontSize: 16 }}>Never crashes</h3>
                <p>
                  A provider or tool failure comes back as a clean turn the agent can reason about —
                  the daemon itself doesn't fall over.
                </p>
              </div>
            </div>
            <div className="hiw-callout hiw-block">
              <span className="k">proven in production</span>
              <p>
                A live incident — a proxy capping long-held connections, orphaning durable runs —
                was fixed by moving to idempotent async dispatch. The reconciler then cleared the
                backlog on its own: a budget-death was automatically re-driven and filed
                successfully on retry, with real traffic flowing through the same agent.
              </p>
            </div>

            <div
              className="hiw-block"
              style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 30 }}
            >
              <a className="hiw-chip strong" href="/docs/" style={{ textDecoration: "none" }}>
                <span className="k">read</span> the full guide
              </a>
              <a
                className="hiw-chip"
                href="https://github.com/Carrara-Labs/delta-harness"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "none" }}
              >
                <span className="k">source</span> github
              </a>
              <a className="hiw-chip" href="/" style={{ textDecoration: "none" }}>
                <span className="k">home</span> deltaharness.dev
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
