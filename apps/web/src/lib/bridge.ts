// Deposits from other networks and assets through LI.FI (li.quest): a route
// swaps and bridges the user's asset into USDC in their own Base wallet, then a
// gas-free deposit moves it into the trading balance. A route response never
// creates collateral (docs/architecture/wallets-and-deposits.md): the app only
// credits what the clearing contract emits.
//
// LI.FI is not trusted to choose where funds go. checkRoute pins the source
// and destination chains, tokens, amount and wallet, and the contract the
// wallet sends to and approves.
//
// Pure, so bridge.test.ts runs it under Node.
import { getAddress, isAddress, type Address } from "viem";

export const LIFI_API = "https://li.quest/v1";
/** LI.FI's router (LiFiDiamond), at the same address on every supported source chain. */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** Slippage the route may take on swaps and bridges, as a fraction. */
export const ROUTE_SLIPPAGE = 0.005;
/** A route that loses more than this share of its value to fees and price impact is refused. */
export const MAX_ROUTE_LOSS = 0.05;
/** Above this share the sheet warns about the cost. */
export const WARN_ROUTE_LOSS = 0.01;
/** Settlement chain the routes deliver to. Cross-chain deposits are offered only there. */
export const BASE_CHAIN_ID = 8453;

export type SourceToken = { address: Address; symbol: string; decimals: number; name?: string; logoURI?: string; priceUSD?: string };
export type SourceChain = { id: number; name: string; tokens: SourceToken[] };

const token = (address: Address, symbol: string, decimals: number): SourceToken => ({ address, symbol, decimals });
/** Networks a deposit can come from, with the assets offered even before balances load. */
export const SOURCE_CHAINS: SourceChain[] = [
  { id: 1, name: "Ethereum", tokens: [token(NATIVE, "ETH", 18), token("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6), token("0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", 6)] },
  { id: 42161, name: "Arbitrum", tokens: [token(NATIVE, "ETH", 18), token("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", 6), token("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT0", 6)] },
  { id: 10, name: "Optimism", tokens: [token(NATIVE, "ETH", 18), token("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USDC", 6), token("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "USDT", 6)] },
  { id: 137, name: "Polygon", tokens: [token(NATIVE, "POL", 18), token("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", 6), token("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", 6)] },
  { id: 56, name: "BNB Chain", tokens: [token(NATIVE, "BNB", 18), token("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", 18), token("0x55d398326f99059fF775485246999027B3197955", "USDT", 18)] },
  { id: 43114, name: "Avalanche", tokens: [token(NATIVE, "AVAX", 18), token("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USDC", 6), token("0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "USDt", 6)] },
  // Other assets on Base swap into USDC. Base USDC itself deposits directly.
  { id: BASE_CHAIN_ID, name: "Base", tokens: [token(NATIVE, "ETH", 18)] },
];
export const sourceChain = (id: number) => SOURCE_CHAINS.find(chain => chain.id === id);
export const isNative = (address: string) => address.toLowerCase() === NATIVE;
const same = (a: unknown, b: string) => typeof a === "string" && isAddress(a, { strict: false }) && getAddress(a) === getAddress(b);

/** One asset the wallet holds on a source chain, from LI.FI's balance index. */
export type Holding = SourceToken & { chainId: number; amount: bigint; usd: number };

type BalanceEntry = { address?: string; symbol?: string; decimals?: number; name?: string; logoURI?: string; priceUSD?: string; amount?: string; verificationStatus?: string };

/**
 * The wallet's assets on supported source chains, most valuable first. Base USDC is left out (it is
 * the direct option), as are dust under $0.50 and tokens LI.FI has not verified.
 */
export function holdingsFrom(body: unknown, usdcOnBase: string): Holding[] {
  const balances = (body as { balances?: Record<string, BalanceEntry[]> } | null)?.balances ?? {};
  const holdings: Holding[] = [];
  for (const [chainKey, entries] of Object.entries(balances)) {
    const chainId = Number(chainKey);
    if (!sourceChain(chainId) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry.address || !isAddress(entry.address, { strict: false }) || typeof entry.decimals !== "number" || !entry.symbol) continue;
      if (entry.verificationStatus && entry.verificationStatus !== "verified") continue;
      if (chainId === BASE_CHAIN_ID && same(entry.address, usdcOnBase)) continue;
      let amount: bigint;
      try { amount = BigInt(entry.amount ?? "0"); } catch { continue; }
      if (amount <= 0n) continue;
      const usd = Number(entry.priceUSD ?? 0) * Number(amount) / 10 ** entry.decimals;
      if (!(usd >= 0.5)) continue;
      holdings.push({ chainId, address: getAddress(entry.address), symbol: entry.symbol, decimals: entry.decimals, name: entry.name, logoURI: entry.logoURI, priceUSD: entry.priceUSD, amount, usd });
    }
  }
  return holdings.sort((a, b) => b.usd - a.usd);
}

export type RouteRequest = {
  fromChain: number;
  fromToken: Address;
  /** In the source token's smallest unit. */
  fromAmount: bigint;
  account: Address;
  /** Base USDC (the settlement token). */
  toToken: Address;
};

/** LI.FI quote for delivering Base USDC to the user's own wallet, with no destination contract call. */
export function quoteUrl(request: RouteRequest) {
  const params = new URLSearchParams({
    fromChain: String(request.fromChain),
    toChain: String(BASE_CHAIN_ID),
    fromToken: request.fromToken,
    toToken: request.toToken,
    fromAmount: request.fromAmount.toString(),
    fromAddress: request.account,
    toAddress: request.account,
    slippage: String(ROUTE_SLIPPAGE),
    order: "FASTEST",
    allowDestinationCall: "false",
    integrator: "rfq-markets",
  });
  return `${LIFI_API}/quote?${params}`;
}

type Cost = { name?: string; amountUSD?: string; included?: boolean };
type QuoteToken = { address?: string; symbol?: string; decimals?: number; priceUSD?: string };
/** The parts of a LI.FI quote the app reads. */
export type LifiQuote = {
  id?: string;
  tool?: string;
  toolDetails?: { name?: string; logoURI?: string };
  action?: { fromChainId?: number; toChainId?: number; fromToken?: QuoteToken; toToken?: QuoteToken; fromAmount?: string; fromAddress?: string; toAddress?: string };
  estimate?: {
    approvalAddress?: string;
    toAmount?: string;
    toAmountMin?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    executionDuration?: number;
    feeCosts?: Cost[];
    gasCosts?: Cost[];
  };
  transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string };
};

/** A quote checked against the request, ready to show and send. */
export type Route = {
  request: RouteRequest;
  tool: string;
  toAmount: bigint;
  toAmountMin: bigint;
  fromUsd: number | null;
  toUsd: number | null;
  /** Bridge, swap and LI.FI fees in USD (taken from the amount sent). */
  feesUsd: number;
  /** Source-chain network gas in USD, paid by the wallet on top. */
  gasUsd: number;
  durationSeconds: number;
  /** Share of the sent value lost to fees, gas and price impact; null without prices. */
  loss: number | null;
  /** Base USDC received per whole source token. */
  rate: number;
  approval: Address | null;
  transaction: { to: Address; data: `0x${string}`; value: bigint; chainId: number };
};

const usdSum = (costs: Cost[] | undefined) => (costs ?? []).reduce((total, cost) => total + (Number(cost.amountUSD) || 0), 0);
const toBig = (value: unknown) => {
  try { return typeof value === "string" || typeof value === "number" ? BigInt(value) : null; } catch { return null; }
};

/** Checks a LI.FI quote against what the user asked for; throws with the reason when it does not match. */
export function checkRoute(quote: LifiQuote, request: RouteRequest, decimals: number): Route {
  const { action, estimate, transactionRequest: tx } = quote;
  const fail = (why: string): never => { throw new Error(`The route does not match your deposit (${why})`); };
  if (!action || !estimate || !tx) fail("incomplete quote");
  if (action!.fromChainId !== request.fromChain || tx!.chainId !== request.fromChain) fail("source network");
  if (action!.toChainId !== BASE_CHAIN_ID) fail("destination network");
  if (!same(action!.fromToken?.address, request.fromToken)) fail("source asset");
  if (!same(action!.toToken?.address, request.toToken)) fail("destination asset");
  if (toBig(action!.fromAmount) !== request.fromAmount) fail("amount");
  if (!same(action!.fromAddress, request.account) || !same(action!.toAddress, request.account)) fail("recipient");
  if (!same(tx!.to, LIFI_DIAMOND)) fail("router");
  const native = isNative(request.fromToken);
  if (!native && !same(estimate!.approvalAddress, LIFI_DIAMOND)) fail("approval");
  const value = toBig(tx!.value ?? "0");
  if (value === null || value !== (native ? request.fromAmount : 0n)) fail("value");
  if (typeof tx!.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(tx!.data)) fail("calldata");
  const toAmount = toBig(estimate!.toAmount), toAmountMin = toBig(estimate!.toAmountMin);
  if (toAmount === null || toAmountMin === null || toAmountMin <= 0n || toAmountMin > toAmount) fail("output");
  const fromUsd = Number(estimate!.fromAmountUSD) || null, toUsd = Number(estimate!.toAmountUSD) || null;
  const gasUsd = usdSum(estimate!.gasCosts);
  const loss = fromUsd && toUsd ? Math.max(0, (fromUsd + gasUsd - toUsd) / (fromUsd + gasUsd)) : null;
  const sent = Number(request.fromAmount) / 10 ** decimals;
  return {
    request,
    tool: quote.toolDetails?.name ?? quote.tool ?? "LI.FI",
    toAmount: toAmount!,
    toAmountMin: toAmountMin!,
    fromUsd,
    toUsd,
    feesUsd: usdSum(estimate!.feeCosts),
    gasUsd,
    durationSeconds: Math.max(0, Number(estimate!.executionDuration) || 0),
    loss,
    rate: sent > 0 ? Number(toAmount!) / 1e6 / sent : 0,
    approval: native ? null : LIFI_DIAMOND,
    transaction: { to: LIFI_DIAMOND, data: tx!.data as `0x${string}`, value: value!, chainId: request.fromChain },
  };
}

/** Why a checked route cannot be used, or null. */
export function routeProblem(route: Route, firstDeposit: boolean, minFirstDeposit: bigint): string | null {
  if (route.loss !== null && route.loss > MAX_ROUTE_LOSS) return "Fees take too much of this amount";
  if (firstDeposit && route.toAmountMin < minFirstDeposit) return "First deposit must deliver at least $10.00";
  return null;
}

/** "about 30 sec", "about 3 min", "about 1 hr". */
export function formatDuration(seconds: number) {
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} sec`;
  if (seconds < 3_600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${Math.round(seconds / 3_600)} hr`;
}

/** "1 ETH = 2,488.61 USDC"; small rates keep significant digits. */
export function formatRate(route: Route, symbol: string) {
  const digits = route.rate >= 100 ? 2 : route.rate >= 1 ? 4 : 6;
  return `1 ${symbol} = ${route.rate.toLocaleString("en-US", { maximumFractionDigits: digits })} USDC`;
}

export const formatUsd = (value: number) =>
  value > 0 && value < 0.01 ? "< $0.01" : value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type BridgeStatus =
  | { state: "pending"; detail?: string }
  | { state: "done"; received: bigint }
  /** Delivered something other than Base USDC (LI.FI's PARTIAL or REFUNDED). */
  | { state: "other"; detail: string }
  | { state: "failed"; detail: string };

type StatusBody = {
  status?: string;
  substatus?: string;
  substatusMessage?: string;
  receiving?: { amount?: string; token?: { address?: string; symbol?: string; chainId?: number }; chainId?: number };
};

/** Reads LI.FI's /status answer for a route that should deliver Base USDC to the wallet. */
export function bridgeStatus(body: unknown, usdcOnBase: string): BridgeStatus {
  const status = body as StatusBody | null;
  switch (status?.status) {
    case "DONE": {
      const received = toBig(status.receiving?.amount);
      const usdc = same(status.receiving?.token?.address, usdcOnBase) && (status.receiving?.token?.chainId ?? status.receiving?.chainId) === BASE_CHAIN_ID;
      if (status.substatus === "COMPLETED" && usdc && received !== null) return { state: "done", received };
      const symbol = status.receiving?.token?.symbol ?? "another asset";
      return { state: "other", detail: status.substatus === "REFUNDED" ? "The route was refunded to your wallet on the source network." : `You received ${symbol} instead of USDC. It is in your wallet.` };
    }
    case "FAILED":
    case "INVALID":
      return { state: "failed", detail: status.substatusMessage ?? "The route failed. Funds stay in your wallet or are refunded." };
    default:
      return { state: "pending", detail: status?.substatusMessage };
  }
}

export const statusUrl = (txHash: string, fromChain: number) =>
  `${LIFI_API}/status?${new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(BASE_CHAIN_ID) })}`;
export const explorerUrl = (txHash: string) => `https://scan.li.fi/tx/${txHash}`;
export const balancesUrl = (account: string) => `${LIFI_API}/wallets/${account}/balances?extended=true`;

/** Amount in the token's smallest unit from a decimal input, or null. */
export function parseTokenInput(text: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return value > 0n ? value : null;
}

/** Up to `digits` decimals, trailing zeros trimmed. */
export function formatTokenAmount(value: bigint, decimals: number, digits = 6) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let fraction = (value % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  if (whole === 0n && !fraction && value > 0n) fraction = "0".repeat(Math.max(0, digits - 1)) + "1";
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** GET from LI.FI, surfacing its own error message (it answers {message} rather than {error}). */
export async function lifiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  if (response.status === 429) throw new Error("Too many route requests. Wait a minute and try again");
  if (!response.ok) throw new Error(body?.message ?? `Route service unavailable (${response.status})`);
  return body as T;
}
