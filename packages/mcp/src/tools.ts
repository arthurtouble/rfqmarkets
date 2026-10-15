// The tools an agent sees: the same Up / Down bets the app offers (pick a market, a direction, a stake and
// a multiplier, cash out whenever), plus prices and the account. Amounts in and out are plain US dollars;
// the venue's 6-decimal USDC integers stay inside this file.

import type { Side } from "../../shared/src/api-types.js";
import type { Tool } from "./protocol.js";

type Wire = Record<string, unknown>;

/** The slice of `RfqClient` the tools call, so tests can pass a stub. */
export interface Venue {
  markets(): Promise<unknown>;
  quote(input: { market: string; side: Side; amount: string; account?: string }): Promise<unknown>;
  account(address?: string): Promise<unknown>;
  trade(input: { market: string; side: Side; amount: string }): Promise<unknown>;
  close(input: { market: string; fraction?: number }): Promise<unknown>;
  closeAll(input?: { fraction?: number }): Promise<unknown>;
  tpsl(input: { market: string; takeProfitPrice?: string; stopLossPrice?: string }): Promise<unknown>;
}

export interface Limits {
  /** Largest stake one bet may put up, in dollars. */
  maxStake: number;
  /** Highest multiplier a bet may use; a market's own cap applies when lower. */
  maxMultiplier: number;
}

export const DEFAULT_LIMITS: Limits = { maxStake: 100, maxMultiplier: 10 };

const MICRO = 1_000_000;

/** A 6-decimal USDC integer string as dollars. */
export const dollars = (micro: unknown) => Number(BigInt(String(micro ?? 0))) / MICRO;

/** Dollars as the API's decimal string, rounded to the cent's ten-thousandth (6 decimals). */
export function toAmount(value: number) {
  const micro = BigInt(Math.round(value * MICRO));
  const whole = micro / BigInt(MICRO),
    fraction = (micro % BigInt(MICRO)).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

type MarketRow = {
  market: string;
  bid: string;
  ask: string;
  mid: string;
  enabled: boolean;
  canBuy: boolean;
  canSell: boolean;
  maxLeverage: number;
  observedAtMs: number;
};

async function marketTable(venue: Venue) {
  const { markets } = (await venue.markets()) as { markets: Record<string, MarketRow> };
  return markets;
}

async function marketOf(venue: Venue, symbol: string) {
  const markets = await marketTable(venue),
    market = markets[symbol];
  if (!market) throw new Error(`unknown market ${symbol}; list_markets shows the open ones`);
  return market;
}

const marketArg = (args: Wire) => {
  const value = args.market;
  if (typeof value !== "string" || !value.trim()) throw new Error("market is required, such as BTC");
  return value.trim().toUpperCase();
};

const positive = (args: Wire, key: string) => {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return value;
};

const optionalPrice = (args: Wire, key: string) =>
  args[key] === undefined || args[key] === null ? undefined : positive(args, key);

const direction = (args: Wire): "up" | "down" => {
  if (args.direction !== "up" && args.direction !== "down")
    throw new Error('direction must be "up" or "down"');
  return args.direction;
};

const sideOf = (dir: "up" | "down"): Side => (dir === "up" ? "buy" : "sell");

/** Checks a bet against the server's limits and the market, and returns its position size in dollars. */
async function checkedBet(venue: Venue, limits: Limits, args: Wire) {
  const market = marketArg(args),
    dir = direction(args),
    stake = positive(args, "stake"),
    multiplier = args.multiplier === undefined ? 1 : positive(args, "multiplier");
  if (stake > limits.maxStake) throw new Error(`stake is above this server's limit of $${limits.maxStake}`);
  if (multiplier < 1) throw new Error("multiplier must be at least 1");
  const row = await marketOf(venue, market),
    cap = Math.min(limits.maxMultiplier, row.maxLeverage || limits.maxMultiplier);
  if (multiplier > cap) throw new Error(`multiplier is above ${cap}×, the most ${market} allows here`);
  if (!row.enabled || !(dir === "up" ? row.canBuy : row.canSell))
    throw new Error(`${market} is not taking ${dir} bets right now`);
  return { market, dir, stake, multiplier, size: toAmount(stake * multiplier) };
}

const quoteView = (quote: Wire, dir: "up" | "down") => ({
  market: quote.market,
  direction: dir,
  positionSize: dollars(quote.amount),
  price: dollars(quote.expectedPrice),
  worstPrice: dollars(quote.worstPrice),
  fee: dollars(quote.fee),
  expiresAtMs: quote.expiresAtMs,
});

type PositionView = {
  size: string;
  entryPrice: string;
  markPrice: string;
  notional: string;
  unrealizedPnl: string;
  accruedFunding: string;
  initialMargin: string;
  estimatedLiquidationPrice?: string | null;
};

const betsOf = (positions: Record<string, PositionView>) =>
  Object.entries(positions)
    .filter(([, position]) => BigInt(position.size) !== 0n)
    .map(([market, position]) => {
      const pnl = dollars(position.unrealizedPnl) + dollars(position.accruedFunding),
        margin = dollars(position.initialMargin);
      return {
        market,
        direction: BigInt(position.size) > 0n ? "up" : "down",
        positionSize: dollars(position.notional),
        entryPrice: dollars(position.entryPrice),
        price: dollars(position.markPrice),
        pnl: Math.round(pnl * 100) / 100,
        returnPct: margin > 0 ? Math.round((pnl / margin) * 1000) / 10 : null,
        liquidationPrice:
          position.estimatedLiquidationPrice == null ? null : dollars(position.estimatedLiquidationPrice),
      };
    });

const fillView = (result: Wire) => {
  const transaction = (result.transaction ?? {}) as Wire,
    quote = (result.quote ?? {}) as Wire;
  return {
    market: quote.market,
    price: dollars(quote.expectedPrice),
    positionSize: dollars(quote.amount),
    fee: dollars(quote.fee),
    transaction: transaction.hash,
    balance: transaction.collateral === undefined ? undefined : dollars(transaction.collateral),
  };
};

const marketSchema = { type: "string", description: "Market symbol, such as BTC or ETH" };
const betSchema = {
  type: "object",
  properties: {
    market: marketSchema,
    direction: { type: "string", enum: ["up", "down"], description: "up wins if the price rises" },
    stake: { type: "number", description: "Dollars put up for the bet" },
    multiplier: { type: "number", description: "Leverage, 1 or more (default 1)" },
  },
  required: ["market", "direction", "stake"],
  additionalProperties: false,
};

/** The read tools, which need no key. */
export function readTools(venue: Venue): Tool[] {
  return [
    {
      name: "list_markets",
      title: "List markets",
      description: "Markets open for bets, with the current price and the highest multiplier each allows.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run() {
        return Object.values(await marketTable(venue))
          .filter((row) => row.enabled)
          .map((row) => ({
            market: row.market,
            price: dollars(row.mid),
            maxMultiplier: row.maxLeverage,
            up: row.canBuy,
            down: row.canSell,
          }));
      },
    },
    {
      name: "get_price",
      title: "Get price",
      description:
        "The live price of one market: the mid, and the prices an up bet buys at and a down bet sells at.",
      inputSchema: {
        type: "object",
        properties: { market: marketSchema },
        required: ["market"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        const row = await marketOf(venue, marketArg(args));
        return {
          market: row.market,
          price: dollars(row.mid),
          upPrice: dollars(row.ask),
          downPrice: dollars(row.bid),
          observedAtMs: row.observedAtMs,
        };
      },
    },
    {
      name: "quote_bet",
      title: "Quote a bet",
      description:
        "The price a bet would open at right now, without placing it. There is no trading fee; the price includes a small markup.",
      inputSchema: betSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        const bet = await checkedBet(venue, { maxStake: Infinity, maxMultiplier: Infinity }, args);
        const quote = (await venue.quote({
          market: bet.market,
          side: sideOf(bet.dir),
          amount: bet.size,
        })) as Wire;
        return { ...quoteView(quote, bet.dir), stake: bet.stake, multiplier: bet.multiplier };
      },
    },
  ];
}

/** Tools that read or move the signer's own account. */
export function accountTools(venue: Venue, limits: Limits = DEFAULT_LIMITS): Tool[] {
  return [
    {
      name: "get_account",
      title: "Get account",
      description: "Balance, equity, money free for new bets, and every open bet with its result so far.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run() {
        const account = (await venue.account()) as Wire & { positions: Record<string, PositionView> };
        return {
          balance: dollars(account.collateral),
          equity: dollars(account.equity),
          available: dollars(account.availableMargin),
          bets: betsOf(account.positions ?? {}),
        };
      },
    },
    {
      name: "open_bet",
      title: "Open a bet",
      description: `Bets on a market going up or down. It stays open until you close it (no expiry). The position is stake × multiplier; this server allows stakes up to $${limits.maxStake} and multipliers up to ${limits.maxMultiplier}×. Adding to a market you already hold adds to that bet; the opposite direction reduces it.`,
      inputSchema: betSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(args) {
        const bet = await checkedBet(venue, limits, args);
        const result = (await venue.trade({
          market: bet.market,
          side: sideOf(bet.dir),
          amount: bet.size,
        })) as Wire;
        return { ...fillView(result), direction: bet.dir, stake: bet.stake, multiplier: bet.multiplier };
      },
    },
    {
      name: "close_bet",
      title: "Close a bet",
      description: "Cashes out the bet on one market, all of it or a percentage.",
      inputSchema: {
        type: "object",
        properties: {
          market: marketSchema,
          percent: { type: "number", description: "How much to close, 1 to 100 (default 100)" },
        },
        required: ["market"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      async run(args) {
        const percent = args.percent === undefined ? 100 : positive(args, "percent");
        if (percent > 100) throw new Error("percent must be 100 or less");
        const fraction = Math.round(percent * 100);
        if (fraction < 1) throw new Error("percent is too small");
        return fillView((await venue.close({ market: marketArg(args), fraction })) as Wire);
      },
    },
    {
      name: "close_all",
      title: "Close all bets",
      description: "Cashes out every open bet.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      async run() {
        const results = (await venue.closeAll()) as Wire[];
        return results.map(fillView);
      },
    },
    {
      name: "protect_bet",
      title: "Protect a bet",
      description:
        "Sets a take-profit price, a stop-loss price or both on the open bet in a market. Whichever triggers first closes the bet and cancels the other.",
      inputSchema: {
        type: "object",
        properties: {
          market: marketSchema,
          takeProfit: { type: "number", description: "Price in dollars that cashes out in profit" },
          stopLoss: { type: "number", description: "Price in dollars that cuts the loss" },
        },
        required: ["market"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(args) {
        const market = marketArg(args),
          takeProfit = optionalPrice(args, "takeProfit"),
          stopLoss = optionalPrice(args, "stopLoss");
        if (takeProfit === undefined && stopLoss === undefined)
          throw new Error("give takeProfit, stopLoss or both");
        const placed = (await venue.tpsl({
          market,
          ...(takeProfit === undefined ? {} : { takeProfitPrice: toAmount(takeProfit) }),
          ...(stopLoss === undefined ? {} : { stopLossPrice: toAmount(stopLoss) }),
        })) as Wire[];
        return { market, takeProfit: takeProfit ?? null, stopLoss: stopLoss ?? null, orders: placed.length };
      },
    },
  ];
}
