import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const requiredHeaders = [
  "content-security-policy:",
  "strict-transport-security:",
  "x-content-type-options: nosniff",
  "x-frame-options: deny",
  "permissions-policy:",
  "referrer-policy:",
];

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

for (const surface of ["web", "docs"]) {
  const root = join("dist", surface);
  const headers = (await readFile(join(root, "_headers"), "utf8")).toLowerCase();
  for (const required of requiredHeaders) {
    if (!headers.includes(required)) throw new Error(`${surface} is missing ${required}`);
  }
}

for (const path of await filesBelow(join("dist", "web"))) {
  if (!/\.(?:html|js|css)$/.test(path)) continue;
  const content = await readFile(path, "utf8");
  if (/https?:\/\/(?:127\.0\.0\.1|localhost):(?:4100|4300|4500)/.test(content)) {
    throw new Error(`production bundle contains a loopback service URL: ${path}`);
  }
}

// The docs ship every page as static HTML for crawlers, plus a sitemap, robots.txt and llms.txt
// (apps/docs/vite.config.ts). Each sitemap entry must exist with its own canonical link and content.
const docs = join("dist", "docs");
const sitemap = await readFile(join(docs, "sitemap.xml"), "utf8");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]));
if (urls.length < 10) throw new Error(`docs sitemap lists only ${urls.length} pages`);
for (const url of urls) {
  const file = url.pathname === "/" ? "index.html" : `${url.pathname.slice(1)}.html`;
  const html = await readFile(join(docs, file), "utf8");
  if (!html.includes(`<link rel="canonical" href="${url.href}"/>`))
    throw new Error(`docs ${file} lacks its canonical link`);
  if (!/<div id="root"><header/.test(html) || !/<h1[ >]/.test(html))
    throw new Error(`docs ${file} was not pre-rendered`);
  if (!/<meta name="description" content="[^"]{40,}"/.test(html))
    throw new Error(`docs ${file} lacks a description`);
}
if (
  !(await readFile(join(docs, "robots.txt"), "utf8")).includes(
    `Sitemap: ${new URL("/sitemap.xml", urls[0]).href}`,
  )
) {
  throw new Error("docs robots.txt does not point at the sitemap");
}
const llms = await readFile(join(docs, "llms.txt"), "utf8");
for (const match of llms.matchAll(/\]\((https:[^)]+\.md)\)/g))
  await readFile(join(docs, new URL(match[1]).pathname));
if (!(await readFile(join(docs, "404.html"), "utf8")).includes('<meta name="robots" content="noindex"/>')) {
  throw new Error("docs 404.html is indexable");
}

console.log("Cloudflare static deployment invariants passed");
