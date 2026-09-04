// biome-ignore-all lint/security/noDangerouslySetInnerHtml: The only raw HTML is JSON-LD serialized from a static local object.
import {
  Blocks,
  Bot,
  FolderGit2,
  Layers,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Triangle,
} from "lucide-react";
import { useEffect } from "react";

import {
  BuildSection,
  CodingAgentsSection,
  DeploySection,
  ModelsSection,
  ObserveSection,
  ProductSection,
  SiteFooter,
  SiteHeader,
} from "~/components/landing";
import { InstallTabs } from "~/components/landing/install-tabs";
import { initializeLandingInteractions } from "~/legacy/landing-interactions";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/landing-2.css";

const canonicalUrl = "https://deltaharness.dev/";
const pageTitle = "Delta - Autonomous agents for knowledge work";
const socialTitle = "Autonomous agents for knowledge work.";
const description =
  "Delta is a lean TypeScript-on-Bun harness for knowledge-work agents. Build a full autonomous teammate, or make a product feature agentic - self-hosted, model-agnostic, self-learning, and cheap to run.";
const socialImageUrl = `${canonicalUrl}delta-og-image.png`;
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    {
      tagName: "link",
      rel: "alternate",
      type: "text/markdown",
      href: `${canonicalUrl}guide.md`,
      title: "Delta guide in Markdown",
    },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:locale", content: "en_US" },
    { property: "og:title", content: socialTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:type", content: "image/png" },
    { property: "og:image:width", content: "2401" },
    { property: "og:image:height", content: "1260" },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: socialTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
    { name: "twitter:image:alt", content: socialImageAlt },
  ];
}

const repositoryUrl = "https://github.com/Carrara-Labs/delta-harness";

// A @graph rather than a bare WebSite: search and answer engines resolve Delta as a
// software entity (not just a page) from SoftwareApplication + SoftwareSourceCode, which
// is what earns rich results and citation in AI answers.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${canonicalUrl}#website`,
      name: "Delta",
      alternateName: "Delta Harness",
      url: canonicalUrl,
      description,
      inLanguage: "en",
      publisher: { "@id": `${canonicalUrl}#organization` },
    },
    {
      "@type": "Organization",
      "@id": `${canonicalUrl}#organization`,
      name: "Carrara Labs",
      url: canonicalUrl,
      logo: `${canonicalUrl}delta-logo-light-background.svg`,
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${canonicalUrl}#software`,
      name: "Delta Harness",
      alternateName: "Delta",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI agent runtime",
      operatingSystem: "macOS, Linux",
      url: canonicalUrl,
      downloadUrl: `${canonicalUrl}install.sh`,
      softwareVersion: "0.2.17",
      description,
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@type": "Person", name: "Nicolas Touron" },
      publisher: { "@id": `${canonicalUrl}#organization` },
      featureList: [
        "Durable run queue with checkpoint-per-turn crash and redeploy recovery",
        "MCP client over streamable HTTP and stdio with progressive tool disclosure",
        "Usage-aware context compaction for long-running tasks",
        "Scoped memory and a review-to-reflect self-improvement loop",
        "Model-agnostic OpenAI-compatible provider with failover and cost capture",
        "Single self-contained binary with zero runtime dependencies",
      ],
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${canonicalUrl}#sourcecode`,
      name: "Delta Harness",
      codeRepository: repositoryUrl,
      programmingLanguage: "TypeScript",
      runtimePlatform: "Bun",
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      about: { "@id": `${canonicalUrl}#software` },
    },
  ],
};

const STATS = [
  { value: "< 10ms", label: "cold start" },
  { value: "< 2k tokens", label: "system spine" },
  { value: "¢ / agent", label: "scale-to-zero on Fly" },
  { value: "6–9× cheaper", label: "than a hosted runtime" },
];

/** Small inline checkmark / cross for the versus panels. */
function Mark({ ok }: { ok: boolean }) {
  return (
    <svg className="l2-mark" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {ok ? (
        <path
          d="M4 10.5l4 4 8-9"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M6 6l8 8M14 6l-8 8"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const CAPS = [
  {
    icon: Blocks,
    title: "Work across tools and files",
    body: "Research and act through MCP, work in a full file workspace, delegate to subagents, drive a coding-agent CLI, and run on a schedule.",
    tags: ["MCP tools", "Subagents", "Code CLI", "Cron schedules", "Workspace"],
  },
  {
    icon: Sparkles,
    title: "Learns as it works",
    body: "Carries scoped memory across runs, reflects on real feedback, and updates a versioned self-file - sharper the more the team uses it.",
    tags: ["Scoped memory", "Cross-run recall", "Reflection", "Self-learning"],
  },
  {
    icon: SlidersHorizontal,
    title: "Yours to shape",
    body: "Five plain files define an agent - model-agnostic and fully customizable. Version it, review it, and change it without a framework.",
    tags: ["Bundle files", "Vocabulary", "Model-agnostic", "Fully customizable"],
  },
  {
    icon: ShieldCheck,
    title: "Safe and durable",
    body: "Checkpointed so long tasks survive a restart, with scoped permissions, a fixed policy, and optional ephemeral data that can't leak.",
    tags: ["Checkpoints", "Scoped access", "Fixed policy", "Ephemeral"],
  },
];

export default function Home() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
    initializeLandingInteractions();
  }, []);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div
        className="sr-only"
        id="copy-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />

      <SiteHeader />
      <main className="l2" id="main" tabIndex={-1}>
        {/* ============ Hero ============ */}
        <section className="hero" id="top">
          <div className="page hero-inner">
            <div className="hero-lede">
              <p className="eyebrow">
                <span className="eyebrow-dot" aria-hidden="true" />
                The open-source harness for knowledge work
              </p>
              <h1>Create your own autonomous agents and agentic product features.</h1>
              <p className="hero-copy">
                Delta is a lean TypeScript-on-Bun harness that is cheap to run, self-hostable,
                model-agnostic, and easy to configure.
              </p>
              <div className="hero-actions">
                <a className="button" href="#build">
                  Start building
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M4 10h11M11 6l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
                <a className="button button-secondary" href="/how-it-works">
                  See how it works
                </a>
              </div>
            </div>

            <InstallTabs />
          </div>
        </section>

        {/* ============ Numeric proof strip ============ */}
        <div className="l2-statband">
          <div className="page">
            <div className="l2-stats">
              {STATS.map(({ value, label }) => (
                <div className="l2-stat" key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ============ Why we built it (difference merged in) ============ */}
        <section className="section" id="why">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">Learn why we built it</p>
                <h2 className="section-heading">The lean harness we wanted to build on.</h2>
              </div>
              <div className="section-intro l2-lead">
                <p>
                  We wanted a harness lean and cheap enough to run one agent per user, yet fully
                  featured and genuinely smart - built for the specialized knowledge work no coding
                  harness is made for.
                </p>
                <ul className="l2-points">
                  <li>
                    <strong>Open-source and self-hosted</strong>, so we own the whole stack
                  </li>
                  <li>
                    <strong>Model-agnostic</strong>, so we're never locked to one provider
                  </li>
                  <li>
                    <strong>Token-efficient by design</strong>, cheap to run always-on
                  </li>
                  <li>
                    <strong>Fully customizable</strong>, with no framework to fight
                  </li>
                </ul>
              </div>
            </header>

            <div className="l2-versus">
              <div className="l2-panel">
                <div className="l2-panel-head">
                  <span className="l2-ic" aria-hidden="true">
                    <FolderGit2 />
                  </span>
                  <div>
                    <span className="l2-panel-tag">Coding harnesses</span>
                    <strong>Built around the repo</strong>
                  </div>
                </div>
                <ul>
                  <li>
                    <Mark ok={false} />
                    Assume the work is code in a repository
                  </li>
                  <li>
                    <Mark ok={false} />
                    Heavy runtime, large sprawling prompts
                  </li>
                  <li>
                    <Mark ok={false} />
                    Token-hungry - costly to run many, always on
                  </li>
                </ul>
              </div>
              <div className="l2-panel is-delta">
                <div className="l2-panel-head">
                  <span className="l2-ic" aria-hidden="true">
                    <Triangle />
                  </span>
                  <div>
                    <span className="l2-panel-tag">Delta</span>
                    <strong>Built around the outcome</strong>
                  </div>
                </div>
                <ul>
                  <li>
                    <Mark ok={true} />
                    Works across tools, files, and a company brain
                  </li>
                  <li>
                    <Mark ok={true} />
                    One binary, a sub-2k-token system spine
                  </li>
                  <li>
                    <Mark ok={true} />
                    Cheap enough to run one agent per user
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ============ Built-in capabilities ============ */}
        <section className="section" id="runtime">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">Skip the wiring</p>
                <h2 className="section-heading">Everything an agent needs, built in.</h2>
              </div>
              <p className="section-intro">
                No framework to learn - a lean runtime with the tools, memory, learning, and
                controls already wired in.
              </p>
            </header>

            <div className="l2-caps">
              {CAPS.map(({ icon: Icon, title, body, tags }) => (
                <article className="l2-cap" key={title}>
                  <span className="l2-ic" aria-hidden="true">
                    <Icon />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                  <div className="l2-cap-tags">
                    {tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ============ Two shapes ============ */}
        <section className="section" id="modes">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">Use it two ways</p>
                <h2 className="section-heading">One runtime. Two shapes.</h2>
              </div>
              <p className="section-intro">
                A person opens a thread, or your product does. The engine, tools, and review loop
                underneath are the same - what changes is where the human gives feedback.
              </p>
            </header>

            <div className="l2-modes">
              <article className="l2-mode type-auto">
                <span className="l2-fieldic" aria-hidden="true">
                  <Bot />
                </span>
                <span className="l2-mode-num">01 · Autonomous agent</span>
                <h3>A teammate that does the work end to end.</h3>
                <p>
                  A person opens one thread per task. The agent researches, works across tools and
                  files, and proposes the result - learning from how each proposal is reviewed.
                </p>
                <div className="l2-mode-flow">
                  <span>Research</span>
                  <span>Tools</span>
                  <span>Propose</span>
                </div>
              </article>
              <article className="l2-mode type-feature">
                <span className="l2-fieldic" aria-hidden="true">
                  <Sparkles />
                </span>
                <span className="l2-mode-num">02 · Agentic feature</span>
                <h3>Turn a one-shot LLM call into an agent that improves.</h3>
                <p>
                  Your product opens the thread, seeded with task context. The agent drafts,
                  proposes, and reflects on the diff - learning proposed-versus-accepted, per use
                  case.
                </p>
                <div className="l2-mode-flow">
                  <span>Draft</span>
                  <span>Propose</span>
                  <span>Reflect</span>
                </div>
              </article>
            </div>

            <div className="l2-underneath">
              <span className="l2-ic" aria-hidden="true">
                <Layers />
              </span>
              <div>
                <strong>One engine underneath.</strong>{" "}
                <span>
                  One loop, one memory model, one bundle per agent - two products, one thing to
                  operate.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ============ Providers · Coding-agent integration (reused) ============ */}
        <ModelsSection kicker="Bring any model" heading="Never locked to a single provider." />
        <CodingAgentsSection kicker="Need it to code?" heading="Hand off to a coding agent." />

        {/* ============ Built on Delta ============ */}
        <section className="section" id="built-on">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">See it in production</p>
                <h2 className="section-heading">We run our own company on Delta.</h2>
              </div>
              <p className="section-intro">
                Carrara ships internal tools and production software for clients with Delta agents -
                which is how the harness gets sharper and more robust in production.
              </p>
            </header>

            <div className="l2-proof">
              {/* Company Brain - our internal platform */}
              <article className="l2-primary">
                <div className="l2-primary-head">
                  <span className="l2-logo">
                    <img src="/quarry-brain-logo.svg" alt="Company Brain" width="48" height="48" />
                  </span>
                  <div>
                    <p className="l2-primary-kicker">Our platform</p>
                    <h3>Company Brain</h3>
                  </div>
                </div>
                <p className="l2-primary-desc">
                  Our macOS app for running the company - project management and company context.
                  Includes its own MCP, an AI chat, autonomous Delta agents, and automatic granular
                  meeting processing.
                </p>
                <div className="l2-subcards two">
                  <article className="l2-sub type-auto">
                    <div className="l2-sub-head">
                      <span className="l2-sub-ic" aria-hidden="true">
                        <Bot />
                      </span>
                      <span className="l2-sub-label">Autonomous agent</span>
                    </div>
                    <h4>Autonomous brain agents</h4>
                    <p>
                      Work directly on the brain, scoped to each client's connectors and permissions
                      - real context, real tools, done autonomously within bounds.
                    </p>
                    <div className="l2-sub-tags">
                      <span>Scoped data</span>
                      <span>Per-client perms</span>
                    </div>
                  </article>
                  <article className="l2-sub type-feature">
                    <div className="l2-sub-head">
                      <span className="l2-sub-ic" aria-hidden="true">
                        <Sparkles />
                      </span>
                      <span className="l2-sub-label">Agentic feature</span>
                    </div>
                    <h4>Meeting processor</h4>
                    <p>
                      A specialized agent that explores the brain and captures structured outcomes -
                      tasks, learnings, risks - from every meeting. Learns from your edits; data is
                      ephemeral.
                    </p>
                    <div className="l2-sub-tags">
                      <span>Self-learning</span>
                      <span>Ephemeral</span>
                    </div>
                  </article>
                </div>
              </article>

              {/* Aperture - our AI recruiter product */}
              <article className="l2-primary">
                <div className="l2-primary-head">
                  <span className="l2-logo">
                    <img src="/aperture-logo.svg" alt="Aperture" width="48" height="48" />
                  </span>
                  <div>
                    <p className="l2-primary-kicker">Our product</p>
                    <h3>Aperture</h3>
                  </div>
                </div>
                <p className="l2-primary-desc">
                  The end-to-end AI recruiter platform we build for ourselves and our clients.
                </p>
                <div className="l2-subcards">
                  <article className="l2-sub type-feature">
                    <div className="l2-sub-head">
                      <span className="l2-sub-ic" aria-hidden="true">
                        <Sparkles />
                      </span>
                      <span className="l2-sub-label">Agentic features</span>
                    </div>
                    <h4>One deployed agent per feature</h4>
                    <p>
                      Every product feature is its own Delta agent, deployed one per tenant. Around
                      fifteen of them - each self-learning, and costing under a dollar a month.
                    </p>
                    <ul className="l2-sub-examples">
                      <li>Intake calls</li>
                      <li>Sourcing</li>
                      <li>Screening</li>
                      <li>Scheduling</li>
                      <li>Offers</li>
                    </ul>
                    <div className="l2-sub-tags">
                      <span>15 features</span>
                      <span>One agent / tenant</span>
                      <span>&lt; $1 each</span>
                    </div>
                  </article>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ============ Go deeper: Test → Deploy → Telemetry (reused) ============ */}
        <ProductSection
          kicker="Test your agent"
          heading="Interact with your agent, inspect every step."
        />
        <DeploySection kicker="Ship it" heading="Deploy your Delta agent." />
        <ObserveSection kicker="Track everything" heading="Traces, tokens, and cost, for free." />

        {/* ============ Get started (reused build section) ============ */}
        <BuildSection
          kicker="Get started"
          heading="Get started in three simple steps."
          intro="Install the binary, scaffold a versionable agent bundle, and open the Cockpit locally - then ship the same binary to your cloud."
        />

        {/* ============ Delta Connect ============ */}
        <section className="section connect-band" id="connect">
          <div className="page connect-band-grid">
            <div className="connect-band-copy">
              <p className="section-kicker">New · Delta Connect</p>
              <h2 className="section-heading">Put your agent in your chat.</h2>
              <p>
                A thin, always-on edge that plugs a Delta agent into a chat channel. The edge holds
                the conversation; the agent scales to zero between messages.
              </p>
              <ul className="l2-points">
                <li>
                  <strong>Any channel</strong>, behind one small connector - Telegram today
                </li>
                <li>
                  <strong>Scales to zero</strong>, full capability, near-zero cost at rest
                </li>
                <li>
                  <strong>Learns from you</strong>, safely behind a trusted gateway
                </li>
              </ul>
              <div className="cta-actions cta-actions-start">
                <a className="button" href="/connect">
                  Explore Delta Connect
                </a>
              </div>
            </div>
            <div className="connect-band-visual" aria-hidden="true">
              <div className="cflow">
                <div className="cflow-node">
                  <span className="cflow-label">Telegram</span>
                  <span className="cflow-sub">your chat</span>
                </div>
                <span className="cflow-link" />
                <div className="cflow-node is-edge">
                  <span className="cflow-label">Delta Connect</span>
                  <span className="cflow-sub">always on · holds the socket</span>
                </div>
                <span className="cflow-link" />
                <div className="cflow-node is-sleep">
                  <span className="cflow-label">Delta agent</span>
                  <span className="cflow-sub">scales to zero · wakes on message</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============ Final CTA ============ */}
        <section className="final-cta" id="cta">
          <div className="page cta-panel">
            <div>
              <p className="section-kicker">One guide, for humans and models</p>
              <h2>Build, inspect, deploy, and recover - from one place.</h2>
              <p>
                The canonical operating guide is written for engineers and language models alike.
              </p>
            </div>
            <div className="cta-actions">
              <a className="button" href="/how-it-works">
                See how it works
              </a>
              <a className="button button-secondary" href="/docs/">
                Read the docs
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
