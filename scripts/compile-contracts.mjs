import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
// Every Solidity source under contracts/ is compiled; foundry.toml uses the same settings.
const listSources = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  if (entry.isDirectory()) return listSources(full);
  return entry.name.endsWith(".sol") ? [path.relative(root, full).split(path.sep).join("/")] : [];
});
const files = listSources(path.join(root, "contracts")).sort();
const sources = Object.fromEntries(files.map((file) => [file, { content: fs.readFileSync(path.join(root, file), "utf8") }]));
const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 1 },
    outputSelection: { "*": {
      "": ["ast"],
      "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "storageLayout"],
    } },
  },
};
function findImports(importPath) {
  const candidates = [path.join(root, importPath), path.join(root, "node_modules", importPath)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: `Import not found: ${importPath}` };
}
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const diagnostics = output.errors ?? [];
for (const item of diagnostics) process.stderr.write(`${item.formattedMessage}\n`);
if (diagnostics.some((item) => item.severity === "error")) process.exit(1);
const artifactDir = path.join(root, "artifacts");
fs.rmSync(artifactDir, { recursive: true, force: true }); // drop artifacts of deleted sources
fs.mkdirSync(artifactDir, { recursive: true });
const buildInfoDir = path.join(artifactDir, "build-info");
fs.mkdirSync(buildInfoDir, { recursive: true });
const buildSources = { ...sources };
for (const sourceName of Object.keys(output.sources ?? {})) {
  if (buildSources[sourceName] !== undefined) continue;
  const candidate = path.join(root, "node_modules", sourceName);
  if (fs.existsSync(candidate)) buildSources[sourceName] = { content: fs.readFileSync(candidate, "utf8") };
}
fs.writeFileSync(path.join(buildInfoDir, "rfq-build.json"), JSON.stringify({
  id: "rfq-solc-0.8.34",
  _format: "hh3-sol-build-info-1",
  solcVersion: "0.8.34",
  solcLongVersion: solc.version(),
  input: { ...input, sources: buildSources },
  output,
}));
for (const [source, contracts] of Object.entries(output.contracts)) {
  for (const [name, artifact] of Object.entries(contracts)) {
    fs.writeFileSync(path.join(artifactDir, `${name}.json`), JSON.stringify({
      source,
      contractName: name,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
      linkReferences: artifact.evm.bytecode.linkReferences,
    }, null, 2));
  }
}
// EIP-170 runtime limit for every deployable contract (libraries included).
const EIP170_LIMIT = 24_576;
const sizes = Object.values(output.contracts).flatMap((contracts) => Object.entries(contracts))
  .map(([name, artifact]) => [name, artifact.evm.deployedBytecode.object.length / 2])
  .filter(([, bytes]) => bytes > 0)
  .sort((a, b) => b[1] - a[1]);
const oversized = sizes.filter(([, bytes]) => bytes > EIP170_LIMIT);
if (oversized.length) {
  throw new Error(`EIP-170 runtime limit exceeded: ${oversized.map(([name, bytes]) => `${name} ${bytes}`).join(", ")}`);
}
console.log(`Compiled ${files.length} source files with solc ${solc.version()}`);
for (const [name, bytes] of sizes.filter(([name]) => name.startsWith("RFQ"))) {
  console.log(`${name.padEnd(24)} ${String(bytes).padStart(6)} bytes (headroom ${EIP170_LIMIT - bytes})`);
}
