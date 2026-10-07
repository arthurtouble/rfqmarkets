// Every page is a Markdown file under apps/docs/content/<section>/<slug>.md.
// The order of sections and pages below is the order of the sidebar.
const sources = import.meta.glob<string>("../content/**/*.md", { query: "?raw", import: "default", eager: true });

export const sections = [
  { id: "start", title: "Get started", pages: ["introduction", "quick-start", "using-the-app", "prices-explained"] },
  { id: "trading", title: "Trading", pages: ["placing-a-trade", "limit-orders", "stop-orders", "positions", "one-click-trading", "deposits-and-withdrawals"] },
  { id: "risk", title: "Margin and risk", pages: ["margin", "funding", "liquidation", "pricing-and-fees"] },
  { id: "markets", title: "Markets", pages: ["markets-and-limits", "price-oracle"] },
  { id: "protocol", title: "How it works", pages: ["architecture", "settlement", "approvers", "hedging", "safety-and-exits", "governance", "contracts"] },
  { id: "integrate", title: "Integrate", pages: ["api", "signing", "onchain-data", "oracle-feeds"] },
  { id: "reference", title: "Reference", pages: ["glossary", "faq"] },
  { id: "legal", title: "Legal", pages: ["terms-of-service", "privacy-policy", "risk-disclosure", "restricted-jurisdictions"] },
] as const;

export type Page = { route: string; path: string; section: string; title: string; summary: string; body: string; headings: { id: string; title: string }[] };

const slug = (text: string) => text.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export const pages: Page[] = sections.flatMap((section) =>
  section.pages.map((name) => {
    const path = `${section.id}/${name}`;
    const body = sources[`../content/${path}.md`];
    if (body === undefined) throw new Error(`Missing docs page ${path}.md`);
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? name;
    const lead = body.split(/\n\s*\n/).map((block) => block.trim()).find((block) => block && !/^[#|`>-]|^\d+\./.test(block)) ?? "";
    const summary = lead.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").split(/(?<=\.)\s+/)[0] ?? "";
    const headings = [...body.replace(/```[\s\S]*?```/g, "").matchAll(/^##\s+(.+)$/gm)].map((match) => ({ id: slug(match[1]), title: match[1].replace(/`/g, "") }));
    const route = path === "start/introduction" ? "/" : `/${path}`;
    return { route, path, section: section.title, title, summary, body, headings };
  }),
);

// Resolves a relative Markdown link written inside one page to a site route.
export function resolveLink(fromPath: string, href: string): string | undefined {
  if (/^[a-z]+:/i.test(href)) return undefined;
  if (href.startsWith("#")) return href;
  const [target, hash] = href.split("#");
  if (!target.endsWith(".md")) return undefined;
  const parts = fromPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const page = pages.find((item) => item.path === parts.join("/").replace(/\.md$/, ""));
  if (!page) return undefined;
  return hash ? `${page.route}#${hash}` : page.route;
}
