// Pure account logic and formatting for the exit page: no wallet, no network.

export const BASE_UNIT = 10n ** 18n;
/** Seconds a stored oracle price counts as fresh on chain (MAX_ORACLE_AGE). */
export const MAX_ORACLE_AGE = 15;

export interface Position {
  market: number;
  symbol: string;
  /** Signed base units (1e18 per coin); positive is long. */
  size: bigint;
  /** USDC micro-units per coin. */
  entryPrice: bigint;
}

export interface MarketPrice {
  bid: bigint;
  ask: bigint;
  /** Unix seconds of the last price stored on chain. */
  time: number;
}

export type ResolutionPhase = "none" | "pricing" | "processing" | "claimable";

export interface Resolution {
  required: boolean;
  pricesReady: boolean;
  finalized: boolean;
  /** Price samples recorded so far, the highest across markets. */
  samples: number;
  cursor: bigint;
  accounts: bigint;
  claim: bigint;
  paid: bigint;
  totalClaims: bigint;
  assets: bigint;
}

export interface AccountState {
  account: string;
  /** Chain time of the block the state was read at. */
  now: number;
  paused: boolean;
  collateral: bigint;
  openingEquity: bigint;
  initialMargin: bigint;
  positions: Position[];
  prices: Map<number, MarketPrice>;
  resolution: Resolution;
  walletUsdc: bigint;
  walletEth: bigint;
}

export function resolutionPhase(resolution: Resolution): ResolutionPhase {
  if (!resolution.required) return "none";
  if (resolution.finalized) return "claimable";
  return resolution.pricesReady ? "processing" : "pricing";
}

/** What a finalized resolution still owes this account: its pro-rata entitlement less what it was paid. */
export function claimable(resolution: Resolution): bigint {
  if (!resolution.finalized || resolution.totalClaims === 0n) return 0n;
  const pool = resolution.assets < resolution.totalClaims ? resolution.assets : resolution.totalClaims;
  const entitlement = resolution.claim * pool / resolution.totalClaims;
  return entitlement > resolution.paid ? entitlement - resolution.paid : 0n;
}

/**
 * Estimated collateral the contract lets the owner withdraw now: all of it with no open positions,
 * otherwise what keeps opening equity at initial margin. Prices move, so with positions open the page
 * offers a little less than this as its maximum.
 */
export function withdrawable(state: Pick<AccountState, "collateral" | "openingEquity" | "initialMargin" | "positions">): bigint {
  if (state.collateral <= 0n) return 0n;
  if (!state.positions.length) return state.collateral;
  const free = state.openingEquity - state.initialMargin;
  if (free <= 0n) return 0n;
  return free < state.collateral ? free : state.collateral;
}

/** The maximum the page fills in: 98% of the estimate while positions are open, so a small price move does not fail it. */
export function withdrawMax(state: Pick<AccountState, "collateral" | "openingEquity" | "initialMargin" | "positions">): bigint {
  const estimate = withdrawable(state);
  return state.positions.length ? estimate * 98n / 100n : estimate;
}

/** Markets whose stored price is too old for a withdrawal that has open positions. */
export function staleMarkets(state: Pick<AccountState, "positions" | "prices" | "now">): number[] {
  return state.positions
    .filter(position => {
      const price = state.prices.get(position.market);
      return !price || price.time === 0 || state.now - price.time > MAX_ORACLE_AGE;
    })
    .map(position => position.market);
}

/** Longs close at the bid, shorts at the ask. */
export const exitPrice = (position: Position, price: Pick<MarketPrice, "bid" | "ask">) => (position.size > 0n ? price.bid : price.ask);

/** Profit or loss of closing at `price`, before funding. */
export const closePnl = (position: Position, price: bigint) => position.size * (price - position.entryPrice) / BASE_UNIT;

// ---- Formatting ----

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const coins = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const ether = new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 });

const scaled = (value: bigint, decimals: number) => Number(value) / 10 ** decimals;
export const abs = (value: bigint) => (value < 0n ? -value : value);

export const formatUsd = (micro: bigint) => usd.format(scaled(micro, 6));
export const formatSignedUsd = (micro: bigint) => `${micro > 0n ? "+" : micro < 0n ? "−" : ""}${usd.format(scaled(abs(micro), 6))}`;
export const formatSize = (size: bigint, symbol: string) => `${coins.format(scaled(abs(size), 18))} ${symbol}`;
export const formatEth = (wei: bigint) => `${ether.format(scaled(wei, 18))} ETH`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const side = (position: Position) => (position.size > 0n ? "Long" : "Short");

const DECIMAL = /^\d+(\.\d*)?$|^\.\d+$/;
/** A typed USDC amount in micro-units, or null unless it is a positive number with at most 6 decimals. */
export function parseUsdc(text: string): bigint | null {
  const value = text.trim().replace(/,/g, "");
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 6) return null;
  const micro = BigInt(whole || "0") * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  return micro > 0n ? micro : null;
}

/** Micro-units to the plain decimal an input shows. */
export function usdcInput(micro: bigint): string {
  const whole = micro / 1_000_000n, fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** A nonce typed by the user: a non-negative integer that fits in uint256. */
export function parseNonce(text: string): bigint | null {
  const value = text.trim();
  if (!/^\d{1,78}$/.test(value)) return null;
  const nonce = BigInt(value);
  return nonce < 2n ** 256n ? nonce : null;
}
