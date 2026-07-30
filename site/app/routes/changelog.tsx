// biome-ignore-all lint/security/noDangerouslySetInnerHtml: The only raw HTML is JSON-LD serialized from a static local object.
import { Fragment, type ReactNode, useEffect } from "react";

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

// A CollectionPage (the release history) about the software entity, plus a BreadcrumbList
// so answer engines place it in the site hierarchy.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": `${canonicalUrl}#page`,
      name: pageTitle,
      description,
      url: canonicalUrl,
      inLanguage: "en",
      isPartOf: { "@id": "https://deltaharness.dev/#website" },
      about: { "@id": "https://deltaharness.dev/#software" },
      publisher: {
        "@type": "Organization",
        name: "Carrara Labs",
        logo: {
          "@type": "ImageObject",
          url: "https://deltaharness.dev/delta-logo-light-background.svg",
        },
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Delta", item: "https://deltaharness.dev/" },
        { "@type": "ListItem", position: 2, name: "Changelog", item: canonicalUrl },
      ],
    },
  ],
};

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
    version: "0.2.6",
    date: "July 30, 2026",
    iso: "2026-07-30",
    tagline: "A default deployment that describes itself.",
    latest: true,
    note: "A default deployment that describes itself. Two telemetry blind spots are closed, so a default deployment is fully self-describing: cost, fallbacks, and error classes are queryable without turning on payload capture. The Anthropic fast-mode wire ships inert by default, so enabling it is a single env flip the day an org's allocation lands. No behavior changes when nothing is set; upgrading is a version bump.",
    groups: [
      {
        kind: "added",
        items: [
          "**Safe telemetry without payload consent.** `model.call`, `tool.call`, and `tool.result` now export a closed allowlist of operational attributes (model, provider, tokens, cost, latency, effort, fallback, `error.class`, tool names). Prompts, tool arguments, results, `error.message`, and `tool_calls` still require `DELTA_CAPTURE_PAYLOADS=1`.",
          "**`model.fallback` event** when a call is served by a model other than the configured primary, plus `fallback: true` on that `model.call` and a stderr marker.",
          "**`error.class` on failed `tool.result`** - a low-cardinality class (`self_cap`, `self_conflict`, `timeout`, `transient`, `categorical`, and more). A 200-char `error.message` snippet rides alongside it, local-only unless payload capture is on.",
          "**`gen_ai.request.effort` on `model.call`** - the reasoning effort each call ran at, bounded to the known tiers on export.",
          "**`self.pressure` event + stderr warning** when `DELTA.md` is elided from the prompt (over cap) or over 90% full. Seed `DELTA.md` at no more than half its cap.",
          "**Anthropic fast mode** (`DELTA_SPEED=fast`, off by default, byte-identical when unset). Opus 5 and Opus 4.8 only; the served speed lands on `model.call` telemetry. 2x token pricing, so pair it with a `DELTA_MODEL_PRICES` override.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**The categorical-failure breaker now latches self-write storm classes.** Repeated `remember` refusals whose messages vary per call (byte counts, file text) are now quarantined at 3 instead of grinding. Conflict, transient, and timeout never latch.",
        ],
      },
    ],
  },
  {
    version: "0.2.5",
    date: "July 30, 2026",
    iso: "2026-07-30",
    tagline: "Fast, reliable first turns after idle.",
    note: "The first turn after an idle or suspended machine wakes is now fast and reliable, and a misbehaving provider is visible instead of silent. A rare turn-1 stall traced to the first model call reusing a pooled connection stranded by a suspend/resume, where it hung with no logs and no events; this release heals that automatically, bounds any future stall to seconds, and surfaces every retry. No wire changes, so upgrading is a one-line version bump and every new setting is safe by default.",
    groups: [
      {
        kind: "added",
        items: [
          "**First-byte deadline.** `DELTA_FIRST_BYTE_MS` (default 30s) bounds the connect-and-first-header phase the per-chunk idle watchdog cannot see. A call that cannot reach the provider now fails fast and retries in about 30s instead of hanging on a dead connection up to the 600s cap. On by default and independent of `DELTA_STREAM_IDLE_MS`; set `0` to opt out.",
          "**Self-healing wire after idle or resume.** The first call after a suspend/resume, or after five minutes of silence, automatically opens a fresh connection instead of reusing a stale pooled one, so a woken lane's opening turn just works. A best-effort preconnect at boot and on resume also pays DNS and TLS off the first turn's path. Fully automatic; the only cost is one extra TLS handshake on that first call.",
          "**Retry visibility, end to end.** Every retry, re-auth, model switch, and provider failover now emits a persisted `model.retry` event and one log line, so a host can show real 'retrying' state instead of dead air. `model.call` also carries `wall_ms` and `retries` beside `latency_ms`, so a slow turn's pre-call gap is one query away (`wall_ms` minus `latency_ms`). Nothing to enable.",
          "**`DELTA_CACHE_TTL=1h`** (opt-in, off by default). For a lane serving several turns an hour, keeps the stable prefix (system spine plus tools) cached for an hour instead of five minutes, for a faster and cheaper turn 1. Byte-identical when unset; 1h cache writes bill double, so turn it on only for busy lanes.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "**No more silent retry storms.** Failed model attempts now log one line each, so a retry storm is never silent. Previously only successful calls printed a line.",
        ],
      },
    ],
  },
  {
    version: "0.2.4",
    date: "July 28, 2026",
    iso: "2026-07-28",
    tagline: "Harden what shipped; close the gaps.",
    note: "Security, observability, and performance hardening. No wire changes, so upgrading is a one-line version bump — every change is provider-agnostic and lands with tests.",
    groups: [
      {
        kind: "added",
        items: [
          "**Tunable concurrency.** `DELTA_MAX_CONCURRENCY` sets how many sessions run at once — default **8** (up from 4), clamped 1–256. Sessions stay serial and the queue is tested correct to **128** concurrent runs; the practical ceiling is your provider's rate limit, so keep it low on a subscription key and 25+ on a high-limit API key. Budget roughly **4–15 MB per active run**.",
          "**Live progress without a stream.** `GET /v1/tasks/:id/events?since=<id>` returns a cursor-paged JSON page for hosts that can't hold an SSE connection, and `model.call` events now carry `cache_hit_pct` so you can watch per-turn prompt-cache warmth live instead of reconstructing it after the fact.",
          "**One-step operator-config updates.** The new `delta bundle apply` command (also run on every boot) re-seeds the fixed operator files, validating each first and never touching the agent's learned `DELTA.md`.",
        ],
      },
      {
        kind: "changed",
        items: [
          "**Faster cold starts on scale-to-zero.** A host can now flip `stop` → `suspend` and cut cold start from **~4.7s to ~1.1s**. The write-lease reclaims itself across a suspend instead of exiting and stalling on the platform's restart cap.",
          "**Per-tenant task access.** `GET`/`DELETE /v1/tasks/:id` and `…/events` now enforce that the caller owns the run — a cross-tenant or unknown id both return `404`. Ownership comes from the gateway `x-delta-user` header, never a request body. Set `DELTA_STRICT_TENANT` to require an owner on every run.",
          "**Memory-widening can't be self-asserted.** The metadata that widens a private memory to a broader audience is stripped from every request body by default, so a caller can't self-authorize it. `DELTA_TRUST_REVIEW_METADATA=1` opts a single-tenant daemon back in.",
          "**Read-only research subagents.** A research child is admitted only read-only tools; anything unmarked defaults to mutating, so it can never write, `remember`, or run code mid-run.",
          "**Earlier, cheaper compaction.** The pre-send size gate now projects off the provider's real last-call input, so a long run compacts before it wastes a frontier call on an over-budget request.",
          "**Deterministic memory recall.** An identical query returns the same set every time (ranking no longer drifts on a self-mutating counter). `DELTA_ISOLATE_AGENT_MEMORY` keeps agents on a shared database from reading each other's rows.",
        ],
      },
      {
        kind: "fixed",
        items: [
          "**Concurrent self-writes no longer clobber each other.** Two runs calling `remember` at once used to overwrite each other's `DELTA.md`, silently dropping one lesson. A compare-and-swap now lets both survive.",
          "**No more silently dropped lessons.** A malformed learning could throw and be lost entirely (latent since 0.1.0); it now degrades to a best-effort learning instead of none.",
        ],
      },
    ],
  },
  {
    version: "0.2.3",
    date: "July 28, 2026",
    iso: "2026-07-28",
    tagline: "Failure-visibility, from the field.",
    note: "Driven by Aperture's production field report — two prod agents, the harness's heaviest real consumer. Every item ships with a test.",
    groups: [
      {
        kind: "added",
        items: [
          "A first-class `error` field on `GET /v1/tasks/:id`. It carries the run's last error — the provider or fatal error that ended it — so a plain HTTP poller learns *why* a run failed before its first token instead of seeing a merely-dead run. Both incidents that motivated it were provider errors that failed the run before its first token (Opus 5 rejecting `thinking.type=enabled`; an untranslated fallback id). Per-tool errors stay in the message stream.",
          "Run lifecycle timestamps on `GET /v1/tasks/:id`: `created_at` (accepted), `started_at` (dequeued and began executing), and `finished_at` (terminal), so a host can measure queue wait separately from execution time instead of one faith-based spinner.",
          'Native Anthropic adaptive thinking. `DELTA_REASONING_EFFORT` now maps to `thinking:{type:"adaptive"}` + `output_config.effort` on Claude 4.6+ and every Claude 5 model, which reject the legacy `thinking:{type:"enabled"}`; the budget wire is kept for Claude ≤4.5. On the adaptive path `none`/`minimal` map to `low`, and Delta raises `max_tokens` by an effort-based headroom. Effort control now works on frontier models.',
          "Baked `claude-opus-5` pricing, so the native and subscription paths meter real dollars without a `DELTA_MODEL_PRICES` override.",
          "The four hosting lifecycle contracts are now documented guarantees in `docs/hosting.md` — idempotency keys freed on terminal runs, `recover()` resumes mid-flight runs on boot, `/v1/busy` reports the durable queued-or-running truth, and seeding never touches an existing `DELTA.md` — each pinned by a named guard test so it can't silently regress.",
        ],
      },
      {
        kind: "changed",
        items: [
          "Categorical-failure breaker. A tool that returns the same categorical `[tool error]` on three consecutive turns (a missing CLI, a persistent schema reject) is quarantined for the rest of the run and the model is told to try another approach — a success, transient, or different error resets the count. This caps the field report's worst case (a missing `code` CLI that burned ~$3.50 of a $5.17 run by looping ~17 turns): a live replay spent pennies on the dead end and still filed its output.",
          "The `code` tool self-disables when its CLI isn't an executable file — probed once at boot via `Bun.which` (bare name) or `accessSync(X_OK)` (explicit path), so a capability the daemon can't back is never offered. A CLI that passes the probe but fails at runtime is caught by the breaker instead; the two layers are complementary.",
          "All native-wire model ids are normalized (prefix stripped, dotted versions → dashes) for the primary *and* every fallback, not just the utility model. An untranslated fallback id was one of the two silent zero-token failures the release targets.",
        ],
      },
    ],
  },
  {
    version: "0.2.2",
    date: "July 27, 2026",
    iso: "2026-07-27",
    tagline: "Self-write, budgets, and a channel edge.",
    groups: [
      {
        kind: "added",
        items: [
          "`DELTA_ALLOW_SELF_WRITE` — trusted-gateway self-write. Off by default. When set, the `remember` self-write tool is granted (and pinned) even on the restricted `chat` profile, for a daemon fronted by a trusted, authenticated gateway. This is what lets a chat agent learn safely.",
          "`DELTA_STEP_MAX_TOKENS` — cap the tokens a single tool call may emit, with an honest truncation error for oversized tool calls instead of silent corruption.",
          "Companion package [`@carrara-labs/delta-connect`](https://www.npmjs.com/package/@carrara-labs/delta-connect) — a thin, always-on edge that plugs a Delta agent into a chat channel (Telegram first). The agent scales to zero between messages; the edge holds the conversation. See [/connect](https://deltaharness.dev/connect).",
        ],
      },
      {
        kind: "changed",
        items: [
          "`DELTA_MAX_TOKENS` / `DELTA_MAX_COST_USD` now override the profile budget instead of only narrowing it, so an operator can raise as well as lower a profile's budget explicitly.",
        ],
      },
    ],
  },
  {
    version: "0.2.1",
    date: "July 22, 2026",
    iso: "2026-07-22",
    tagline: "Scale-to-zero, made safe.",
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
  // Lightweight inline Markdown so change entries can be authored naturally: backticks for
  // identifiers (`/v1/busy`), `**bold**` for the lead phrase, `*italic*` for emphasis. Flat
  // tokenizer (no nesting) — code is matched first so backticks are never re-parsed. Keyed by
  // the part's character offset in the source string — stable and unique, never the array index.
  let offset = 0;
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

// A small line icon per change category, drawn in the category's own colour (inherits
// currentColor from the label). Added/Fixed read as positive (sage +/check); Changed/Removed
// read as mutating (clay swap/minus) — two accents, on-system with the rest of the page.
function KindIcon({ kind }: { kind: Kind }) {
  const paths: Record<Kind, ReactNode> = {
    added: <path d="M8 3.4v9.2M3.4 8h9.2" />,
    fixed: <path d="M3.6 8.4l2.9 2.9 5.9-6" />,
    changed: (
      <>
        <path d="M3 6h9M10 4l2 2-2 2" />
        <path d="M13 10H4M6 8l-2 2 2 2" />
      </>
    ),
    removed: <path d="M3.4 8h9.2" />,
  };
  return (
    <svg
      className="chg-ico"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[kind]}
    </svg>
  );
}

export default function Changelog() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
  }, []);

  const latest = releases.find((release) => release.latest) ?? releases[0];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
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
                        <span className="chg-group-label">
                          <KindIcon kind={group.kind} />
                          {kindLabel[group.kind]}
                        </span>
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
