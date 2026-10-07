#!/usr/bin/env node
// Builds packages/design-system/tokens.css from tokens.json.
// `--check` fails when the committed tokens.css is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../packages/design-system");
const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
const [first, ...others] = tokens.color.themes.map((theme) => theme.id);

const value = (raw, theme) => {
  const picked = typeof raw === "string" ? raw : (raw[theme] ?? raw[first]);
  return picked.startsWith("{") ? `var(--${picked.slice(1, -1)})` : picked;
};
const themed = [...tokens.color.tokens, ...(tokens.shadow?.tokens ?? [])];
const block = (selector, theme, indent = "") =>
  `${indent}${selector} {\n${themed.map((token) => `${indent}  --${token.name}: ${value(token.value, theme)};`).join("\n")}\n${indent}  color-scheme: ${theme === "light" ? "light" : "dark"};\n${indent}}`;

const out = [
  `/* ${tokens.name} — generated from tokens.json by scripts/build-design-tokens.mjs. Do not edit. */`,
  block(`:root, [data-theme="${first}"]`, first),
];
for (const theme of others) {
  // Follow the system setting unless the page pins a theme with data-theme.
  out.push(`@media (prefers-color-scheme: ${theme}) {\n${block(`:root:not([data-theme])`, theme, "  ")}\n}`);
  out.push(block(`[data-theme="${theme}"]`, theme));
}
const plain = ["spacing", "radius", "size"].flatMap((family) => tokens[family]?.tokens ?? []);
out.push(
  `:root {\n${[
    ...plain.map((token) => `  --${token.name}: ${token.value};`),
    ...Object.entries(tokens.type.families).map(([key, stack]) => `  --font-${key}: ${stack};`),
  ].join("\n")}\n}`,
);
for (const group of tokens.type.groups) {
  for (const style of group.styles) {
    const rules = [
      `font-family: var(--font-${style.family ?? group.family})`,
      `font-size: ${style.fontSize}`,
      `line-height: ${style.lineHeight}`,
      `font-weight: ${style.fontWeight}`,
      ...(style.letterSpacing ? [`letter-spacing: ${style.letterSpacing}`] : []),
      ...(group.name === "Numbers" ? ["font-variant-numeric: tabular-nums"] : []),
    ];
    out.push(`.${style.name} { ${rules.join("; ")}; }`);
  }
}
const css = `${out.join("\n")}\n`;
const target = join(dir, "tokens.css");

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== css) {
    console.error("packages/design-system/tokens.css is out of date. Run npm run build:tokens.");
    process.exit(1);
  }
  console.log("tokens.css is up to date");
} else {
  writeFileSync(target, css);
  console.log(`wrote ${target}`);
}
