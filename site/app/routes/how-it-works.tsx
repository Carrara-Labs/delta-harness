import { Fragment, useEffect, useState } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/how-it-works.css";

const canonicalUrl = "https://deltaharness.dev/how-it-works";
const pageTitle = "How Delta works. The agent runtime, end to end.";
const description =
  "A calm, visual tour of the Delta agent runtime: the philosophy, the run loop, the sub-2k-token spine, tools, context management, full-rights subagents, memory, and durability.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const repoUrl = "https://github.com/Carrara-Labs/delta-harness";
const npmUrl = "https://www.npmjs.com/package/@carrara-labs/delta-harness";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "article" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:title", content: "How a Delta agent works." },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "How a Delta agent works." },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
  ];
}

export default function HowItWorks() {
  const [ctxMode, setCtxMode] = useState<"after" | "before">("after");
  const [fanMode, setFanMode] = useState<"with" | "without">("with");

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
        {/* ===== HERO ===== */}
        <section className="hiw-hero" id="top">
          <div className="page">
            <span className="hiw-eyebrow">
              <span className="hiw-dot" /> Open source runtime · v0.2.0
            </span>
            <h1 className="hiw-title">You keep the taste. Agents do the rest.</h1>
            <p className="hiw-subline">
              Delta is the open source runtime for long-running autonomous agents. You hold the
              judgment and the last word. It systematizes the knowledge work beneath you.
            </p>
            <div className="hiw-strip">
              {[
                [
                  "Self-learning",
                  "Each run makes it sharper. It rewrites its own instruction file from what the work teaches it.",
                ],
                [
                  "Token-lean",
                  "A sub-2,000-token spine and a cache-friendly loop keep every turn cheap, across hours of work.",
                ],
                [
                  "Open source",
                  "The whole runtime is public and self-contained. No black box, no per-seat license, no lock-in.",
                ],
                [
                  "Self-hosted",
                  "One small binary runs on your own infrastructure, one agent per process. Your data never leaves.",
                ],
                [
                  "Subscription-cheap",
                  "Point it at a Codex subscription instead of metered tokens and run for a flat monthly cost.",
                ],
              ].map(([lab, txt]) => (
                <div key={lab}>
                  <div className="lab">{lab}</div>
                  <div className="txt">{txt}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== PHILOSOPHY ===== */}
        <section id="philosophy">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">Why Delta</p>
              <h2 className="hiw-h2">Humans orchestrate. Agents systematize.</h2>
              <p className="hiw-intro">
                You hold judgment, priorities, and the last word. Delta turns the repeatable
                knowledge work beneath that into a system that runs itself.
              </p>
            </div>

            <div className="hiw-orch">
              <p className="band-cap">Orchestrate</p>
              <div className="hiw-you">
                <span className="you-pill">YOU</span>
                <span className="you-tag">taste</span>
                <span className="you-tag">priorities</span>
                <span className="you-tag">final say</span>
              </div>

              <div className="hiw-seam">
                <div className="arm">
                  <svg viewBox="0 0 18 60" aria-hidden="true">
                    <line className="svg-flow" x1="9" y1="2" x2="9" y2="50" />
                    <path className="svg-flow" d="M4 45 L9 52 L14 45" />
                    <circle className="seam-dot" cx="9" cy="10" r="3" fill="var(--sage)" />
                  </svg>
                  <span>delegate</span>
                </div>
                <div className="arm">
                  <svg viewBox="0 0 18 60" aria-hidden="true">
                    <line className="svg-flow-b" x1="9" y1="58" x2="9" y2="10" />
                    <path className="svg-flow-b" d="M4 15 L9 8 L14 15" />
                  </svg>
                  <span>propose, approve</span>
                </div>
              </div>

              <p className="band-cap">Systematize</p>
              <div className="hiw-pillars">
                <div className="hiw-pillar">
                  <h3>Systematize your knowledge</h3>
                  <p>
                    Autonomous agents that learn as they work and live on your own infrastructure.
                  </p>
                  <div className="hiw-chips">
                    <span className="hiw-chip">learns on the job</span>
                    <span className="hiw-chip">token-lean</span>
                    <span className="hiw-chip">open source</span>
                    <span className="hiw-chip">self-hosted</span>
                  </div>
                </div>
                <div className="hiw-pillar clay">
                  <h3>Ship an agentic feature</h3>
                  <p>
                    A model-agnostic, self-learning agent that does one job inside your product.
                  </p>
                  <div className="hiw-chips">
                    <span className="hiw-chip">configured by files</span>
                    <span className="hiw-chip">own memory + workspace</span>
                    <span className="hiw-chip">model-agnostic</span>
                    <span className="hiw-chip">one job, done well</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== ANATOMY ===== */}
        <section id="anatomy">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">01 · Anatomy</p>
              <h2 className="hiw-h2">One engine. Any agent.</h2>
              <p className="hiw-intro">
                Every agent is the same engine plus a five-file bundle plus its state. The code is
                generic, the agent is data.
              </p>
            </div>

            <div className="hiw-eq">
              <span className="word">agent</span>
              <span className="op">=</span>
              {(
                [
                  ["engine", "one binary · the loop"],
                  ["bundle", "five files · the agent"],
                  ["state", "SQLite + workspace"],
                ] as const
              ).map(([term, sub], i) => (
                <Fragment key={term}>
                  {i > 0 && <span className="op">+</span>}
                  <span className={`hiw-operand ${term}`}>
                    <span className="top">{term}</span>
                    <span className="sub">{sub}</span>
                  </span>
                </Fragment>
              ))}
            </div>

            {/* Band: engine */}
            <div className="hiw-band b-engine">
              <div className="rail">
                <div className="rlabel">engine</div>
                <div className="rsub">owns almost nothing</div>
              </div>
              <div>
                <div className="hiw-adapters">
                  {[
                    ["memory", "knowledge base, over MCP"],
                    ["skills", "a skill library"],
                    ["code", "delegated coding CLIs"],
                    ["review", "a propose then approve rail"],
                  ].map(([an, av]) => (
                    <div className="hiw-adapter" key={an}>
                      <span className="an">{an}</span>
                      <span className="av">
                        <span className="arrow">→</span>
                        {av}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="hiw-metastrip">
                  {["sub-2k spine", "turn loop", "compaction", "budgets", "durability"].map((p) => (
                    <span className="hiw-chip" key={p}>
                      {p}
                    </span>
                  ))}
                </div>
                <p className="hiw-cap">
                  {
                    "// Bun binary, under 10ms cold start, zero runtime deps. The same binary runs every agent."
                  }
                </p>
              </div>
            </div>

            {/* Band: bundle */}
            <div className="hiw-band b-bundle">
              <div className="rail">
                <div className="rlabel">bundle</div>
                <div className="rsub">five files</div>
              </div>
              <div>
                <div className="hiw-cluster">
                  <p className="cl">the mind</p>
                  <div className="hiw-file">
                    <span className="fn">DELTA.md</span>
                    <span className="hiw-mut write">agent-writable</span>
                    <span className="role">
                      The living self. Identity plus a Learned section the agent rewrites with{" "}
                      <span className="kbd">remember</span>. Snapshotted and revertible.
                    </span>
                  </div>
                  <div className="hiw-file">
                    <span className="fn">POLICY.md</span>
                    <span className="hiw-mut fixed">operator-fixed</span>
                    <span className="role">
                      The fixed operating contract, rendered last so nothing overrides it.
                    </span>
                  </div>
                </div>
                <div className="hiw-cluster">
                  <p className="cl">the wiring</p>
                  <div className="hiw-file">
                    <span className="fn">vocab.json</span>
                    <span className="hiw-mut">config</span>
                    <span className="role">
                      The write rail. Maps the neutral propose verb onto a concrete product action.
                    </span>
                  </div>
                  <div className="hiw-file">
                    <span className="fn">delta.env</span>
                    <span className="hiw-mut">config</span>
                    <span className="role">Backends, keys, budgets.</span>
                  </div>
                  <div className="hiw-file">
                    <span className="fn">PROMPT_CONTEXT.md</span>
                    <span className="hiw-mut">config</span>
                    <span className="role">Dynamic vars resolved per run.</span>
                  </div>
                </div>
                <p className="hiw-cap">
                  {
                    "// A new agent is a new bundle, not a new build. One fix to the loop reaches every agent."
                  }
                </p>
              </div>
            </div>

            {/* Band: state */}
            <div className="hiw-band b-state">
              <div className="rail">
                <div className="rlabel">state</div>
                <div className="rsub">local, durable</div>
              </div>
              <div>
                <div className="hiw-stores">
                  <div className="hiw-store">
                    <h4>SQLite (WAL)</h4>
                    <div className="items">sessions · turns · checkpoints</div>
                    <div className="cap">
                      Checkpointed every turn. A crash resumes exactly where it stopped.
                    </div>
                  </div>
                  <div className="hiw-store">
                    <h4>workspace (on disk)</h4>
                    <div className="items">scratch · spill · research</div>
                    <div className="cap">
                      Big tool results and subagent findings land here as files.
                    </div>
                  </div>
                </div>
                <div className="hiw-survive">
                  <div className="ephemeral">
                    <p className="sk">per-run · ephemeral (store: false)</p>
                    <div className="row">
                      <span className="pill">transcript</span>
                      <span className="pill">spill</span>
                      <span className="pill">scratch</span>
                    </div>
                    <span className="tag">purged on finish</span>
                  </div>
                  <div className="cross">
                    <p className="sk">cross-run · survives</p>
                    <div className="row">
                      <span className="pill">learnings</span>
                      <span className="pill">self-file revisions</span>
                    </div>
                    <span className="tag">carried forward</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== RUN LOOP + SPINE ===== */}
        <section id="run-loop">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">02 · Run loop & spine</p>
              <h2 className="hiw-h2">Every turn rebuilds from a 2,000-token spine</h2>
              <p className="hiw-intro">
                A loop that rebuilds, calls, acts, and checkpoints every turn. A spine that fits the
                whole identity in under 2,000 tokens.
              </p>
            </div>

            <div className="hiw-figure">
              <svg className="dia" viewBox="0 0 960 210" role="img" aria-label="The run loop">
                <title>The run loop</title>
                <defs>
                  <marker
                    id="ra"
                    markerWidth="9"
                    markerHeight="9"
                    refX="6.5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6.5,3 L0,6 Z" fill="var(--sage)" />
                  </marker>
                </defs>
                {[
                  [14, "assemble", "spine + history", "+ tool schemas", false],
                  [214, "model call", "sub-first", "provider", true],
                  [414, "run tools", "in parallel", "error-as-value", false],
                  [614, "checkpoint", "SQLite WAL", "resume-safe", false],
                ].map(([x, t, a, b, hot]) => (
                  <g key={t as string}>
                    <rect
                      className={hot ? "svg-box-sage" : "svg-box"}
                      x={x as number}
                      y={54}
                      width={158}
                      height={70}
                      rx={11}
                    />
                    <text className="svg-t" x={(x as number) + 16} y={84}>
                      {t as string}
                    </text>
                    <text className="svg-td" x={(x as number) + 16} y={102}>
                      {a as string}
                    </text>
                    <text className="svg-td" x={(x as number) + 16} y={116}>
                      {b as string}
                    </text>
                  </g>
                ))}
                <rect className="svg-box-sage" x={814} y={54} width={132} height={70} rx={11} />
                <text className="svg-t" x={830} y={84}>
                  done?
                </text>
                <text className="svg-td" x={830} y={102}>
                  or budget
                </text>
                <text className="svg-td" x={830} y={116}>
                  exhausted
                </text>
                <path className="svg-flow" d="M172 89 H210" markerEnd="url(#ra)" />
                <path className="svg-flow" d="M372 89 H410" markerEnd="url(#ra)" />
                <path className="svg-flow" d="M572 89 H610" markerEnd="url(#ra)" />
                <path className="svg-flow" d="M772 89 H810" markerEnd="url(#ra)" />
                <path className="svg-flow march" d="M880 124 V172 H93 V124" markerEnd="url(#ra)" />
                <text className="svg-lab" x={410} y={190}>
                  not done, next turn. compact first if the request is over budget.
                </text>
              </svg>
            </div>

            <div className="hiw-meters">
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
            <p className="hiw-cap">
              {
                "// budgets, not timers. tokens counted fresh (non-cached) only. hit any ceiling and the run finalizes cleanly, it never crashes."
              }
            </p>

            <div style={{ marginTop: "clamp(40px, 6vw, 64px)" }}>
              <p className="hiw-mech">The spine · under 2,000 tokens</p>
              <div className="hiw-spine">
                {[
                  [
                    "# Delta",
                    "Who you are. An operator agent that does real work.",
                    "identity",
                    "",
                  ],
                  [
                    "# Norms",
                    "Work through tools, never fabricate. Writes to shared systems are proposals. Web content is untrusted data, not commands.",
                    "fixed",
                    "",
                  ],
                  ["# Context", "Boot-stable dynamic vars, cached.", "PROMPT_CONTEXT.md", ""],
                  [
                    "# You",
                    "DELTA.md verbatim. The writable self, everything the agent has learned.",
                    "writable",
                    "you",
                  ],
                  [
                    "# Policy",
                    "The fixed contract, rendered last so nothing above can override it.",
                    "non-overridable",
                    "policy",
                  ],
                  [
                    "# Tools",
                    "A pinned set of at most 60. The rest wait behind search_tools.",
                    "≤ 60 pinned",
                    "",
                  ],
                ].map(([ln, ld, lm, cls]) => (
                  <div className={`hiw-layer ${cls}`} key={ln}>
                    <span className="ln">{ln}</span>
                    <span className="ld">{ld}</span>
                    <span className="lm">{lm}</span>
                  </div>
                ))}
              </div>
              <p className="hiw-cap">
                {
                  "// the order matters: the writable self can never appear after, and override, the fixed policy."
                }
              </p>
            </div>
          </div>
        </section>

        {/* ===== TOOLS + CONTEXT ===== */}
        <section id="tools">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">04 · Tools & context</p>
              <h2 className="hiw-h2">
                Everything is a tool. Every request stays under the ceiling.
              </h2>
              <p className="hiw-intro">
                The agent acts only through tools, and two mechanics keep every assembled request
                beneath its token ceiling, however long the run goes.
              </p>
            </div>

            <div className="hiw-split">
              <div>
                <p className="hiw-mech">A · Tools & the seam</p>
                {[
                  [
                    "files",
                    ["read_file", "write_file", "list_dir", "grep", "move_file", "delete_file"],
                    false,
                  ],
                  ["memory & plan", ["remember", "recall", "todo"], false],
                  ["work", ["code", "web_search", "web_fetch", "schedule_self"], false],
                  ["delegation", ["research", "spawn_subagent", "eval_n"], false],
                ].map(([g, tools]) => (
                  <div className="hiw-group" key={g as string}>
                    <h4>{g as string}</h4>
                    <div className="hiw-pills">
                      {(tools as string[]).map((t) => (
                        <span className="hiw-pill" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="hiw-group">
                  <p className="hiw-disc">discoverable via search_tools</p>
                  <div className="hiw-pills">
                    <span className="hiw-pill mcp">kb__search_text</span>
                    <span className="hiw-pill mcp">kb__get_context</span>
                    <span className="hiw-pill mcp">+90 more</span>
                  </div>
                </div>
              </div>
              <div>
                <p className="hiw-mech">The seam</p>
                <div className="hiw-endpoint">
                  <span className="hiw-verb">POST</span>
                  <div>
                    <span className="path">/v1/responses</span>
                    <div className="desc">synchronous turn, OpenAI-Responses compatible</div>
                  </div>
                </div>
                <div className="hiw-endpoint">
                  <span className="hiw-verb">POST</span>
                  <div>
                    <span className="path">/v1/tasks</span>
                    <div className="desc">
                      async, durable, cancellable. returns 202 and keeps running.
                    </div>
                  </div>
                </div>
                <div className="hiw-endpoint">
                  <span className="hiw-verb">GET</span>
                  <div>
                    <span className="path">/healthz</span>
                    <div className="desc">liveness</div>
                  </div>
                </div>
                <p className="hiw-cap">{"// one binary, one agent per process or VM"}</p>
              </div>
            </div>

            <div style={{ marginTop: "clamp(40px, 6vw, 64px)" }}>
              <div className="hiw-ceiling" data-mode={ctxMode}>
                <div className="hiw-ceiling-top">
                  <p className="hiw-mech" style={{ margin: 0 }}>
                    B · Context management
                  </p>
                  <div className="hiw-toggle">
                    <button
                      type="button"
                      aria-pressed={ctxMode === "after"}
                      onClick={() => setCtxMode("after")}
                    >
                      managed
                    </button>
                    <button
                      type="button"
                      aria-pressed={ctxMode === "before"}
                      onClick={() => setCtxMode("before")}
                    >
                      without compaction
                    </button>
                  </div>
                </div>
                <div className="hiw-window">
                  <div className="hiw-ceilingline">
                    <span className="cl-lab">per-request ceiling</span>
                  </div>
                  <div className="hiw-blk spine">
                    <span>spine</span>
                    <span className="bt">&lt; 2k tokens</span>
                  </div>
                  <div className="hiw-blk">
                    <span>pinned tools</span>
                    <span className="bt">index only, ≤ 60</span>
                  </div>
                  <div className="hiw-blk fold only-after">
                    <span>compacted summary</span>
                    <span className="bt">folded past</span>
                  </div>
                  <div className="hiw-blk only-after">
                    <span>recent tail</span>
                    <span className="bt">verbatim</span>
                  </div>
                  {[
                    "raw turn 41",
                    "raw turn 42",
                    "big result 88k",
                    "raw turn 43",
                    "big result 42k",
                  ].map((r) => (
                    <div className="hiw-blk raw over only-before" key={r}>
                      <span>{r}</span>
                      <span className="hiw-overtag">over budget</span>
                    </div>
                  ))}
                </div>
                <p className="hiw-cap">
                  {ctxMode === "after"
                    ? "// same run, request rebuilt under the ceiling. detail is not lost, only moved to disk where the agent can recall it."
                    : "// older turns and big results pile into one window. the request crests the ceiling and the run burns budget."}
                </p>
              </div>

              <div className="hiw-split" style={{ marginTop: 16 }}>
                <div className="hiw-store">
                  <h4>Compaction</h4>
                  <p className="hiw-p" style={{ margin: "8px 0 0", fontSize: 14 }}>
                    Older turns fold into a structured note. The recent tail stays verbatim, and
                    prior summaries merge forward.
                  </p>
                </div>
                <div className="hiw-store">
                  <h4>Spill</h4>
                  <p className="hiw-p" style={{ margin: "8px 0 0", fontSize: 14 }}>
                    A result over ~20k bytes writes to a file, leaving a pointer. Recall it later at
                    full fidelity, near-zero tokens.
                  </p>
                </div>
              </div>

              <div
                className="hiw-figure"
                style={{
                  marginTop: 16,
                  background: "var(--wash-clay)",
                  padding: "18px 22px",
                }}
              >
                <p className="hiw-p" style={{ margin: 0, maxWidth: "72ch" }}>
                  <b>The honest edge.</b> One agent can still pull a huge transcript plus dozens of
                  mid-size results into a single window and brush the ceiling, burning budget. That
                  exact failure is what subagents, next, are built to defeat.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== SUBAGENTS ===== */}
        <section id="subagents">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">
                06 · Sub-agents <span className="hiw-newpill">△ new in v0.2.0</span>
              </p>
              <h2 className="hiw-h2">The planner keeps the signal, not the noise</h2>
              <p className="hiw-intro">
                One master planner commissions up to three sub-agents in parallel. Each works in a
                fresh, isolated context and returns only distilled signal.
              </p>
            </div>

            <div className="hiw-fan" data-mode={fanMode}>
              <div className="hiw-fan-top">
                <div className="hiw-toggle">
                  <button
                    type="button"
                    aria-pressed={fanMode === "with"}
                    onClick={() => setFanMode("with")}
                  >
                    with sub-agents
                  </button>
                  <button
                    type="button"
                    aria-pressed={fanMode === "without"}
                    onClick={() => setFanMode("without")}
                  >
                    without
                  </button>
                </div>
              </div>
              <div className="hiw-fan-grid">
                <div className="hiw-planner">
                  <div className="pt">master planner</div>
                  <div className="hiw-readout">
                    <b>{fanMode === "with" ? "18%" : "92%"}</b>{" "}
                    {fanMode === "with" ? "· lean" : "· cramped"}
                  </div>
                  <div className="hiw-gauge">
                    <div className="fill" style={{ height: fanMode === "with" ? "18%" : "92%" }}>
                      {fanMode === "with"
                        ? ["summary C", "summary B", "summary A"].map((s) => (
                            <div className="frow sig" key={s}>
                              {s}
                            </div>
                          ))
                        : [
                            "raw lookup",
                            "full doc",
                            "tool dump",
                            "logs",
                            "brain read",
                            "spec dump",
                          ].map((s) => (
                            <div className="frow" key={s}>
                              {s}
                            </div>
                          ))}
                    </div>
                  </div>
                </div>
                <div className="hiw-children">
                  {["A", "B", "C"].map((c) => (
                    <div className="hiw-child" key={c}>
                      <div className="ct">child · task {c}</div>
                      <div className="cs">fresh context · full rights</div>
                      <div className="cflow">
                        <span className="down">findings.md → disk</span>
                        <span className="up">summary ≤ 1,200 chars ↑</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <p className="hiw-cap">
                {fanMode === "with"
                  ? "// signal returns to the planner. noise stays on disk, recalled only when a decision needs the detail."
                  : "// without sub-agents, one window absorbs every raw payload and the planner bloats."}
              </p>
            </div>

            <div className="hiw-ledger">
              <div>
                <p className="lg">inherited from parent</p>
                <div className="hiw-pills">
                  {["read", "write", "run code", "remember", "kb read", "kb write"].map((p) => (
                    <span className="hiw-pill new" key={p}>
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="lg">withheld</p>
                <div className="hiw-pills">
                  <span className="hiw-pill mcp">delegate</span>
                  <span className="hiw-pill mcp">schedule</span>
                </div>
                <p className="hiw-cap" style={{ marginTop: 12 }}>
                  {
                    "// withholding these is what keeps nesting exactly one level deep. no fork-bombs."
                  }
                </p>
              </div>
            </div>

            <div className="hiw-specrow">
              <span className="hiw-spec">budget ÷ (N+1)</span>
              <span className="hiw-spec">nesting: 1 level</span>
              <span className="hiw-spec">codex-hardened ×3</span>
            </div>
            <p className="hiw-cap">
              New in 0.2.0, children hold the parent's exact rights and are forged from the same
              spine, so they inherit the same norms and policy. Same rights, and same rules.
            </p>
          </div>
        </section>

        {/* ===== MEMORY + DURABILITY ===== */}
        <section id="memory">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">07 · Memory & learning</p>
              <h2 className="hiw-h2">It learns, and it survives.</h2>
              <p className="hiw-intro">
                The agent turns human corrections into durable lessons, then recovers from restarts,
                drops, and slow turns on its own.
              </p>
            </div>

            <div className="hiw-figure">
              <svg className="dia" viewBox="0 0 720 320" role="img" aria-label="The learning loop">
                <title>The learning loop</title>
                <defs>
                  <marker
                    id="la"
                    markerWidth="9"
                    markerHeight="9"
                    refX="6.5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6.5,3 L0,6 Z" fill="var(--sage)" />
                  </marker>
                </defs>
                {/* nodes */}
                <rect className="svg-box" x={270} y={12} width={180} height={58} rx={12} />
                <text className="svg-t" x={300} y={38}>
                  PROPOSE
                </text>
                <text className="svg-td" x={300} y={54}>
                  the agent drafts a write
                </text>
                <rect className="svg-box-clay" x={512} y={131} width={190} height={58} rx={12} />
                <text className="svg-t" x={532} y={157}>
                  DISPOSE
                </text>
                <text className="svg-td" x={532} y={173}>
                  a human accepts or edits
                </text>
                <rect className="svg-box" x={270} y={250} width={180} height={58} rx={12} />
                <text className="svg-t" x={300} y={276}>
                  REFLECT
                </text>
                <text className="svg-td" x={300} y={292}>
                  it distills into a lesson
                </text>
                <rect className="svg-box" x={18} y={131} width={190} height={58} rx={12} />
                <text className="svg-t" x={38} y={157}>
                  REMEMBER
                </text>
                <text className="svg-td" x={38} y={173}>
                  writes ## Learned
                </text>
                {/* clockwise arcs */}
                <path
                  className="svg-flow"
                  d="M450 44 C540 60, 600 95, 607 128"
                  markerEnd="url(#la)"
                />
                <path
                  className="svg-flow"
                  d="M607 191 C600 235, 500 270, 452 278"
                  markerEnd="url(#la)"
                />
                <path
                  className="svg-flow"
                  d="M270 278 C160 270, 120 235, 113 191"
                  markerEnd="url(#la)"
                />
                <path
                  className="svg-flow march"
                  d="M113 128 C120 90, 200 55, 268 43"
                  markerEnd="url(#la)"
                />
                <text className="svg-lab" x={150} y={92}>
                  better next run
                </text>
                {/* center plate */}
                <rect
                  x={288}
                  y={128}
                  width={144}
                  height={64}
                  rx={10}
                  fill="var(--wash-clay)"
                  stroke="var(--clay)"
                  strokeWidth={1.5}
                />
                <text className="svg-t" x={306} y={152} style={{ fill: "var(--clay)" }}>
                  DELTA.md
                </text>
                <text className="svg-td" x={306} y={168}>
                  ## Learned
                </text>
                <text className="svg-lab" x={306} y={182}>
                  snapshotted · revertible
                </text>
              </svg>
              <p className="hiw-cap">
                {"// a run reads an immutable snapshot, so a self-edit lands on the next run."}
              </p>
            </div>

            <div className="hiw-legend">
              <div className="li">
                <b>remember</b> <span>writes to the living self-file</span>
              </div>
              <div className="li">
                <b>recall</b> <span>searches this thread's history, spilled results included</span>
              </div>
              <div className="li">
                <b>reflect</b> <span>turns reviewer feedback into a durable lesson</span>
              </div>
            </div>

            <div className="hiw-principle">
              <p className="big">The agent proposes. A human approves.</p>
              <p className="sub">
                Writes to shared systems are proposals the human dispositions. The human keeps the
                last word, and every disposition feeds the next lesson.
              </p>
            </div>

            <div className="hiw-dur-head">
              <p className="hiw-kicker">08 · Durability & resilience</p>
              <h2 className="hiw-h2">It survives the real world</h2>
              <p className="hiw-intro">
                Restarts, dropped connections, and slow turns are recoverable events here, not
                failures.
              </p>
            </div>
            <div className="hiw-beats3">
              {[
                [
                  "checkpoint-per-turn",
                  "Crash-safe",
                  "The WAL commits after every turn, so a restart resumes from the last committed turn. Nothing lost, nothing double-run.",
                ],
                [
                  "async + reconciler",
                  "Self-healing",
                  "Long tasks dispatch fire-and-forget over /v1/tasks. A reconciler sweep re-drives anything stuck, and a budget-hit run retries clean.",
                ],
                [
                  "error-as-value",
                  "Never crashes",
                  "A provider or tool failure returns a clean turn the agent can reason about. The daemon does not fall over.",
                ],
              ].map(([tag, h, p]) => (
                <div className="hiw-dbeat" key={h}>
                  <span className="tag">{tag}</span>
                  <h4>{h}</h4>
                  <p>{p}</p>
                </div>
              ))}
            </div>

            <div className="hiw-incident">
              <div className="hiw-step s1">
                <span className="st">incident</span>
                <p>A proxy caps long-held connections, orphaning durable runs.</p>
              </div>
              <span className="hiw-arrow">→</span>
              <div className="hiw-step s2">
                <span className="st">fix</span>
                <p>Move to idempotent async dispatch.</p>
              </div>
              <span className="hiw-arrow">→</span>
              <div className="hiw-step s3">
                <span className="st">resolved</span>
                <p>
                  The reconciler clears the backlog on its own. A budget-death re-drives and files
                  on retry.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== FOOTER CTA ===== */}
        <section id="start">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">Start here</p>
              <h2 className="hiw-h2">Read the code. Run an agent.</h2>
            </div>
            <div className="hiw-cta">
              <a href="/docs/">
                <span className="k">docs</span>
                <span className="t">The technical guide</span>
                <span className="d">Install, configure, deploy, operate.</span>
              </a>
              <a href={repoUrl} target="_blank" rel="noreferrer">
                <span className="k">github</span>
                <span className="t">Carrara-Labs/delta-harness</span>
                <span className="d">The full runtime, open source.</span>
              </a>
              <a href={npmUrl} target="_blank" rel="noreferrer">
                <span className="k">npm</span>
                <span className="t">@carrara-labs/delta-harness</span>
                <span className="d">Install the published package.</span>
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
