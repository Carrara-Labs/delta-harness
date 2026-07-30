// Regenerates public/docs/index.html (served at deltaharness.dev/docs) from the
// canonical Markdown in public/guide.md. This is the OSS docs generator: it is the
// self-contained successor to the pre-migration delta/website build-docs.ts +
// website-react-router sync-docs.mjs pipeline, wired to the neutralized guide and the
// Carrara-Labs/delta-harness repo. guide.md is the single source of truth; this file
// owns the render. Run: `bun run build:docs` (or with --check in CI).
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

type NavigationGroup = {
  label: string;
  items: Array<{ heading: string; label: string }>;
};

type SourceDocument = {
  slug: string;
  label: string;
  description: string;
  source: string;
  sourceLabel?: string;
  navigation: NavigationGroup[];
};

type Heading = { id: string; title: string; sourceLevel: number };
type RenderedDocument = SourceDocument & { headings: Heading[]; html: string };

const root = resolve(import.meta.dir, "..");
const templatePath = resolve(import.meta.dir, "docs.template.html");
const outputPath = resolve(root, "public/docs/index.html");
const githubSourceBase = "https://github.com/Carrara-Labs/delta-harness/blob/main/";

// SEO block injected into the generated <title> (ported from sync-docs.mjs).
const docsTitle = "Delta Docs - Build and operate durable agents";
const docsDescription =
  "From first local run to secure production: configure models, MCP tools, memory, subagents, observability and durable execution.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";
const seo = `
    <meta name="description" content="${docsDescription}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="https://deltaharness.dev/docs/" />
    <link rel="alternate" type="text/markdown" href="https://deltaharness.dev/guide.md" title="Delta guide in Markdown" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Delta" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:title" content="${docsTitle}" />
    <meta property="og:description" content="${docsDescription}" />
    <meta property="og:url" content="https://deltaharness.dev/docs/" />
    <meta property="og:image" content="${socialImageUrl}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="2401" />
    <meta property="og:image:height" content="1260" />
    <meta property="og:image:alt" content="${socialImageAlt}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${docsTitle}" />
    <meta name="twitter:description" content="${docsDescription}" />
    <meta name="twitter:image" content="${socialImageUrl}" />
    <meta name="twitter:image:alt" content="${socialImageAlt}" />`;

if (!Bun.markdown?.html) {
  throw new Error("The docs build requires a Bun release with Bun.markdown.html");
}

const documents: SourceDocument[] = [
  {
    slug: "guide",
    label: "Delta guide",
    description: "One source of truth, from the first local run to secure production operation.",
    source: "public/guide.md",
    sourceLabel: "Canonical Markdown",
    navigation: [
      {
        label: "Start",
        items: [
          { heading: "Delta Agent Harness", label: "Overview" },
          { heading: "Start here", label: "Quickstart" },
          { heading: "Use Delta with coding agents", label: "For coding agents" },
          { heading: "Mental model", label: "How Delta works" },
        ],
      },
      {
        label: "Build",
        items: [
          { heading: "Two ways to build", label: "Assistant or feature" },
          { heading: "Configure the five-file bundle", label: "Agent files" },
          { heading: "Choose a model provider", label: "Models" },
          { heading: "Run and call the agent", label: "API and CLI" },
          { heading: "Built-in capabilities", label: "Built-in tools" },
          { heading: "Connect MCP tools", label: "MCP tools" },
          { heading: "Memory and self-improvement", label: "Memory and learning" },
        ],
      },
      {
        label: "Operate",
        items: [
          { heading: "Durable execution and budgets", label: "Durability and budgets" },
          { heading: "Long-running tasks and context management", label: "Long-running context" },
          { heading: "Debug and inspect with Cockpit", label: "Cockpit" },
          { heading: "Telemetry and events", label: "Telemetry" },
          { heading: "Deploy Delta", label: "Deployment" },
          { heading: "Security model", label: "Security" },
        ],
      },
      {
        label: "Reference",
        items: [
          { heading: "Configuration reference", label: "Configuration" },
          { heading: "Production checklist", label: "Production checklist" },
          { heading: "Troubleshooting", label: "Troubleshooting" },
          { heading: "Current boundaries", label: "Current limits" },
        ],
      },
    ],
  },
];

function escapeHtml(value: string): string {
  return Bun.escapeHTML(value);
}

function normalizeForSite(markdown: string): string {
  return markdown.replace(/[ \t]*—[ \t]*/g, " - ");
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueId(base: string, ids: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (ids.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  ids.add(id);
  return id;
}

function renderMarkdown(document: SourceDocument): RenderedDocument {
  const markdown = normalizeForSite(readFileSync(resolve(root, document.source), "utf8"));
  const rendered = Bun.markdown.html(markdown, {
    autolinks: true,
    headings: { ids: true, autolink: false },
    noHtmlBlocks: true,
    noHtmlSpans: true,
    strikethrough: true,
    tables: true,
    tagFilter: true,
    tasklists: true,
  });

  const ids = new Set<string>();
  const headings: Heading[] = [];
  let html = rendered.replace(
    /<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g,
    (_match, sourceLevelText: string, rawId: string, children: string) => {
      const sourceLevel = Number(sourceLevelText);
      const displayLevel = Math.min(6, sourceLevel + 1);
      const base = `${document.slug}-${rawId || "section"}`;
      const id = uniqueId(base, ids);
      headings.push({ id, title: stripTags(children), sourceLevel });
      return `<h${displayLevel} id="${escapeHtml(id)}">${children}<a class="heading-link" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${displayLevel}>`;
    },
  );

  html = html.replace(
    /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_match, rawLanguage: string | undefined, code: string) => {
      const language = (rawLanguage ?? "text").replace(/[^a-zA-Z0-9_+.-]/g, "") || "text";
      const codeClass = rawLanguage ? ` class="language-${escapeHtml(language)}"` : "";
      return `<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(language)}</span><button class="code-copy" type="button" data-copy-code>Copy</button></div><pre><code${codeClass}>${code}</code></pre></div>`;
    },
  );

  html = html.replace(
    /<table>([\s\S]*?)<\/table>/g,
    (_match, contents: string) => `<div class="table-scroll"><table>${contents}</table></div>`,
  );

  return { ...document, headings, html };
}

function repoPath(source: string, href: string): string | null {
  // An absolute URL is never a repo-relative path, even when it ends in `.md`
  // (e.g. a link to docs/hosting.md on GitHub). Let the external-link branch handle it.
  if (/^https?:\/\//i.test(href)) return null;
  const pathPart = href.split("#", 1)[0];
  if (!pathPart?.toLowerCase().endsWith(".md")) return null;
  const absolute = resolve(root, dirname(source), decodeURIComponent(pathPart));
  const path = relative(root, absolute).replaceAll("\\", "/");
  if (path.startsWith("../")) return null;
  return path;
}

function rewriteLinks(document: RenderedDocument, rendered: RenderedDocument[]): string {
  const sourceMap = new Map(rendered.map((item) => [item.source, item]));
  const headingMap = new Map(
    rendered.flatMap((item) =>
      item.headings.map(
        (heading) =>
          [`${item.slug}:${heading.id.slice(item.slug.length + 1)}`, heading.id] as const,
      ),
    ),
  );

  return document.html.replace(
    /<a href="([^"]*)"([^>]*)>/g,
    (match, rawHref: string, rest: string) => {
      const href = rawHref.replace(/&amp;/g, "&");
      const lower = href.trim().toLowerCase();

      if (
        lower.startsWith("javascript:") ||
        lower.startsWith("data:") ||
        lower.startsWith("vbscript:")
      ) {
        return `<a href="#docs-top"${rest}>`;
      }

      if (href.startsWith("#")) {
        const fragment = decodeURIComponent(href.slice(1));
        const target =
          headingMap.get(`${document.slug}:${fragment}`) ?? `${document.slug}-${fragment}`;
        return `<a href="#${escapeHtml(target)}"${rest}>`;
      }

      const targetPath = repoPath(document.source, href);
      if (targetPath) {
        const targetDocument = sourceMap.get(targetPath);
        const fragment = href.includes("#")
          ? decodeURIComponent(href.slice(href.indexOf("#") + 1))
          : "";

        if (targetDocument) {
          const target = fragment
            ? (headingMap.get(`${targetDocument.slug}:${fragment}`) ??
              `${targetDocument.slug}-${fragment}`)
            : `doc-${targetDocument.slug}`;
          return `<a href="#${escapeHtml(target)}"${rest}>`;
        }

        return `<a href="${escapeHtml(githubSourceBase + targetPath)}" rel="noreferrer" target="_blank"${rest}>`;
      }

      if (/^https?:\/\//i.test(href)) {
        return `<a href="${escapeHtml(href)}" rel="noreferrer" target="_blank"${rest}>`;
      }

      return match;
    },
  );
}

function buildNavigation(rendered: RenderedDocument[]): string {
  return rendered
    .map((document, index) => {
      const navigableHeadings = document.headings.filter((heading) => heading.sourceLevel <= 2);
      const headingsByTitle = new Map<string, Heading>();

      for (const heading of navigableHeadings) {
        if (headingsByTitle.has(heading.title)) {
          throw new Error(`Duplicate navigation heading in ${document.source}: ${heading.title}`);
        }
        headingsByTitle.set(heading.title, heading);
      }

      const mappedIds: string[] = [];
      const sections = document.navigation
        .map((group) => {
          const items = group.items
            .map((item) => {
              const heading = headingsByTitle.get(item.heading);
              if (!heading) {
                throw new Error(
                  `Navigation heading not found in ${document.source}: ${item.heading}`,
                );
              }
              if (mappedIds.includes(heading.id)) {
                throw new Error(
                  `Navigation heading mapped more than once in ${document.source}: ${item.heading}`,
                );
              }
              mappedIds.push(heading.id);
              return `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(item.label)}</a></li>`;
            })
            .join("");

          return `<li class="nav-section-group">
            <span class="nav-group-label">${escapeHtml(group.label)}</span>
            <ol class="nav-group-items">${items}</ol>
          </li>`;
        })
        .join("");

      const expectedIds = navigableHeadings.map((heading) => heading.id);
      if (
        mappedIds.length !== expectedIds.length ||
        mappedIds.some((id, headingIndex) => id !== expectedIds[headingIndex])
      ) {
        const missing = navigableHeadings
          .filter((heading) => !mappedIds.includes(heading.id))
          .map((heading) => heading.title);
        const detail = missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
        throw new Error(
          `Navigation for ${document.source} must map every level-one and level-two heading in source order.${detail}`,
        );
      }

      return `<li class="nav-document${index === 0 ? " is-active" : ""}" data-nav-document="${escapeHtml(document.slug)}">
        <ol class="nav-sections">${sections}</ol>
      </li>`;
    })
    .join("\n");
}

function buildArticles(rendered: RenderedDocument[]): string {
  return rendered
    .map(
      (
        document,
      ) => `<article class="doc-article" id="doc-${escapeHtml(document.slug)}" data-document="${escapeHtml(document.slug)}">
        <div class="document-meta">
          <span>${escapeHtml(document.description)}</span>
          <code>${escapeHtml(document.sourceLabel ?? document.source)}</code>
        </div>
        ${document.html}
      </article>`,
    )
    .join("\n");
}

function validate(output: string, rendered: RenderedDocument[]): void {
  if (/—|&mdash;|&#(?:8212|x2014);/i.test(output)) {
    throw new Error("Generated documentation contains an em dash");
  }
  if (output.includes("{{DOC_NAV}}") || output.includes("{{DOC_ARTICLES}}")) {
    throw new Error("Generated documentation contains an unresolved template placeholder");
  }
  const hasExternalAsset =
    /<(?:script|img|source|video|audio)\b[^>]*\bsrc="https?:/i.test(output) ||
    /<link\b[^>]*\bhref="https?:/i.test(output) ||
    /url\(\s*["']?https?:/i.test(output);
  if (hasExternalAsset) {
    throw new Error("Generated documentation contains an external asset");
  }
  const ids = [...output.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set<string>();
  const duplicates = ids.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  if (duplicates.length > 0) {
    throw new Error(
      `Generated documentation has duplicate ids: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
  const idSet = new Set(ids);
  const missingTargets = [...output.matchAll(/href="#([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id) => !idSet.has(id));
  if (missingTargets.length > 0) {
    throw new Error(
      `Generated documentation has missing hash targets: ${[...new Set(missingTargets)].join(", ")}`,
    );
  }
  for (const document of rendered) {
    for (const heading of document.headings) {
      if (!heading.id.startsWith(`${document.slug}-`)) {
        throw new Error(`Heading id is not document-prefixed: ${heading.id}`);
      }
    }
  }
}

async function build(): Promise<string> {
  const template = await Bun.file(templatePath).text();
  const rendered = documents.map(renderMarkdown);
  const linked = rendered.map((document) => ({
    ...document,
    html: rewriteLinks(document, rendered),
  }));
  const base = `<!-- Generated by bun run build:website-docs. Do not edit this file directly. -->\n${template
    .replace("{{DOC_NAV}}", buildNavigation(linked))
    .replace("{{DOC_ARTICLES}}", buildArticles(linked))}`;

  validate(base, linked);

  // Inject SEO and rewrite the template's relative asset links to site-absolute
  // paths (both ported from sync-docs.mjs).
  if (!base.includes(`<title>${docsTitle}</title>`)) {
    throw new Error("The generated docs title changed; review the SEO injection before building.");
  }
  return base
    .replace(`<title>${docsTitle}</title>`, `<title>${docsTitle}</title>${seo}`)
    .replaceAll('href="../index.html"', 'href="/"')
    .replaceAll('href="../guide.md"', 'href="/guide.md"')
    .replaceAll('href="../agent.md"', 'href="/agent.md"')
    .replaceAll('href="../llms.txt"', 'href="/llms.txt"')
    .replaceAll('href="../llms-full.txt"', 'href="/llms-full.txt"');
}

// The sitemap is generated rather than hand-maintained: it silently rotted to two of the
// four live routes once already. Add new routes here and `bun run build:docs` keeps
// public/sitemap.xml honest; `--check` fails CI when it drifts.
const siteRoutes: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/docs/", changefreq: "weekly", priority: "0.9" },
  { path: "/how-it-works", changefreq: "weekly", priority: "0.8" },
  { path: "/connect", changefreq: "weekly", priority: "0.8" },
  { path: "/changelog", changefreq: "weekly", priority: "0.7" },
  { path: "/learn/", changefreq: "monthly", priority: "0.6" },
];

function buildSitemap(): string {
  const entries = siteRoutes
    .map(
      (route) =>
        `  <url>\n    <loc>https://deltaharness.dev${route.path}</loc>\n    <changefreq>${route.changefreq}</changefreq>\n    <priority>${route.priority}</priority>\n  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

const output = await build();
const sitemap = buildSitemap();
const sitemapPath = resolve(root, "public/sitemap.xml");
// llms-full.txt is the full-Markdown-for-LLMs mirror of the guide (the old
// pipeline emitted both from the same source), so keep it tracking guide.md.
const llmsFullPath = resolve(root, "public/llms-full.txt");
const guideText = readFileSync(resolve(root, "public/guide.md"), "utf8");
const checkOnly = Bun.argv.includes("--check");

if (checkOnly) {
  const [currentDocs, currentLlms, currentSitemap] = await Promise.all([
    Bun.file(outputPath).text(),
    Bun.file(llmsFullPath).text(),
    Bun.file(sitemapPath).text(),
  ]);
  if (currentDocs !== output || currentLlms !== guideText || currentSitemap !== sitemap) {
    throw new Error("Generated docs are stale. Run `bun run build:docs`.");
  }
  console.log("Generated docs are up to date");
} else {
  await Promise.all([
    Bun.write(outputPath, output),
    Bun.write(llmsFullPath, guideText),
    Bun.write(sitemapPath, sitemap),
  ]);
  console.log(
    `Generated ${relative(root, outputPath)}, llms-full.txt and sitemap.xml from public/guide.md`,
  );
}
