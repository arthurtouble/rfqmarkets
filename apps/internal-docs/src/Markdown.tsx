// A small Markdown renderer for the repository's docs: headings (with anchors), paragraphs, lists,
// tables, block quotes, fenced code, rules, and inline code, bold, italics and links. The docs use
// nothing else, and rendering them ourselves keeps the bundle small and the CSP strict.
import React from "react";
import { slugify } from "./manual.js";

/** How a link renders: in-manual links get a click handler, external ones open in a new tab. */
export type LinkProps = { href: string; onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void; external?: boolean };
export type LinkResolver = (href: string) => LinkProps;

const TOKEN = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/g;

function inline(text: string, link: LinkResolver): React.ReactNode[] {
  return text
    .split(TOKEN)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
      if (part.startsWith("**")) return <strong key={index}>{inline(part.slice(2, -2), link)}</strong>;
      if (/^([*_]).+\1$/.test(part) && part.length > 2) return <em key={index}>{inline(part.slice(1, -1), link)}</em>;
      const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!match) return part;
      const { href, onClick, external } = link(match[2]);
      return (
        <a key={index} href={href} onClick={onClick} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
          {inline(match[1], link)}
        </a>
      );
    });
}

const BLOCK_START = /^(#{1,6})\s|^```|^\s*[-*] |^\s*\d+\. |^\||^> ?|^---+$/;

/** `diagramHref` is where a reader can see Mermaid blocks rendered (GitHub renders them). */
export function Markdown({ source, link, diagramHref }: { source: string; link: LinkResolver; diagramHref?: string }) {
  const lines = source.split("\n"),
    blocks: React.ReactNode[] = [],
    used = new Map<string, number>();
  // Repeated headings get -2, -3 suffixes, like GitHub, so every anchor is unique.
  const anchor = (text: string) => {
    const slug = slugify(text),
      seen = used.get(slug) ?? 0;
    used.set(slug, seen + 1);
    return seen ? `${slug}-${seen + 1}` : slug;
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index],
      key = blocks.length;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim(),
        body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) body.push(lines[index++]);
      index++;
      blocks.push(
        <figure className="code" key={key}>
          {language === "mermaid" ? (
            <figcaption>
              Diagram source (Mermaid)
              {diagramHref && (
                <a href={diagramHref} target="_blank" rel="noreferrer">
                  View rendered
                </a>
              )}
            </figcaption>
          ) : (
            language && <figcaption>{language}</figcaption>
          )}
          <pre>
            <code>{body.join("\n")}</code>
          </pre>
        </figure>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4),
        id = anchor(heading[2]);
      blocks.push(
        React.createElement(
          `h${level}`,
          { key, id },
          inline(heading[2], link),
          level > 1 ? (
            <a className="anchor" href={`#${id}`} aria-label="Link to this section">
              #
            </a>
          ) : null,
        ),
      );
      index++;
      continue;
    }
    const listItem = /^\s*(?:[-*]|\d+\.) /;
    if (listItem.test(line)) {
      const ordered = /^\s*\d+\. /.test(line),
        items: string[] = [];
      while (index < lines.length && (listItem.test(lines[index]) || (/^\s{2,}\S/.test(lines[index]) && items.length))) {
        // An indented continuation line belongs to the item above it.
        if (listItem.test(lines[index])) items.push(lines[index].replace(listItem, ""));
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index++;
      }
      const children = items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, link)}</li>);
      blocks.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].startsWith("|")) rows.push(lines[index++]);
      const cells = rows
        .filter((row) => !/^\|?[\s|:-]+\|?$/.test(row))
        .map((row) =>
          row
            .replace(/\\\|/g, "\u0000")
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim().replace(/\u0000/g, "|")),
        );
      const [head, ...body] = cells;
      if (head)
        blocks.push(
          <div className="table-scroll" key={key}>
            <table>
              <thead>
                <tr>
                  {head.map((cell, cellIndex) => (
                    <th key={cellIndex}>{inline(cell, link)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{inline(cell, link)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      continue;
    }
    if (/^> ?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^> ?/.test(lines[index])) quote.push(lines[index++].replace(/^> ?/, ""));
      blocks.push(<blockquote key={key}>{inline(quote.join(" "), link)}</blockquote>);
      continue;
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={key} />);
      index++;
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={key}>{inline(paragraph.join(" "), link)}</p>);
  }
  return <>{blocks}</>;
}
