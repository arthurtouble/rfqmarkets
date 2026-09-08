import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const files = [
  "contracts/RFQAuthorization.sol",
  "contracts/RFQClearing.sol",
  "contracts/libraries/RFQRiskMath.sol",
  "contracts/interfaces/IPriceOracle.sol",
  "contracts/mocks/MockUSDC.sol",
  "contracts/mocks/MockPriceOracle.sol",
  "contracts/mocks/MockStreamsVerifier.sol",
  "contracts/oracle/ChainlinkDataStreamsV3Adapter.sol",
  "contracts/test/RFQInvariants.sol",
  "contracts/test/TestProxy.sol",
  "contracts/test/RFQClearingV2.sol",
];
const sources = Object.fromEntries(files.map((file) => [file, { content: fs.readFileSync(path.join(root, file), "utf8") }]));
const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
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
const clearingBytes = output.contracts["contracts/RFQClearing.sol"]?.RFQClearing?.evm?.deployedBytecode?.object?.length / 2;
if (!clearingBytes || clearingBytes > 24_000) {
  throw new Error(`RFQClearing deployed bytecode is ${clearingBytes} bytes; 24,000-byte project gate exceeded`);
}
console.log(`Compiled ${Object.keys(output.contracts).length} source files with solc ${solc.version()}`);
console.log(`RFQClearing deployed bytecode: ${clearingBytes} bytes (project gate: 24,000)`);
