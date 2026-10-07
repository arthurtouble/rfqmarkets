// Fails when a Markdown file links to a repository path that does not exist.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const link = /\]\((?!https?:|mailto:|#)([^)\s#]+)(?:#[^)\s]*)?\)/g;
const broken = [];
for (const file of files) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(link)) {
    const target = normalize(join(dirname(file), decodeURIComponent(match[1])));
    if (!existsSync(target)) broken.push(`${file}: ${match[1]}`);
  }
}
if (broken.length) {
  console.error(`Broken documentation links:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log(`Checked links in ${files.length} Markdown files.`);
