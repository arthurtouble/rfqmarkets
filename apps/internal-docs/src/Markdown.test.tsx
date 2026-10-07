import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, type LinkResolver } from "./Markdown.js";

const link: LinkResolver = (href) =>
  href.startsWith("http") ? { href, external: true } : { href: `/resolved/${href}`, onClick: () => {} };
const render = (source: string, diagramHref?: string) =>
  renderToStaticMarkup(<Markdown source={source} link={link} diagramHref={diagramHref} />);

test("headings get unique anchors and section links", () => {
  const html = render("# Title\n\n## Setup\n\n## Setup");
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h2 id="setup">Setup<a class="anchor" href="#setup"/);
  assert.match(html, /<h2 id="setup-2">/);
});

test("inline code, bold, italics and both kinds of link", () => {
  const html = render("Run `npm ci`, **then** *wait* or _relax_; see [ops](ops.md) or [Base](https://base.org). a*b*c stays.");
  assert.match(html, /<code>npm ci<\/code>/);
  assert.match(html, /<strong>then<\/strong>/);
  assert.match(html, /<em>wait<\/em> or <em>relax<\/em>/);
  assert.match(html, /<a href="\/resolved\/ops.md">ops<\/a>/);
  assert.match(html, /<a href="https:\/\/base.org" target="_blank" rel="noreferrer">Base<\/a>/);
  assert.match(html, /a\*b\*c stays/);
});

test("lists with continuation lines, tables with a header row and escaped pipes", () => {
  const html = render("- one\n  continued\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| `x \\| y` | 2 |");
  assert.match(html, /<ul><li>one continued<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><code>x \| y<\/code><\/td>/);
});

test("code blocks keep their text; Mermaid blocks link to a rendered view", () => {
  const html = render("```ts\nconst a = 1 < 2;\n```\n\n```mermaid\nflowchart TB\n```", "https://github.com/x");
  assert.match(html, /<figcaption>ts<\/figcaption><pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /Diagram source \(Mermaid\)<a href="https:\/\/github.com\/x"/);
});

test("quotes, rules and paragraphs", () => {
  const html = render("> line one\n> line two\n\n---\n\nfirst\nsecond");
  assert.match(html, /<blockquote>line one line two<\/blockquote><hr\/><p>first second<\/p>/);
});
