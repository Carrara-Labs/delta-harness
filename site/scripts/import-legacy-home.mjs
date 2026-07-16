import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToJsx } from "html-to-jsx-transform";
import { parse, serializeOuter } from "parse5";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const sourcePath = resolve(appRoot, "../website/index.html");
const source = await readFile(sourcePath, "utf8");
const document = parse(source);

function elementChildren(node) {
  return (node.childNodes ?? []).filter((child) => child.tagName);
}

function findElement(node, predicate) {
  if (node.tagName && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

function attr(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? []).map(textContent).join("");
}

function componentName(node, index) {
  const id = attr(node, "id");
  const classes = attr(node, "class");
  const key = id || (classes.includes("proof") ? "proof" : `section-${index + 1}`);
  return `${key
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")}Section`;
}

function componentSource(name, html) {
  const jsx = htmlToJsx(html);
  return `/** Generated from the approved static landing page for parity. */\nexport function ${name}() {\n  return (\n${jsx
    .split("\\n")
    .map((line) => `    ${line}`)
    .join("\\n")}\n  );\n}\n`;
}

const head = findElement(document, (node) => node.tagName === "head");
const body = findElement(document, (node) => node.tagName === "body");
const style = elementChildren(head).find((node) => node.tagName === "style");
const header = elementChildren(body).find((node) => node.tagName === "header");
const main = elementChildren(body).find((node) => node.tagName === "main");
const footer = elementChildren(body).find((node) => node.tagName === "footer");
if (!style || !header || !main || !footer) {
  throw new Error("The legacy homepage no longer matches the expected document structure.");
}

const componentsDir = join(appRoot, "app/components/landing");
const stylesDir = join(appRoot, "app/styles");
const legacyDir = join(appRoot, "app/legacy");
await rm(componentsDir, { recursive: true, force: true });
await Promise.all([
  mkdir(componentsDir, { recursive: true }),
  mkdir(stylesDir, { recursive: true }),
  mkdir(legacyDir, { recursive: true }),
]);

await writeFile(join(stylesDir, "landing.css"), `${textContent(style).trim()}\n`);
await writeFile(
  join(componentsDir, "site-header.tsx"),
  componentSource("SiteHeader", serializeOuter(header)),
);
await writeFile(
  join(componentsDir, "site-footer.tsx"),
  componentSource("SiteFooter", serializeOuter(footer)),
);

const sectionExports = [];
for (const [index, section] of elementChildren(main).entries()) {
  if (section.tagName !== "section") continue;
  const name = componentName(section, index);
  const fileName = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/-Section$/, "")
    .toLowerCase();
  await writeFile(
    join(componentsDir, `${fileName}.tsx`),
    componentSource(name, serializeOuter(section)),
  );
  sectionExports.push({ name, fileName });
}

const barrel = [
  'export { SiteHeader } from "./site-header";',
  'export { SiteFooter } from "./site-footer";',
  ...sectionExports.map(({ name, fileName }) => `export { ${name} } from "./${fileName}";`),
  "",
].join("\n");
await writeFile(join(componentsDir, "index.ts"), barrel);

console.log(`Imported ${sectionExports.length} landing sections from ${sourcePath}`);
