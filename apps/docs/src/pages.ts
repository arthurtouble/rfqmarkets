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

export type Page = {
  route: string; path: string; section: string; title: string; summary: string; description: string; body: string;
  headings: { id: string; title: string }[];
};

// Strips inline Markdown (links, emphasis, code ticks) to the words a reader sees.
export const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

// Search-result descriptions for pages whose opening paragraph does not summarise the page.
const DESCRIPTIONS: Record<string, string> = {
  "start/introduction": "RFQ Markets is a perpetual futures venue on Base: trade BTC and ETH against firm request-for-quote prices with USDC collateral that stays in a smart contract.",
  "reference/faq": "Answers to common questions about RFQ Markets: who takes the other side of your trade, custody of your collateral, fill prices, limits, leverage, gas and wallets.",
  "reference/glossary": "Definitions of the terms used across RFQ Markets: account value, margin, funding, liquidation, oracle prices, approvers, settlement and more.",
};

// A search-result description: whole sentences of the lead paragraph, about 90 to 160 characters.
function describe(path: string, lead: string) {
  if (DESCRIPTIONS[path]) return DESCRIPTIONS[path];
  const sentences = plain(lead).split(/(?<=[.?!])\s+/);
  let text = sentences[0] ?? "";
  for (const sentence of sentences.slice(1)) {
    const longer = `${text} ${sentence}`;
    if (longer.length <= 160) { text = longer; continue; }
    if (text.length < 90) text = `${longer.slice(0, 157).replace(/[\s,;:]+\S*$/, "")}…`;
    break;
  }
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, "")}…` : text;
}

const slug = (text: string) => text.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export const pages: Page[] = sections.flatMap((section) =>
  section.pages.map((name) => {
    const path = `${section.id}/${name}`;
    const body = sources[`../content/${path}.md`];
    if (body === undefined) throw new Error(`Missing docs page ${path}.md`);
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? name;
    const lead = body.split(/\n\s*\n/).map((block) => block.trim()).find((block) => block && !/^[#|`>-]|^\d+\./.test(block)) ?? "";
    const summary = plain(lead).split(/(?<=\.)\s+/)[0] ?? "";
    const headings = [...body.replace(/```[\s\S]*?```/g, "").matchAll(/^##\s+(.+)$/gm)].map((match) => ({ id: slug(match[1]), title: match[1].replace(/`/g, "") }));
    const route = path === "start/introduction" ? "/" : `/${path}`;
    return { route, path, section: section.title, title, summary, description: describe(path, lead), body, headings };
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
