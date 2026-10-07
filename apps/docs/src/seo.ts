// What search engines and AI tools read: per-page head tags, structured data, the sitemap,
// robots.txt and llms.txt. The build writes these files (vite.config.ts); the app keeps the
// title, description and canonical link in step as readers move between pages.
import { pages, plain, resolveLink, sections, type Page } from "./pages.js";

export const SITE_NAME = "RFQ Markets Docs";
export const APP_URL = "https://dev.rfq-markets.workers.dev";
const TAGLINE = "Perpetual futures on Base";

export const pageTitle = (page: Page | undefined) =>
  !page ? `Page not found · ${SITE_NAME}` : page.route === "/" ? `${SITE_NAME} · ${TAGLINE}` : `${page.title} · ${SITE_NAME}`;

// Each page's Markdown source is published next to it, at the same path as in apps/docs/content,
// so the relative links inside it keep working.
export const markdownPath = (page: Page) => `/${page.path}.md`;

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function structuredData(page: Page, site: string) {
  const url = `${site}${page.route}`;
  const website = { "@type": "WebSite", "@id": `${site}/#website`, name: SITE_NAME, url: `${site}/`, inLanguage: "en" };
  const article = {
    "@type": "TechArticle",
    headline: page.title,
    description: page.description,
    url,
    inLanguage: "en",
    articleSection: page.section,
    isPartOf: { "@id": `${site}/#website` },
    publisher: { "@type": "Organization", name: "RFQ Markets", url: APP_URL },
  };
  const graph: object[] = [website, article];
  if (page.route !== "/") {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${site}/` },
        { "@type": "ListItem", position: 2, name: page.section },
        { "@type": "ListItem", position: 3, name: page.title, item: url },
      ],
    });
  }
  if (page.path === "reference/faq") {
    // Each "## Question?" heading and the paragraphs under it.
    const entries = [...page.body.matchAll(/^##\s+(.+)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)];
    graph.push({
      "@type": "FAQPage",
      mainEntity: entries.map(([, question, answer]) => ({
        "@type": "Question",
        name: plain(question),
        acceptedAnswer: { "@type": "Answer", text: plain(answer) },
      })),
    });
  }
  // JSON is not run as script, so the docs CSP allows it; escaping "<" keeps "</script>" out of it.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

// The <head> tags for one page, inserted by the build in place of the template's title and description.
export function headTags(page: Page | undefined, site: string) {
  if (!page) return [`<title>${escape(pageTitle(page))}</title>`, `<meta name="robots" content="noindex"/>`].join("");
  const url = `${site}${page.route}`;
  const title = escape(pageTitle(page));
  const description = escape(page.description);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}"/>`,
    `<link rel="canonical" href="${url}"/>`,
    `<link rel="alternate" type="text/markdown" href="${site}${markdownPath(page)}" title="Markdown"/>`,
    `<meta property="og:type" content="${page.route === "/" ? "website" : "article"}"/>`,
    `<meta property="og:site_name" content="${SITE_NAME}"/>`,
    `<meta property="og:title" content="${title}"/>`,
    `<meta property="og:description" content="${description}"/>`,
    `<meta property="og:url" content="${url}"/>`,
    `<meta property="og:locale" content="en_US"/>`,
    `<meta name="twitter:card" content="summary"/>`,
    `<meta name="twitter:title" content="${title}"/>`,
    `<meta name="twitter:description" content="${description}"/>`,
    `<script type="application/ld+json">${structuredData(page, site)}</script>`,
  ].join("");
}

export function sitemap(site: string) {
  const urls = pages.map((page) => `  <url><loc>${site}${page.route}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const robots = (site: string) =>
  [
    "# Everything here is public documentation. Search engines and AI crawlers are welcome.",
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${site}/sitemap.xml`,
    "",
    "# A plain-text index for language models (https://llmstxt.org):",
    `# ${site}/llms.txt`,
    `# ${site}/llms-full.txt`,
    "",
  ].join("\n");

// https://llmstxt.org: a title, a one-paragraph summary, then every page as a link to its Markdown.
export function llmsTxt(site: string) {
  const intro = pages[0];
  const lines = [
    "# RFQ Markets",
    "",
    `> ${plain(intro.body.split(/\n\s*\n/).find((block) => block.trim() && !block.startsWith("#")) ?? intro.description)}`,
    "",
    "This is the user and integrator documentation for RFQ Markets. Each link below is the Markdown source of one page;",
    `the same page as HTML is at the same address without ".md". Every page in one file: ${site}/llms-full.txt`,
  ];
  for (const section of sections) {
    lines.push("", `## ${section.title}`, "");
    for (const page of pages.filter((item) => item.path.startsWith(`${section.id}/`))) {
      lines.push(`- [${page.title}](${site}${markdownPath(page)}): ${page.description}`);
    }
  }
  lines.push("", "## Optional", "", `- [Trading app](${APP_URL}): the RFQ Markets web app on Base mainnet`, `- [Sitemap](${site}/sitemap.xml)`, "");
  return lines.join("\n");
}

// Every page in sidebar order, with links rewritten to absolute addresses so they still work out of context.
export function llmsFullTxt(site: string) {
  const parts = pages.map((page) => {
    const body = page.body.replace(/\]\(([^)\s]+)\)/g, (match, href: string) => {
      const route = resolveLink(page.path, href);
      if (route === undefined) return match;
      return `](${site}${route.startsWith("#") ? page.route : ""}${route})`;
    });
    return `<!-- ${site}${page.route} -->\n\n${body.trim()}\n`;
  });
  return `# RFQ Markets documentation\n\nSource: ${site}/ · Index: ${site}/llms.txt\n\n---\n\n${parts.join("\n---\n\n")}`;
}
