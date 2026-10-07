// Prints the id of the named Workers KV namespace, creating it on first use. Used by the dev workflows.
import { execFileSync } from "node:child_process";
const title = process.argv[2];
if (!title) throw new Error("usage: cloudflare-kv-namespace.mjs TITLE");
const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => {
  const output = wrangler("kv", "namespace", "list");
  return JSON.parse(output.slice(output.search(/^\[/m))).find((item) => item.title === title)?.id;
};
let id = find();
if (!id) {
  wrangler("kv", "namespace", "create", title);
  id = find();
}
if (!id) throw new Error(`could not create KV namespace ${title}`);
console.log(id);
