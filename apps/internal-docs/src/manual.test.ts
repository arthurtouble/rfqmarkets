import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  buildManual,
  headingsOf,
  resolveLink,
  search,
  sectionsOf,
  slugify,
  summaryOf,
  titleOf,
} from "./manual.js";

// The real docs/ tree, read the way Vite's glob bundles it.
const root = new URL("../../../", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".md")
        ? [join(dir, entry.name)]
        : [],
  );
const pages = buildManual(
  Object.fromEntries(
    walk(join(root, "docs")).map((file) => [`../../../${relative(root, file)}`, readFileSync(file, "utf8")]),
  ),
);

test("every docs file is a page, the start page first, with unique routes", () => {
  assert.equal(pages[0].id, "README");
  assert.equal(pages[0].route, "/");
  assert.equal(new Set(pages.map((page) => page.route)).size, pages.length);
  assert.deepEqual(sectionsOf(pages).slice(0, 3), ["Start here", "Takeover", "Architecture"]);
  assert.equal(sectionsOf(pages).at(-1), "History");
  const takeover = pages.filter((page) => page.section === "Takeover");
  assert.equal(takeover[0].route, "/takeover", "a folder README is the folder's page and comes first");
  for (const page of pages) {
    // A bad merge once left a doc empty; every page starts with its own "# " title.
    assert.match(page.body, /^# \S/m, `docs/${page.id}.md has a level-1 title`);
    assert.ok(page.title, `${page.id} has a title`);
  }
});

test("titles and summaries", () => {
  assert.equal(titleOf("x", "# RFQ Markets: backend audit\n"), "Backend audit");
  assert.equal(titleOf("x", "# RFQ Markets — consolidated status\n"), "Consolidated status");
  assert.equal(titleOf("ops/runbook", "no heading"), "Runbook");
  assert.equal(
    summaryOf("# T\n\nStatus: 2026-09-10.\n\nThe [indexer](x.md) reads the chain. More."),
    "The indexer reads the chain.",
  );
  assert.equal(summaryOf("# T\n\n```\ncode. here.\n```\n\nReal text."), "Real text.");
  assert.ok(summaryOf(`# T\n\n${"word ".repeat(60)}.`).length <= 140);
});

test("headings match the renderer's anchors, duplicates included", () => {
  assert.deepEqual(
    headingsOf("# Top\n## Setup\n```\n## not a heading\n```\n### `npm ci` step\n## Setup\n#### deep"),
    [
      { level: 2, text: "Setup", slug: "setup" },
      { level: 3, text: "npm ci step", slug: "npm-ci-step" },
      { level: 2, text: "Setup", slug: "setup-2" },
    ],
  );
  assert.equal(slugify("Keys, [privacy](x.md) & recovery"), "keys-privacy-recovery");
});

test("links: manual pages stay in the manual, other repository paths open on GitHub", () => {
  assert.deepEqual(resolveLink("architecture/hedging", "../operations/cloudflare.md#deploy", pages), {
    kind: "page",
    route: "/operations/cloudflare",
    hash: "deploy",
  });
  assert.deepEqual(resolveLink("README", "takeover/", pages), { kind: "page", route: "/takeover" });
  assert.deepEqual(resolveLink("README", "./architecture/overview.md", pages), {
    kind: "page",
    route: "/architecture/overview",
  });
  assert.deepEqual(resolveLink("README", "history/", pages), {
    kind: "external",
    href: "https://github.com/arthurtouble/rfqmarkets/tree/main/docs/history",
  });
  assert.deepEqual(
    resolveLink("operations/cloudflare", "../../deploy/cloudflare/DEV-ENVIRONMENT.md", pages),
    {
      kind: "external",
      href: "https://github.com/arthurtouble/rfqmarkets/blob/main/deploy/cloudflare/DEV-ENVIRONMENT.md",
    },
  );
  assert.deepEqual(resolveLink("README", "#history", pages), { kind: "anchor", hash: "history" });
  assert.deepEqual(resolveLink("README", "https://basescan.org", pages), {
    kind: "external",
    href: "https://basescan.org",
  });
});

test("no link in the docs leaves the manual for a docs page that does not exist", () => {
  for (const page of pages)
    for (const [, href] of page.body.replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = resolveLink(page.id, href, pages);
      if (link.kind === "external" && link.href.includes("/main/docs/") && link.href.endsWith(".md"))
        assert.fail(`${page.id} links to missing page ${href}`);
    }
});

test("search matches every word and ranks title matches first", () => {
  const results = search(pages, "hedging");
  assert.ok(results.length > 1);
  assert.equal(results[0].page.id, "architecture/hedging");
  assert.ok(
    results.every((result) => !result.excerpt.includes("---")),
    "table rules are not excerpted",
  );
  assert.deepEqual(search(pages, " "), []);
  assert.deepEqual(search(pages, "zzzz-not-a-word"), []);
});
