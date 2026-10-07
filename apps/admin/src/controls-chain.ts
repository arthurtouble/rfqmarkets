// The market controls' chain access. Reads go through the operator's wallet when one is connected (so the
// page's CSP needs no RPC host), else the API's public RPC URL. Writes are signed by the operator's own wallet
// in the browser: no server holds a key that can change a market.
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  encodeBytes32String,
  decodeBytes32String,
  type Eip1193Provider,
  type Provider,
  type Signer,
} from "ethers";
import type { Call, ChainMarket, ConsoleState } from "./controls-model.js";

const env: Partial<ImportMetaEnv> = import.meta.env ?? {};
// Same-origin: the private edge (deployed) or the Vite dev server (locally) forwards these paths to the API.
const API = env.VITE_API_URL ?? "";

export const CLEARING_ABI = [
  "function marketCount() view returns(uint8)",
  "function marketParams(uint8) view returns((bytes32 symbol,uint32 impactK,uint16 shockBps,uint16 marginScaleBps))",
  "function markets(uint256) view returns(int256 aggregateBase,int256 fundingIndex,uint64 fundingTime,uint64 lastPriceTime,uint256 lastBid,uint256 lastAsk,bool enabled)",
  "function marketLimits(uint8) view returns((uint128 maxTradeNotional,uint128 maxMarketNotional))",
  "function exposureState(uint8) view returns(uint256 longBase,uint256 shortBase,uint256 limits,uint256 cursor,bool ready)",
  "function marketSpread(uint8) view returns(uint16)",
  "function defaultSpread() view returns(uint16)",
  "function riskOperatorBounds() view returns((uint128 maxTradeNotional,uint128 maxMarketNotional,uint128 maxGrossLimit,uint32 minImpactK,uint16 minShockBps,uint16 minMarginScaleBps))",
  "function governance() view returns(address)",
  "function riskOperator() view returns(address)",
  "function emergencyCouncil() view returns(address)",
  "function paused() view returns(bool)",
  "function setMarketPolicy(uint8,bool,uint128,uint128)",
  "function setExposurePolicy(uint8,uint128,uint128)",
  "function setMarketRisk(uint8,uint32,uint16,uint16)",
  "function setSpread(uint8,uint16)",
  "function addMarket((bytes32 symbol,bool enabled,uint128 maxTradeNotional,uint128 maxMarketNotional,uint128 grossLimit,uint128 sideLimit,uint32 impactK,uint16 shockBps,uint16 marginScaleBps)) returns(uint8)",
  "error Unauthorized()",
  "error InvalidTrade()",
  "error InvalidConfiguration()",
] as const;

/** `GET /v1/config` from the API: the chain and clearing contract the venue runs on. */
export type VenueConfig = { chainId: string; chainName: string; rpcUrl?: string; clearingAddress: string };

export async function loadVenueConfig(signal?: AbortSignal): Promise<VenueConfig> {
  const response = await fetch(`${API}/v1/config`, { signal });
  if (!response.ok) throw new Error(`The API's venue config answered ${response.status}`);
  const config = (await response.json()) as VenueConfig;
  if (!config.clearingAddress || !config.chainId)
    throw new Error("The API's venue config has no clearing contract");
  return config;
}

const LOW = (1n << 128n) - 1n;

/** Read everything the console shows. A deployment without the risk operator views reads as `legacy`. */
export async function readConsole(provider: Provider, clearingAddress: string): Promise<ConsoleState> {
  const clearing = new Contract(clearingAddress, CLEARING_ABI, provider);
  const [count, governance, emergencyCouncil, paused] = await Promise.all([
    clearing.marketCount(),
    clearing.governance(),
    clearing.emergencyCouncil(),
    clearing.paused(),
  ]);
  let legacy = false,
    riskOperator = "0x0000000000000000000000000000000000000000",
    bounds = {
      maxTradeNotional: 0n,
      maxMarketNotional: 0n,
      maxGrossLimit: 0n,
      minImpactK: 0,
      minShockBps: 0,
      minMarginScaleBps: 0,
    },
    defaultSpreadBps = 0;
  try {
    const [operator, rawBounds, spread] = await Promise.all([
      clearing.riskOperator(),
      clearing.riskOperatorBounds(),
      clearing.defaultSpread(),
    ]);
    riskOperator = operator;
    bounds = {
      maxTradeNotional: rawBounds.maxTradeNotional,
      maxMarketNotional: rawBounds.maxMarketNotional,
      maxGrossLimit: rawBounds.maxGrossLimit,
      minImpactK: Number(rawBounds.minImpactK),
      minShockBps: Number(rawBounds.minShockBps),
      minMarginScaleBps: Number(rawBounds.minMarginScaleBps),
    };
    defaultSpreadBps = Number(spread);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "BAD_DATA" && code !== "CALL_EXCEPTION") throw error;
    legacy = true;
  }
  const markets: ChainMarket[] = await Promise.all(
    Array.from({ length: Number(count) }, async (_, index): Promise<ChainMarket> => {
      const [params, state, limits, exposure, spread] = await Promise.all([
        clearing.marketParams(index),
        clearing.markets(index),
        clearing.marketLimits(index),
        clearing.exposureState(index),
        legacy ? 0n : clearing.marketSpread(index),
      ]);
      const word = BigInt(exposure.limits);
      return {
        index,
        symbol: decodeBytes32String(params.symbol),
        enabled: Boolean(state.enabled),
        maxTradeNotional: BigInt(limits.maxTradeNotional),
        maxMarketNotional: BigInt(limits.maxMarketNotional),
        grossLimit: word & LOW,
        sideLimit: word >> 128n,
        impactK: Number(params.impactK),
        shockBps: Number(params.shockBps),
        marginScaleBps: Number(params.marginScaleBps),
        spreadBps: Number(spread),
      };
    }),
  );
  return { markets, bounds, defaultSpreadBps, governance, riskOperator, emergencyCouncil, paused, legacy };
}

// ---- Wallets ----

export type Operator = {
  kind: "injected" | "local";
  account: string;
  signer: Signer;
  provider: Provider;
  chainId: bigint;
};

type Injected = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export const injectedWallet = (): Injected | undefined => (globalThis as { ethereum?: Injected }).ethereum;

/** Connect the browser wallet (MetaMask, Rabby, a Safe in WalletConnect's browser…) and switch it to the venue's chain. */
export async function connectInjected(config: VenueConfig): Promise<Operator> {
  const wallet = injectedWallet();
  if (!wallet)
    throw new Error("No browser wallet found. Install one, or open this page in a wallet's browser.");
  await wallet.request({ method: "eth_requestAccounts" });
  const target = BigInt(config.chainId);
  let provider = new BrowserProvider(wallet);
  if ((await provider.getNetwork()).chainId !== target) {
    try {
      await wallet.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${target.toString(16)}` }],
      });
    } catch {
      throw new Error(`Switch the wallet to ${config.chainName} (chain ${target}) and connect again.`);
    }
    provider = new BrowserProvider(wallet);
  }
  const signer = await provider.getSigner();
  return { kind: "injected", account: await signer.getAddress(), signer, provider, chainId: target };
}

/**
 * Development only: sign with the local stack's risk operator key, which the API serves on a local chain
 * (`/v1/dev/risk-operator`). A production build refuses before fetching anything.
 */
export async function connectLocalOperator(config: VenueConfig): Promise<Operator> {
  if (!env.DEV) throw new Error("The local operator exists only in development builds");
  const response = await fetch(`${API}/v1/dev/risk-operator`);
  if (!response.ok)
    throw new Error("The local stack has no risk operator. Redeploy with `npm run dev:stack`.");
  const { privateKey } = (await response.json()) as { privateKey: string };
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);
  // Back-to-back calls (a listing and its spread) must not reuse a nonce the RPC still reports as pending.
  return {
    kind: "local",
    account: wallet.address,
    signer: new NonceManager(wallet),
    provider,
    chainId: BigInt(config.chainId),
  };
}

/**
 * Where reads go: the connected wallet, else (development only) the local chain's RPC. Deployed, the page's CSP
 * allows no RPC host, so markets load once a wallet is connected.
 */
export const readProvider = (config: VenueConfig, operator?: Operator): Provider | undefined =>
  operator?.provider ??
  (env.DEV && config.rpcUrl
    ? new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true })
    : undefined);

// ---- Sending ----

const encodeArgs = (call: Call) =>
  call.fn === "addMarket"
    ? [
        {
          ...(call.args[0] as Record<string, unknown>),
          symbol: encodeBytes32String((call.args[0] as { symbol: string }).symbol),
        },
      ]
    : call.args;

/** Simulate the call as the operator first, so a refusal is explained before the wallet asks to sign. */
export async function simulate(operator: Operator, clearingAddress: string, call: Call) {
  const clearing = new Contract(clearingAddress, CLEARING_ABI, operator.signer);
  await clearing.getFunction(call.fn).staticCall(...encodeArgs(call));
}

/** Send one call and wait for it to be mined. */
export async function send(operator: Operator, clearingAddress: string, call: Call) {
  const clearing = new Contract(clearingAddress, CLEARING_ABI, operator.signer);
  const tx = await clearing.getFunction(call.fn).send(...encodeArgs(call));
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${tx.hash} failed`);
  return tx.hash as string;
}
