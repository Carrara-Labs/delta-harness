import { Fragment, useEffect } from "react";

import { SiteFooter, SiteHeader } from "~/components/landing";
import "~/styles/landing.css";
import "~/styles/enhancements.css";
import "~/styles/changelog.css";

const canonicalUrl = "https://deltaharness.dev/changelog";
const pageTitle = "Changelog. Every Delta release, in the open.";
const description =
  "The complete release history of the Delta agent harness, from the first public npm package to today. Every version, every change, aligned to the source CHANGELOG.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const repoUrl = "https://github.com/Carrara-Labs/delta-harness";
const releasesUrl = "https://github.com/Carrara-Labs/delta-harness/releases";
const changelogSourceUrl = "https://github.com/Carrara-Labs/delta-harness/blob/main/CHANGELOG.md";
const npmUrl = "https://www.npmjs.com/package/@carrara-labs/delta-harness";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:title", content: "Delta changelog." },
    { property: "og:description", content: description },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "Delta changelog." },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: socialImageUrl },
  ];
}

type Kind = "added" | "changed" | "fixed" | "removed";

type ChangeGroup = { kind: Kind; items: string[] };

type Release = {
  version: string;
  date: string;
  iso: string;
  tagline: string;
  latest?: boolean;
  note?: string;
  groups: ChangeGroup[];
};

const kindLabel: Record<Kind, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
};

// Mirrors the canonical source history at CHANGELOG.md (Keep a Changelog / SemVer).
// Newest first. Prose is written for a reader; the categories and facts track the source
// exactly. Update this alongside the root CHANGELOG.md when a release ships.
const releases: Release[] = [
  {
    version: "0.2.1",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Scale-to-zero, made safe.",
    latest: true,
    groups: [
      {
        kind: "added",
        items: [
          "`GET /v1/busy` — the scale-to-zero lifecycle signal. A host managing suspend and resume can ask the daemon “is it safe to suspend?” and get `{ busy, running, queued }`, read from the durable run table so a machine is never suspended with work still owed — including a queued run that hasn't started. It sits behind the `/v1/` control-token gate, deliberately not folded into the open, data-free `/healthz`.",
          "`docs/hosting.md` — the hosting lifecycle contract: control-plane-owned suspend and resume, the three host hooks (wake before dispatch, busy-check before suspend, suspend after terminal), and the WAL suspend-safety guarantee that makes aggressive suspend safe.",
        ],
      },
      {
        kind: "changed",
        items: [
          "`DELTA_MCP_SERVERS` parsing fails loud, never silent. A malformed value used to boot the agent tool-less and burn a full model run before anyone noticed. Malformed JSON, a non-array, and each unusable entry are now dropped with a specific boot-log warning — and a missing `transport` is inferred from the entry shape (`url` → `http`, `command` → `stdio`) so a common omission just works.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "A bad `stdio` MCP server no longer crashes boot. A command that spawns and throws synchronously is now caught inside the registry boundary and logged, and the daemon boots with the remaining backends — honoring the “one bad server is never fatal” contract.",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Sub-agents grow up.",
    groups: [
      {
        kind: "changed",
        items: [
          "Sub-agents (`research`) now hold the same rights as the parent, not a read-only subset. A child's callable tools are the parent's full registry minus a small withheld set (the delegation tools `research`/`spawn_subagent`/`eval_n`, plus the run-scheduling tools), so nesting stays exactly one level deep. A child can read, write, run code, `remember`, and call MCP reads and writes — whatever the parent can — and it's built from the same system spine, so it inherits the parent's rules along with its rights.",
        ],
      },
      {
        kind: "removed",
        items: [
          "`DELTA_RESEARCH_TOOLS`. The operator allowlist that gated which MCP reads a `research` child could use is gone — children inherit the parent's tools directly. The variable is now ignored; remove it from any config.",
        ],
      },
    ],
  },
  {
    version: "0.1.2",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Safe-to-retry dispatch.",
    groups: [
      {
        kind: "added",
        items: [
          "Dispatch idempotency for `POST /v1/tasks`. A run request may carry an `idempotency_key`; a retry dedupes onto the live run instead of starting a duplicate, so fire-and-forget async dispatch is safe to retry. Race-safe with no schema migration, and it composes with `store: false`.",
        ],
      },
    ],
  },
  {
    version: "0.1.1",
    date: "July 16, 2026",
    iso: "2026-07-16",
    tagline: "Container image, cleaner clone.",
    groups: [
      {
        kind: "added",
        items: [
          "Published `docker run` image at `ghcr.io/carrara-labs/delta-harness`, documented on the Deploy guide.",
          "Hardened release and secret-scan workflows: checksum-verified gitleaks, a tag-gated scan, and ghcr publish.",
        ],
      },
      {
        kind: "changed",
        items: [
          "Clearer, more technical README and npm package description.",
          "Removed stale monorepo doc-sync tooling so `bun run check` works on a clean clone.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "Sub-agents inherit the parent's model: `childEnv` forwards `DELTA_MODEL_PRIMARY`, not just the legacy `DELTA_MODEL` alias.",
        ],
      },
    ],
  },
  {
    version: "0.1.0",
    date: "July 16, 2026",
    iso: "2026-07-16",
    tagline: "Delta, in the open.",
    note: "Initial public release.",
    groups: [
      {
        kind: "added",
        items: [
          "Product-neutral engine: a durable Run and queue (crash- and redeploy-resumable), a zero-dependency OpenAI-compatible provider with model failover and prompt-cache breakpoints, the tool-call loop with builtins and profiles, an MCP client with progressive tool disclosure, usage-aware compaction, a governed memory rail, and NDJSON observability.",
          "The bundle model (`agent = engine + bundle + state`): `delta init` scaffolds a bundle and `delta dev` boots the local Cockpit.",
          "The HTTP seam: `POST /v1/responses`, `GET /healthz`, and the async `POST /v1/tasks` surface.",
          "Apache 2.0 license, single-binary builds, and the container image.",
        ],
      },
    ],
  },
];

function renderInline(text: string) {
  // Lightweight inline-code rendering so change entries can name identifiers naturally
  // with backticks (`/v1/busy`) without hand-writing <code> in the data. Keyed by the
  // part's character offset in the source string — stable and unique, never the array index.
  let offset = 0;
  return text.split(/(`[^`]+`)/g).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export default function Changelog() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
  }, []);

  const latest = releases.find((release) => release.latest) ?? releases[0];

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="chg" tabIndex={-1}>
        {/* ===== HERO ===== */}
        <section className="chg-hero" id="top">
          <div className="page">
            <div className="chg-hero-inner">
              <span className="chg-eyebrow">
                <span className="chg-dot" /> Changelog
              </span>
              <h1 className="chg-title">Every release, in the open.</h1>
              <p className="chg-subline">
                The complete history of the Delta harness, from the first public package to today.
                Each version tracks the source <code>CHANGELOG.md</code> exactly — nothing shipped
                quietly.
              </p>
              <div className="chg-hero-actions">
                <span className="chg-current">
                  <span className="chg-current-label">Latest</span>
                  <span className="chg-current-ver">v{latest.version}</span>
                </span>
                <a className="chg-link" href={npmUrl} target="_blank" rel="noreferrer">
                  npm package
                </a>
                <a className="chg-link" href={releasesUrl} target="_blank" rel="noreferrer">
                  GitHub releases
                </a>
                <a className="chg-link" href={changelogSourceUrl} target="_blank" rel="noreferrer">
                  Source CHANGELOG
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ===== TIMELINE ===== */}
        <section className="chg-body-section">
          <div className="page">
            <div className="chg-timeline">
              {releases.map((release) => (
                <article
                  key={release.version}
                  className="chg-release"
                  aria-labelledby={`v-${release.version}`}
                >
                  <header className="chg-meta">
                    <h2 className="chg-version" id={`v-${release.version}`}>
                      v{release.version}
                    </h2>
                    {release.latest ? <span className="chg-latest">Latest</span> : null}
                    <time className="chg-date" dateTime={release.iso}>
                      {release.date}
                    </time>
                  </header>

                  <div className="chg-content">
                    <p className="chg-tagline">{release.tagline}</p>
                    {release.note ? <p className="chg-note">{release.note}</p> : null}

                    {release.groups.map((group) => (
                      <div className="chg-group" data-kind={group.kind} key={group.kind}>
                        <span className="chg-group-label">{kindLabel[group.kind]}</span>
                        <ul className="chg-items">
                          {group.items.map((item) => (
                            <li key={item.slice(0, 48)}>{renderInline(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ===== FOOTNOTE ===== */}
        <section className="chg-foot">
          <div className="page">
            <div className="chg-foot-inner">
              <p>
                Delta follows{" "}
                <a href="https://semver.org" target="_blank" rel="noreferrer">
                  Semantic Versioning
                </a>
                . A daemon reports its running version at <code>/healthz</code>, and upgrades only
                ever move a deployed agent's database forward.
              </p>
              <p>
                Watch the{" "}
                <a href={repoUrl} target="_blank" rel="noreferrer">
                  repository
                </a>{" "}
                for what's next.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
