import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "parse5";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const source = await readFile(resolve(appRoot, "../website/index.html"), "utf8");
const scriptMatch = source.match(
  /<script>\s*const root = document\.documentElement;([\s\S]*?)<\/script>\s*<\/body>/,
);

if (!scriptMatch) throw new Error("Could not locate the landing-page interaction script.");

const original = `const root = document.documentElement;${scriptMatch[1]}`;
const behaviorStart = original.indexOf("function demoTool(");
const behaviorEnd = original.indexOf('document.getElementById("year")');

if (behaviorStart < 0 || behaviorEnd < 0) {
  throw new Error("The landing-page interaction boundaries have changed.");
}

const behavior = original.slice(behaviorStart, behaviorEnd).trimEnd();
const indented = behavior
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n");

const output = `// @ts-nocheck -- migrated fixture data is intentionally kept byte-for-byte for parity.\n\nexport function initializeLandingInteractions() {\n  const cockpit = document.querySelector(".product-cockpit");\n  if (!(cockpit instanceof HTMLElement) || cockpit.dataset.initialized === "true") return;\n  cockpit.dataset.initialized = "true";\n\n${indented}\n}\n`;

await writeFile(resolve(appRoot, "app/legacy/landing-interactions.ts"), output);

const document = parse(source);
function findElement(node, predicate) {
  if (node.tagName && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

const product = findElement(
  document,
  (node) =>
    node.tagName === "section" &&
    node.attrs?.some((attribute) => attribute.name === "id" && attribute.value === "product"),
);
if (!product) throw new Error("Could not locate the Cockpit section.");
await writeFile(resolve(appRoot, "app/legacy/cockpit.html"), `${serialize(product).trim()}\n`);

console.log("Imported Cockpit markup, fixtures and interactions.");
