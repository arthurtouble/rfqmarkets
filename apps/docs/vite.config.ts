import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, defineConfig, type Plugin } from "vite";

// The public address the docs are served from: canonical links, the sitemap and llms.txt use it.
const SITE_URL = (process.env.DOCS_SITE_URL ?? "https://docs.rfq-markets.workers.dev").replace(/\/+$/, "");

// After the client build, writes every page as static HTML (src/prerender.tsx) plus the files
// crawlers and AI tools look for: sitemap.xml, robots.txt, llms.txt, llms-full.txt, each page's
// Markdown, 404.html and _redirects for renamed pages.
function prerender(): Plugin {
  let root = "", outDir = "";
  return {
    name: "rfq-docs-prerender",
    apply: "build",
    configResolved(config) { root = config.root; outDir = resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const server = await createServer({
        root, configFile: false, logLevel: "error", appType: "custom", plugins: [react()],
        server: { middlewareMode: true, hmr: false, ws: false },
        // Its own cache and no dependency pre-bundling: the shared node_modules/.vite belongs to any
        // dev server running alongside (the e2e suite builds the docs while the web app is served),
        // and rewriting it makes that server answer "504 Outdated Optimize Dep".
        cacheDir: resolve(root, "../../node_modules/.vite-docs-prerender"),
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        const site = await server.ssrLoadModule("/src/prerender.tsx");
        const template = await readFile(join(outDir, "index.html"), "utf8");
        const write = async (path: string, content: string) => {
          await mkdir(dirname(join(outDir, path)), { recursive: true });
          await writeFile(join(outDir, path), content);
        };
        const page = (route: string, entry: unknown) => {
          const html = template
            .replace(/<meta name="description"[^>]*>/, "")
            .replace(/<title>[\s\S]*?<\/title>/, site.headTags(entry, SITE_URL))
            .replace('<div id="root"></div>', `<div id="root">${site.render(route)}</div>`);
          if (!html.includes('<div id="root"><')) throw new Error(`docs prerender: template changed, ${route} not rendered`);
          return html;
        };
        for (const entry of site.pages) {
          await write(entry.route === "/" ? "index.html" : `${entry.route.slice(1)}.html`, page(entry.route, entry));
          await write(site.markdownPath(entry), entry.body);
        }
        await write("404.html", page(site.NOT_FOUND, undefined));
        await write("_redirects", Object.entries(site.MOVED as Record<string, string>).map(([from, to]) => `${from} ${to} 301\n`).join(""));
        await write("sitemap.xml", site.sitemap(SITE_URL));
        await write("robots.txt", site.robots(SITE_URL));
        await write("llms.txt", site.llmsTxt(SITE_URL));
        await write("llms-full.txt", site.llmsFullTxt(SITE_URL));
      } finally {
        await server.close();
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), prerender()],
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
});
