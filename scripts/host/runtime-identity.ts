import { Contract, getAddress, keccak256, type JsonRpcProvider } from "ethers";
export interface RuntimeIdentity {
  chainId: bigint;
  clearingAddress: string;
  tokenAddress: string;
  oracleAddress: string;
  oracleSigners: string[];
  oracleThreshold: number;
  governance: string;
  emergencyCouncil: string;
  approvers: [string, string, string];
  code: Array<{ address: string; hash: string }>;
  implementationAddress: string;
  riskMathAddress: string;
  signatureVerifierAddress: string;
}
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** Both independent RPCs must attest to one pinned block and the reviewed authority/oracle-signer/code identity. */
export async function validateRuntimeIdentity(
  primary: JsonRpcProvider,
  secondary: JsonRpcProvider,
  expected: RuntimeIdentity,
) {
  const address = getAddress(expected.clearingAddress),
    tag = Number(BigInt(await primary.send("eth_blockNumber", []))),
    [network, otherNetwork, block, otherBlock] = await Promise.all([
      primary.getNetwork(),
      secondary.getNetwork(),
      primary.getBlock(tag),
      secondary.getBlock(tag),
    ]);
  if (
    network.chainId !== expected.chainId ||
    otherNetwork.chainId !== expected.chainId ||
    !block?.hash ||
    block.hash !== otherBlock?.hash
  )
    throw new Error("runtime RPC chain/block identity mismatch");
  const normalized = expected.code.map((item) => ({
      address: getAddress(item.address),
      hash: item.hash.toLowerCase(),
    })),
    required = [
      address,
      expected.tokenAddress,
      expected.oracleAddress,
      expected.implementationAddress,
      expected.riskMathAddress,
      expected.signatureVerifierAddress,
    ].map(getAddress);
  if (
    new Set(normalized.map((item) => item.address)).size !== normalized.length ||
    required.some((item) => !normalized.some((code) => code.address === item)) ||
    normalized.some((item) => !/^0x[0-9a-f]{64}$/.test(item.hash))
  )
    throw new Error("runtime code identity manifest incomplete");
  if (
    new Set([...expected.approvers, expected.governance, expected.emergencyCouncil].map(getAddress)).size !==
    5
  )
    throw new Error("runtime authorities/approvers must be distinct");
  const wantedSigners = expected.oracleSigners.map(getAddress).sort();
  if (
    new Set(wantedSigners).size !== wantedSigners.length ||
    expected.oracleThreshold * 2 <= wantedSigners.length ||
    expected.oracleThreshold > wantedSigners.length
  )
    throw new Error("runtime oracle signers must be distinct with a majority threshold");
  for (const provider of [primary, secondary]) {
    const clearing = new Contract(
        address,
        [
          "function usdc() view returns(address)",
          "function oracle() view returns(address)",
          "function governance() view returns(address)",
          "function emergencyCouncil() view returns(address)",
          "function approvers(uint256) view returns(address)",
        ],
        provider,
      ),
      adapter = new Contract(
        expected.oracleAddress,
        [
          "function signers() view returns(address[])",
          "function threshold() view returns(uint8)",
          "function clearing() view returns(address)",
        ],
        provider,
      ),
      token = new Contract(expected.tokenAddress, ["function decimals() view returns(uint8)"], provider),
      opts = { blockTag: tag };
    const [
      implementation,
      usdc,
      oracle,
      governance,
      emergency,
      signers,
      threshold,
      adapterClearing,
      decimals,
      ...rest
    ] = await Promise.all([
      provider.getStorage(address, IMPLEMENTATION_SLOT, tag),
      clearing.usdc(opts),
      clearing.oracle(opts),
      clearing.governance(opts),
      clearing.emergencyCouncil(opts),
      adapter.signers(opts),
      adapter.threshold(opts),
      adapter.clearing(opts),
      token.decimals(opts),
      clearing.approvers(0, opts),
      clearing.approvers(1, opts),
      clearing.approvers(2, opts),
    ]);
    const same = (actual: string, wanted: string) => getAddress(actual) === getAddress(wanted);
    if (
      !same(`0x${String(implementation).slice(-40)}`, expected.implementationAddress) ||
      !same(usdc, expected.tokenAddress) ||
      !same(oracle, expected.oracleAddress) ||
      !same(governance, expected.governance) ||
      !same(emergency, expected.emergencyCouncil) ||
      !same(adapterClearing, address) ||
      decimals !== 6n
    )
      throw new Error("runtime contract/token/authority identity mismatch");
    const actualSigners = Array.from(signers as string[], getAddress).sort();
    if (Number(threshold) !== expected.oracleThreshold || actualSigners.join() !== wantedSigners.join())
      throw new Error("runtime oracle signer mismatch");
    for (let i = 0; i < 3; i++)
      if (!same(rest[i], expected.approvers[i])) throw new Error("runtime approver identity mismatch");
    const actual = await Promise.all(
      normalized.map(async (item) => ({ item, code: await provider.getCode(item.address, tag) })),
    );
    if (actual.some(({ item, code }) => code === "0x" || keccak256(code) !== item.hash))
      throw new Error("runtime deployed bytecode identity mismatch");
    const implementationCode = actual
      .find(({ item }) => item.address === getAddress(expected.implementationAddress))!
      .code.toLowerCase();
    if (
      [expected.riskMathAddress, expected.signatureVerifierAddress].some(
        (link) => !implementationCode.includes(link.slice(2).toLowerCase()),
      )
    )
      throw new Error("runtime implementation linked-module mismatch");
  }
  return { block: tag, hash: block.hash };
}
