import { useEffect } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/connect.css";

const canonicalUrl = "https://deltaharness.dev/connect";
const pageTitle = "Delta Connect. Put your agent in your chat.";
const description =
  "Delta Connect is a thin, always-on edge that plugs a Delta agent into a chat channel like Telegram. The agent scales to zero between messages; the edge holds the conversation. Includes a Telegram quickstart.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const repoUrl = "https://github.com/Carrara-Labs/delta-harness";

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
      <main id="main" className="connect" tabIndex={-1}>
        {/* ===== HERO ===== */}
        <section className="section connect-hero" id="top">
          <div className="page">
            <p className="section-kicker">Delta Connect</p>
            <h1 className="connect-h1">Put your agent in your chat.</h1>
            <p className="connect-lede">
              Delta Connect is a thin, always-on edge that plugs a Delta agent into a chat channel -
              Telegram first. The edge holds the conversation; the agent stays a lean,
              product-neutral engine that scales to zero between messages. Full capability, near-zero
              cost at rest.
            </p>
            <div className="cta-actions cta-actions-start">
              <a className="button" href="#quickstart">
                Telegram quickstart
              </a>
              <a className="button button-secondary" href={repoUrl} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* ===== HOW IT WORKS ===== */}
        <section className="section" id="how">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">How it works</p>
                <h2 className="section-heading">A thin edge in front of a sleeping agent.</h2>
              </div>
              <div className="section-intro l2-lead">
                <p>
                  The harness runs one agent behind a single HTTP seam and can scale to zero. Delta
                  Connect is the small piece that sits in front: it holds the chat connection so the
                  agent does not have to, and wakes it only when a message arrives.
                </p>
                <ul className="l2-points">
                  <li>
                    <strong>Durable by design</strong>, messages and replies survive restarts -
                    at-least-once, in order
                  </li>
                  <li>
                    <strong>Scales to zero</strong>, the edge is the only always-on part; the agent
                    sleeps between turns
                  </li>
                  <li>
                    <strong>Learns safely</strong>, self-write is off by default and granted only
                    behind a trusted, authenticated gateway
                  </li>
                  <li>
                    <strong>Any model</strong>, run it on a subscription, a direct API key, or
                    OpenRouter
                  </li>
                </ul>
              </div>
            </header>
            <div className="connect-flow">
              <span className="connect-node">Telegram</span>
              <span className="connect-arrow">→</span>
              <span className="connect-node is-edge">Delta Connect · always on</span>
              <span className="connect-arrow">→</span>
              <span className="connect-node">Delta agent · scales to zero</span>
            </div>
          </div>
        </section>

        {/* ===== TELEGRAM QUICKSTART ===== */}
        <section className="section" id="quickstart">
          <div className="page">
            <header className="section-head">
              <div>
                <p className="section-kicker">Telegram quickstart</p>
                <h2 className="section-heading">Talk to your agent in a few steps.</h2>
              </div>
              <p className="section-intro">
                You need Bun, a model key, and a Telegram bot token from @BotFather. Long-poll needs
                no public URL - just outbound HTTPS - so it runs anywhere, even a laptop.
              </p>
            </header>
            <ol className="connect-steps">
              <li>
                <h3>Scaffold an agent</h3>
                <p>Create a bundle, then give it a persona and a model.</p>
                <pre className="connect-code">{`delta init myagent
# edit myagent/DELTA.md (persona) and myagent/delta.env (model + key)`}</pre>
              </li>
              <li>
                <h3>Run the daemon</h3>
                <p>Point the workspace at the bundle and start the agent.</p>
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
                <p>Send it anything. The round trip is Telegram to the edge, to the agent, and back - all durable.</p>
              </li>
            </ol>
            <p className="connect-foot">
              To let the agent learn from you ("remember that ..."), set{" "}
              <code>DELTA_ALLOW_SELF_WRITE=1</code> on the daemon. It is off by default, and safe to
              enable because the connector authenticates the caller before anything reaches the agent.
            </p>
          </div>
        </section>

        {/* ===== CTA ===== */}
        <section className="final-cta" id="cta">
          <div className="page cta-panel">
            <div>
              <p className="section-kicker">Open source</p>
              <h2>Run your own, on your hardware or in the cloud.</h2>
              <p>
                Delta Connect ships with the harness. Read the guide, then bring your agent to your
                phone.
              </p>
            </div>
            <div className="cta-actions">
              <a className="button" href="/how-it-works">
                How Delta works
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
