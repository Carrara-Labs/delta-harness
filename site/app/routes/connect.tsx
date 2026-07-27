import { useEffect } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/how-it-works.css";
import "~/styles/connect.css";

const canonicalUrl = "https://deltaharness.dev/connect";
const pageTitle = "Delta Connect. Put your agent in your chat.";
const description =
  "Delta Connect is a thin, always-on edge that plugs a Delta agent into a chat channel like Telegram. The agent scales to zero between messages; the edge holds the conversation. Includes a Telegram quickstart.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const repoUrl = "https://github.com/Carrara-Labs/delta-harness/tree/main/connect";
const npmUrl = "https://www.npmjs.com/package/@carrara-labs/delta-connect";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "article" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:title", content: "Delta Connect" },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "Delta Connect" },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
  ];
}

export default function Connect() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="hiw connect" tabIndex={-1}>
        {/* ===== HERO ===== */}
        <section className="hiw-hero" id="top">
          <div className="page hiw-hero-grid">
            <div className="hiw-hero-lede">
              <span className="hiw-eyebrow">
                <span className="hiw-dot" /> Companion package · @carrara-labs/delta-connect
              </span>
              <h1 className="hiw-title">Put your agent in your chat.</h1>
              <p className="hiw-subline">
                A thin, always-on edge that plugs a Delta agent into Telegram. The edge holds the
                conversation; the agent scales to zero between messages.
              </p>
              <div className="connect-cta">
                <a className="button" href="#quickstart">
                  Telegram quickstart
                </a>
                <a
                  className="button button-secondary"
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on GitHub
                </a>
              </div>
            </div>

            {/* A tiny Telegram thread: the whole product in one glance. */}
            <aside className="connect-chat" aria-hidden="true">
              <div className="connect-chat-top">
                <span className="connect-avatar">F</span>
                <div>
                  <div className="connect-chat-name">Ferni</div>
                  <div className="connect-chat-sub">delta agent · bot</div>
                </div>
              </div>
              <div className="connect-msgs">
                <div className="cbubble me">remember I ship releases on Fridays</div>
                <div className="cbubble bot">
                  <span className="who">Ferni</span>
                  Noted. I'll keep that in mind.
                </div>
                <div className="cbubble me">what's my release day again?</div>
                <div className="cbubble bot">
                  <span className="who">Ferni</span>
                  Fridays.
                </div>
              </div>
            </aside>
          </div>
        </section>

        {/* ===== 01 · HOW IT WORKS ===== */}
        <section id="how">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">01 · How it works</p>
              <h2 className="hiw-h2">A thin edge in front of a sleeping agent.</h2>
              <p className="hiw-intro">
                The competitors weld the chat socket to the agent, so it can never sleep. Delta
                splits them: the edge is the only always-on part, and the agent wakes only when a
                message arrives.
              </p>
            </div>

            {/* The split: an always-on edge above a scale-to-zero agent, seam between. */}
            <div className="hiw-model">
              <div className="hiw-tier agent">
                <div className="tier-id">
                  <span className="tier-name">THE EDGE</span>
                  <span className="tier-role">always on</span>
                </div>
                <div className="tier-tags">
                  <span className="hiw-chip">holds the socket</span>
                  <span className="hiw-chip">durable inbox + outbox</span>
                  <span className="hiw-chip">authenticates callers</span>
                </div>
              </div>

              <div className="hiw-seam">
                <span className="dir down">
                  <span className="ar" aria-hidden="true">
                    ↓
                  </span>
                  a message arrives, wake the agent
                </span>
                <span className="dir up">
                  the reply goes out, durably
                  <span className="ar" aria-hidden="true">
                    ↑
                  </span>
                </span>
              </div>

              <div className="hiw-tier human">
                <div className="tier-id">
                  <span className="tier-name">THE AGENT</span>
                  <span className="tier-role">scales to zero</span>
                </div>
                <div className="tier-tags">
                  <span className="hiw-chip">wakes on message</span>
                  <span className="hiw-chip">one HTTP seam</span>
                  <span className="hiw-chip">full capability</span>
                </div>
              </div>
            </div>
            <p className="hiw-cap">
              {"// full capability while it works, near-zero cost at rest. the edge idles cheap."}
            </p>

            <div className="connect-beats">
              {(
                [
                  [
                    "at-least-once, in order",
                    "Durable by design",
                    "Every message and reply is written to a durable inbox and outbox before it moves. Nothing is lost, and replies arrive in order.",
                  ],
                  [
                    "wake on message",
                    "Scales to zero",
                    "The edge is the only thing that stays up. The agent sleeps between turns and the host wakes it per message, so idle cost is near zero.",
                  ],
                  [
                    "trusted gateway",
                    "Learns safely",
                    "Self-write is off by default. The edge authenticates and allowlists the caller, so a chat agent can remember what you tell it without exposure.",
                  ],
                  [
                    "bring your own",
                    "Any model",
                    "Run it on a subscription, a direct API key, or OpenRouter. The agent stays a product-neutral engine; the model is just config.",
                  ],
                ] as const
              ).map(([tag, h, p]) => (
                <div className="hiw-dbeat" key={h}>
                  <span className="tag">{tag}</span>
                  <h4>{h}</h4>
                  <p>{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== 02 · DURABLE SPINE ===== */}
        <section id="durable">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">02 · The durable spine</p>
              <h2 className="hiw-h2">A sleeping agent can still never drop a message.</h2>
              <p className="hiw-intro">
                Scaling to zero only works if nothing is lost while the agent is down. The edge owns
                a small, durable spine so a restart mid-conversation is a recoverable event, not a
                dropped reply.
              </p>
            </div>

            <div className="hiw-beats3">
              {(
                [
                  [
                    "inbox + dedup",
                    "Accepted before awake",
                    "The edge acknowledges the platform and writes the message to a durable inbox before the agent is even up. Re-deliveries are deduped by event id, so nothing runs twice.",
                  ],
                  [
                    "atomic commit",
                    "One transaction per turn",
                    "Session state, the outbound reply, and marking the message done all commit in a single transaction. A crash leaves no half-finished turn behind.",
                  ],
                  [
                    "outbox + backoff",
                    "Delivered on wake",
                    "Replies queue in a durable outbox and send in strict order, honouring rate limits with backoff. A whole reply group dead-letters together rather than arriving scrambled.",
                  ],
                ] as const
              ).map(([tag, h, p]) => (
                <div className="hiw-dbeat" key={h}>
                  <span className="tag">{tag}</span>
                  <h4>{h}</h4>
                  <p>{p}</p>
                </div>
              ))}
            </div>

            <div className="hiw-incident">
              <div className="hiw-step s1">
                <span className="st">message</span>
                <p>You send a message while the agent is scaled to zero.</p>
              </div>
              <span className="hiw-arrow">→</span>
              <div className="hiw-step s2">
                <span className="st">durable</span>
                <p>The edge 2xx's the platform, writes it to the inbox, and wakes the agent.</p>
              </div>
              <span className="hiw-arrow">→</span>
              <div className="hiw-step s3">
                <span className="st">delivered</span>
                <p>The agent runs the turn; the reply leaves the outbox in order. Nothing lost.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== 03 · TELEGRAM QUICKSTART ===== */}
        <section id="quickstart">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">03 · Telegram quickstart</p>
              <h2 className="hiw-h2">Talk to your agent in four steps.</h2>
              <p className="hiw-intro">
                You need Bun, a model key, and a Telegram bot token from @BotFather. Long-poll needs
                no public URL, just outbound HTTPS, so it runs anywhere, even a laptop.
              </p>
            </div>

            <ol className="connect-steps">
              <li>
                <h3>Scaffold and configure the agent</h3>
                <p>
                  Create a bundle, give it a persona, then set the model and the safe chat profile.
                </p>
                <pre className="connect-code">{`delta init myagent
# edit myagent/DELTA.md (persona), then in myagent/delta.env:
DELTA_MODEL_PRIMARY=anthropic/claude-sonnet-5   # + your provider key
DELTA_PROFILE=chat              # chat mode: read-only tools, no code/delegation
DELTA_REFLECT=1                 # turn on the learning loop
DELTA_ALLOW_SELF_WRITE=1        # let it "remember" behind the trusted gateway
DELTA_WORKSPACE=/abs/path/to/myagent   # read the persona, persist memory here`}</pre>
              </li>
              <li>
                <h3>Run the daemon</h3>
                <p>
                  Source the bundle env, then start the agent (bare <code>delta</code> does not read{" "}
                  <code>delta.env</code> on its own).
                </p>
                <pre className="connect-code">{`cd myagent && set -a && . ./delta.env && set +a && delta`}</pre>
              </li>
              <li>
                <h3>Start the connector</h3>
                <p>Give it your bot token and the daemon URL, and lock it to your own chat.</p>
                <pre className="connect-code">{`# connect/.env
TELEGRAM_BOT_TOKEN=...          # from @BotFather
DELTA_BASE_URL=http://127.0.0.1:8321
ALLOWED_TELEGRAM_USER_IDS=      # your id (send /id to get it)

bun start`}</pre>
              </li>
              <li>
                <h3>Message your bot</h3>
                <p>
                  Send it anything. The round trip is Telegram to the edge, to the agent, and back,
                  all durable.
                </p>
              </li>
            </ol>

            <p className="connect-foot">
              A channel agent runs on the <code>chat</code> profile: read-only tools, no code or
              delegation, because raw inbound chat is untrusted.{" "}
              <code>DELTA_ALLOW_SELF_WRITE=1</code> (off by default) is what grants the{" "}
              <code>remember</code> tool on that profile, and it is safe here because the connector
              authenticates and allowlists the caller before anything reaches the agent.
            </p>
          </div>
        </section>

        {/* ===== FOOTER CTA ===== */}
        <section id="start">
          <div className="page">
            <div className="hiw-head">
              <p className="hiw-kicker">Start here</p>
              <h2 className="hiw-h2">Ships with the harness. Bring your agent to your phone.</h2>
            </div>
            <div className="hiw-cta">
              <a className="cta-github" href={repoUrl} target="_blank" rel="noreferrer">
                <span className="ic" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                </span>
                <span className="k">github</span>
                <span className="t">Carrara-Labs/delta-harness · /connect</span>
                <span className="d">The connector source, open source.</span>
              </a>
              <a className="cta-npm" href={npmUrl} target="_blank" rel="noreferrer">
                <span className="ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
                  </svg>
                </span>
                <span className="k">npm</span>
                <span className="t">@carrara-labs/delta-connect</span>
                <span className="d">Install the published package.</span>
              </a>
              <a className="cta-docs" href="/how-it-works">
                <span className="ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 6.6C10.5 5.6 8.2 5 6.2 5H3.5v13.2h2.7c2 0 4.3.6 5.8 1.6M12 6.6c1.5-1 3.8-1.6 5.8-1.6h2.7v13.2h-2.7c-2 0-4.3.6-5.8 1.6M12 6.6v13.2"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="k">how it works</span>
                <span className="t">The Delta runtime, end to end</span>
                <span className="d">The engine the agent runs on.</span>
              </a>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
