import React from "react";

// Turns a Markdown link target into an in-site route, or undefined for an external link.
export type Resolver = (href: string) => string | undefined;

export const slugify = (text: string) =>
  text.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

type Context = { resolve: Resolver; go: (route: string) => void };

const token = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

function inline(text: string, context: Context): React.ReactNode[] {
  return text.split(token).filter(Boolean).map((part, index) => {
    if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={index}>{inline(part.slice(2, -2), context)}</strong>;
    if (/^\*[^*]/.test(part) && part.endsWith("*")) return <em key={index}>{inline(part.slice(1, -1), context)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (!link) return part;
    const route = context.resolve(link[2]);
    if (route === undefined) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{inline(link[1], context)}</a>;
    return (
      <a key={index} href={route} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); context.go(route); }}>
        {inline(link[1], context)}
      </a>
    );
  });
}

const blockStart = /^(#{1,4})\s|^```|^[-*] |^\d+\. |^\||^> |^---+$/;

function list(lines: string[], start: number, ordered: boolean, context: Context): [React.ReactNode, number] {
  const marker = ordered ? /^\d+\. / : /^[-*] /;
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (marker.test(line)) { items.push(line.replace(marker, "")); index++; continue; }
    // An indented line continues the previous item.
    if (/^\s{2,}\S/.test(line) && items.length) { items[items.length - 1] += ` ${line.trim()}`; index++; continue; }
    break;
  }
  const children = items.map((item, key) => <li key={key}>{inline(item, context)}</li>);
  return [ordered ? <ol key={start}>{children}</ol> : <ul key={start}>{children}</ul>, index];
}

export function Markdown({ source, resolve, go }: { source: string; resolve: Resolver; go: (route: string) => void }) {
  const context = { resolve, go };
  const lines = source.split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) body.push(lines[index++]);
      index++;
      blocks.push(<pre key={blocks.length} data-language={language || undefined}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length, title = heading[2], id = slugify(title);
      blocks.push(React.createElement(`h${level}`, { key: blocks.length, id }, level > 1 ? <a className="anchor" href={`#${id}`} aria-hidden="true">#</a> : null, inline(title, context)));
      index++;
      continue;
    }
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const [node, next] = list(lines, index, /^\d+\. /.test(line), context);
      blocks.push(node);
      index = next;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].startsWith("|")) rows.push(lines[index++]);
      const cells = rows.filter((row) => !/^\|?[\s|:-]+\|?$/.test(row)).map((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()));
      const [head, ...body] = cells;
      blocks.push(
        <div className="table-scroll" key={blocks.length}>
          <table>
            <thead><tr>{head.map((cell, key) => <th key={key}>{inline(cell, context)}</th>)}</tr></thead>
            <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, key) => <td key={key}>{inline(cell, context)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      // A quote block is a callout. "> **Warning.**" or "> **Note.**" picks its tone.
      const body: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) body.push(lines[index++].replace(/^>\s?/, ""));
      const text = body.join("\n");
      const tone = text.match(/^\*\*(Warning|Note|Tip)\b/)?.[1].toLowerCase() ?? "note";
      blocks.push(<aside className={`callout ${tone}`} key={blocks.length}><Markdown source={text} resolve={resolve} go={go} /></aside>);
      continue;
    }
    if (/^---+$/.test(line)) { blocks.push(<hr key={blocks.length} />); index++; continue; }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !blockStart.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "), context)}</p>);
  }
  return <>{blocks}</>;
}
