// The internal manual's model: every Markdown file under docs/ is a page and its folder is its section.
// Pure functions over { "docs/<path>.md": body } so they are unit-tested without Vite.

export const REPOSITORY = "https://github.com/arthurtouble/rfqmarkets";

export type Page = {
  /** The file under docs/ without `.md`, e.g. `architecture/overview` or `README`. */
  id: string;
  /** Browser path, e.g. `/architecture/overview`; a folder's README is the folder itself. */
  route: string;
  title: string;
  section: string;
  summary: string;
  body: string;
  headings: Heading[];
};
export type Heading = { level: number; text: string; slug: string };

const SECTION_ORDER = ["Start here", "Takeover", "Architecture", "Product", "Operations", "Release", "History"];

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const sectionOf = (id: string) => {
  const folder = id.includes("/") ? id.split("/")[0] : "";
  return folder ? folder[0].toUpperCase() + folder.slice(1) : "Start here";
};
const routeOf = (id: string) => `/${id.replace(/(^|\/)README$/, "")}`.replace(/(.)\/$/, "$1");

export function titleOf(id: string, body: string) {
  const title = body.match(/^#\s+(.+)$/m)?.[1].replace(/^RFQ Markets\s*[:—–-]\s+/, "").trim() ?? id.split("/").pop()!;
  return title[0].toUpperCase() + title.slice(1);
}

// A date, status or revision stamp ("Status: 2026-09-10.") is not a summary.
const STAMP = /^(?:[\w ]*(?:date|status|revision|updated)[\w ]*:\s*)?[\w ,]*\d{4}-\d{2}-\d{2}\.?$/i;
/** The first sentence of the first prose paragraph, at most 140 characters. */
export function summaryOf(body: string) {
  const paragraphs = body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !/^[#|`>-]|^\d+\.|^\*\s/.test(block));
  for (const paragraph of paragraphs) {
    const sentence = paragraph
      .replace(/\s*\n\s*/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .split(/(?<=\.)\s+/)
      .find((item) => !STAMP.test(item.trim()));
    if (sentence) return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
  }
  return "";
}

/** Level 2 and 3 headings outside code blocks, for the page outline. Anchors match Markdown.tsx's. */
export function headingsOf(body: string): Heading[] {
  const used = new Map<string, number>(),
    headings: Heading[] = [];
  for (const line of body.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const base = slugify(match[2]),
      seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    if (match[1].length === 2 || match[1].length === 3)
      headings.push({ level: match[1].length, text: match[2].replace(/[`*]/g, ""), slug: seen ? `${base}-${seen + 1}` : base });
  }
  return headings;
}

const rank = (page: Page) => {
  const index = SECTION_ORDER.indexOf(page.section);
  return index < 0 ? SECTION_ORDER.length : index;
};

/** Builds the manual from `{ "<prefix>docs/<path>.md": body }`, in reading order. */
export function buildManual(sources: Record<string, string>): Page[] {
  return Object.entries(sources)
    .map(([path, body]) => {
      const id = path.replace(/^.*?docs\//, "").replace(/\.md$/, "");
      return {
        id,
        route: routeOf(id),
        title: titleOf(id, body),
        section: sectionOf(id),
        summary: summaryOf(body),
        body,
        headings: headingsOf(body),
      };
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.id.endsWith("README")) - Number(a.id.endsWith("README")) ||
        // History is chronological by file name; numbered takeover files keep their order.
        (a.section === "History" || a.section === "Takeover" ? a.id.localeCompare(b.id) : a.title.localeCompare(b.title)),
    );
}

export const sectionsOf = (pages: Page[]) => [...new Set(pages.map((page) => page.section))];

export type Link =
  | { kind: "page"; route: string; hash?: string }
  | { kind: "anchor"; hash: string }
  | { kind: "external"; href: string };

/**
 * Where a link in page `fromId` goes. Another manual page (`../operations/cloudflare.md#deploy`, or a
 * folder with a README) stays in the manual; any other repository path (`../../deploy/operations`)
 * opens on GitHub; absolute URLs open as they are.
 */
export function resolveLink(fromId: string, href: string, pages: Page[]): Link {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "external", href };
  const [target, hash] = href.split("#");
  if (!target) return { kind: "anchor", hash: hash ?? "" };
  const parts = ["docs", ...fromId.split("/").slice(0, -1)];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const path = parts.join("/");
  if (path.startsWith("docs/") || path === "docs") {
    const id = path.replace(/^docs\/?/, "").replace(/\.md$/, "");
    const page = pages.find((item) => item.id === id || item.id === (id ? `${id}/README` : "README"));
    if (page) return { kind: "page", route: page.route, ...(hash ? { hash } : {}) };
  }
  const kind = /\.[a-z0-9]+$/i.test(path) ? "blob" : "tree";
  return { kind: "external", href: `${REPOSITORY}/${kind}/main/${path}${hash ? `#${hash}` : ""}` };
}

export const sourceUrl = (page: Page) => `${REPOSITORY}/blob/main/docs/${page.id}.md`;

export type SearchResult = { page: Page; excerpt: string };

const plain = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\|?[\s|:-]+\|?$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>|_]/g, "")
    .replace(/\s+/g, " ");

/** Pages matching every word of `query`; title matches first, each with an excerpt around the first hit. */
export function search(pages: Page[], query: string, limit = 20): SearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  if (!words.length) return [];
  return pages
    .map((page) => {
      const title = page.title.toLowerCase(),
        text = plain(page.body),
        lower = text.toLowerCase();
      if (!words.every((word) => title.includes(word) || lower.includes(word))) return undefined;
      const at = lower.indexOf(words[0]),
        start = Math.max(0, at - 60),
        excerpt = at < 0 ? page.summary : `${start ? "…" : ""}${text.slice(start, at + 100).trim()}…`;
      const score = words.filter((word) => title.includes(word)).length;
      return { page, excerpt, score };
    })
    .filter((result): result is SearchResult & { score: number } => Boolean(result))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ page, excerpt }) => ({ page, excerpt }));
}
