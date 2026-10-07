// Summarises coverage/lcov.info from `npm run test:coverage` by area, and lists
// source files no unit test loads at all (lcov only knows files that ran).
// Writes Markdown to stdout and, in GitHub Actions, to the job summary.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "apps/web/src",
  "apps/admin/src",
  "apps/exit/src",
  "packages/shared/src",
  "services",
  "scripts",
  "deploy/cloudflare",
];
const SOURCE = /\.(ts|tsx|mjs)$/;
const SKIP = /(\.test\.|\.d\.ts$|\.d\.mts$|\/node_modules\/|\/dist\/)/;

const area = (file) => {
  const parts = file.split("/");
  if (parts[0] === "services") return parts.slice(0, 2).join("/");
  if (parts[0] === "apps" || parts[0] === "packages") return parts.slice(0, 2).join("/");
  if (parts[0] === "deploy") return "deploy/cloudflare";
  return parts[0];
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return SOURCE.test(path) && !SKIP.test(path) ? [path] : [];
  });

const totals = new Map();
const bucket = (name) => {
  if (!totals.has(name))
    totals.set(name, { lines: [0, 0], branches: [0, 0], functions: [0, 0], files: 0, untested: [] });
  return totals.get(name);
};

const covered = new Set();
let current;
for (const line of readFileSync("coverage/lcov.info", "utf8").split("\n")) {
  const [key, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
  if (key === "SF") {
    covered.add(value);
    current = bucket(area(value));
    current.files++;
  } else if (current && ["LH", "LF", "BRH", "BRF", "FNH", "FNF"].includes(key)) {
    const metric = key.startsWith("L") ? "lines" : key.startsWith("B") ? "branches" : "functions";
    current[metric][key.endsWith("H") ? 0 : 1] += Number(value);
  }
}
for (const file of ROOTS.flatMap(walk)) if (!covered.has(file)) bucket(area(file)).untested.push(file);

const pct = ([hit, found]) => (found ? `${((hit / found) * 100).toFixed(1)}%` : "–");
const rows = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
const sum = (metric) => rows.reduce((acc, [, t]) => [acc[0] + t[metric][0], acc[1] + t[metric][1]], [0, 0]);
const markdown = [
  "## Unit test coverage",
  "",
  "Lines, branches and functions are measured over files that tests load. *Never loaded* counts source files no unit test imports.",
  "",
  "| Area | Lines | Branches | Functions | Files tested | Never loaded |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    ([name, t]) =>
      `| ${name} | ${pct(t.lines)} | ${pct(t.branches)} | ${pct(t.functions)} | ${t.files} | ${t.untested.length} |`,
  ),
  `| **All** | **${pct(sum("lines"))}** | **${pct(sum("branches"))}** | **${pct(sum("functions"))}** | **${rows.reduce((n, [, t]) => n + t.files, 0)}** | **${rows.reduce((n, [, t]) => n + t.untested.length, 0)}** |`,
  "",
  "<details><summary>Files no unit test loads</summary>",
  "",
  ...rows.flatMap(([, t]) => t.untested.map((file) => `- \`${file}\``)),
  "",
  "</details>",
  "",
].join("\n");

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
