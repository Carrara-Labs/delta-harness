import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const legacyRoot = resolve(appRoot, "../website");
const [docsSource, guide, agent, llms] = await Promise.all([
  readFile(resolve(legacyRoot, "docs/index.html"), "utf8"),
  readFile(resolve(legacyRoot, "guide.md"), "utf8"),
  readFile(resolve(legacyRoot, "agent.md"), "utf8"),
  readFile(resolve(legacyRoot, "llms.txt"), "utf8"),
]);

const docsTitle = "Delta Docs – Build and operate durable agents";
const docsDescription =
  "From first local run to secure production: configure models, MCP tools, memory, subagents, observability and durable execution.";
const socialImageUrl = "https://deltaharness.dev/delta-og-image.png";
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";

const seo = `
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="https://deltaharness.dev/docs/" />
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

if (!docsSource.includes(`<title>${docsTitle}</title>`)) {
  throw new Error("The generated docs title changed; review the SEO injection before syncing.");
}

const docs = docsSource
  .replace(`<title>${docsTitle}</title>`, `<title>${docsTitle}</title>${seo}`)
  .replaceAll('href="../index.html"', 'href="/"')
  .replaceAll('href="../guide.md"', 'href="/guide.md"')
  .replaceAll('href="../agent.md"', 'href="/agent.md"')
  .replaceAll('href="../llms.txt"', 'href="/llms.txt"')
  .replaceAll('href="../llms-full.txt"', 'href="/llms-full.txt"');

await mkdir(resolve(appRoot, "public/docs"), { recursive: true });
const docsOutput = resolve(appRoot, "public/docs/index.html");
const guideOutput = resolve(appRoot, "public/guide.md");
const agentOutput = resolve(appRoot, "public/agent.md");
const agentsOutput = resolve(appRoot, "public/AGENTS.md");
const docsAgentsOutput = resolve(appRoot, "public/docs/agents.md");
const llmsOutput = resolve(appRoot, "public/llms.txt");
const llmsFullOutput = resolve(appRoot, "public/llms-full.txt");

const outputs = [
  [docsOutput, docs],
  [guideOutput, guide],
  [agentOutput, agent],
  [agentsOutput, agent],
  [docsAgentsOutput, agent],
  [llmsOutput, llms],
  [llmsFullOutput, guide],
];

if (process.argv.includes("--check")) {
  const current = await Promise.all(outputs.map(([path]) => readFile(path, "utf8")));
  if (current.some((contents, index) => contents !== outputs[index][1])) {
    throw new Error("The copied documentation is stale. Run `bun run sync:docs`.");
  }
  console.log("The copied documentation is current.");
  process.exit(0);
}

await Promise.all(outputs.map(([path, contents]) => writeFile(path, contents)));

console.log("Synced the documentation and agent-readable context.");
