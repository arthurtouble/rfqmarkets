import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const requiredHeaders = [
  "content-security-policy:",
  "strict-transport-security:",
  "x-content-type-options: nosniff",
  "x-frame-options: deny",
  "permissions-policy:",
  "referrer-policy:",
];

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

for (const surface of ["web", "docs"]) {
  const root = join("dist", surface);
  const headers = (await readFile(join(root, "_headers"), "utf8")).toLowerCase();
  for (const required of requiredHeaders) {
    if (!headers.includes(required)) throw new Error(`${surface} is missing ${required}`);
  }
}

for (const path of await filesBelow(join("dist", "web"))) {
  if (!/\.(?:html|js|css)$/.test(path)) continue;
  const content = await readFile(path, "utf8");
  if (/https?:\/\/(?:127\.0\.0\.1|localhost):(?:4100|4300|4500)/.test(content)) {
    throw new Error(`production bundle contains a loopback service URL: ${path}`);
  }
}

// Every app's CSP allows only font-src 'self', so a font Vite inlined as a data: URL never loads.
for (const app of ["web", "docs", "admin", "internal-docs", "exit"]) {
  for (const path of await filesBelow(join("dist", app))) {
    if (!path.endsWith(".css")) continue;
    if ((await readFile(path, "utf8")).includes("data:font/")) {
      throw new Error(`${path} inlines a font as a data: URL, which the CSP blocks`);
    }
  }
}

console.log("Cloudflare static deployment invariants passed");
