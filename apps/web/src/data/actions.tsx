// Every user action (trade, order, trigger/TP-SL, close, funds, quick trading)
// as one async function: prepare with the API, sign, submit, toast the outcome
// and refresh.
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { encodeFunctionData, erc20Abi, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { holdQuote, localDeadline, type HeldQuote } from "../lib/clock.js";
import { API } from "../lib/env.js";
import { friendlyError } from "../lib/errors.js";
import { ApiError, errorMessage, postJson, randomNonce } from "../lib/http.js";
import { isolatedAccountOf, marginTopUp } from "../lib/isolated.js";
import {
  checkRoute,
  formatDuration,
  lifiGet,
  quoteUrl,
  sourceChain,
  type LifiQuote,
  type Route,
  type SourceToken,
} from "../lib/bridge.js";
import { MIN_GAS_FREE_DEPOSIT, plainAccount } from "../lib/funds.js";
import { abs, baseAmount, microToInput, parseUsdcInput, usdc, usdcCompact, usdPrice } from "../lib/format.js";
import {
  LIMIT_ORDER_DURATION_SECONDS,
  MIN_ORDER_DURATION_SECONDS,
  TRIGGER_ORDER_DURATION_SECONDS,
  tpslPrepareBody,
  triggerPrepareBody,
  type TpslInput,
  type TriggerOrderInput,
} from "../lib/orders.js";
import { clampSlippageBps } from "../lib/slippage.js";
import { quoteUsable } from "../lib/ticket.js";
import type {
  CancelResult,
  Market,
  Prepared,
  PreparedTpsl,
  PreparedTrigger,
  Quote,
  RestingOrder,
  Side,
  Transaction,
} from "../lib/types.js";
import {
  QUICK_DAYS,
  quickSessionRequest,
  sessionCovers,
  useQuickSession,
  type QuickLimits,
  type QuickSession,
} from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { verifyDeposit, type PreparedDeposit } from "../wallet/verify-deposit.js";
import {
  IntentMismatchError,
  quoteTerms,
  verifyTpslPair,
  type Expectation,
} from "../wallet/verify-intent.js";
import { useToasts } from "../ui/toasts.js";
import { useMarketList } from "./markets.js";
import { keys } from "./queries.js";

const clearingAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function collateralOf(address account) view returns (int256)",
  "function accountRegistered(address account) view returns (bool)",
  "struct Position { int256 size; uint256 entryPrice; int256 lastFundingIndex; }",
  "function positionOf(address account, uint8 market) view returns (Position)",
]);
type Settled = { transaction?: Transaction; status?: string };

/** `slippageBps` (1..500, default 8) sets the signed worst price beyond the expected price. */
export type MarketOrder = {
  market: Market;
  side: Side;
  amountMicro: bigint;
  reduceOnly: boolean;
  slippageBps?: number;
  /** The success toast's title, when the screen has its own words for the trade. */
  title?: string;
  /**
   * Home: hold the trade's margin, `payMicro`, in its own isolated account so the loss stops there. A new
   * isolated account needs at least MIN_ISOLATED_OPEN; a smaller first trade uses the main balance.
   */
  isolated?: { payMicro: bigint };
};
export type LimitOrder = MarketOrder & { limitPrice: string };
export type { TpslInput, TriggerOrderInput };
/** Outcome of closeAll: markets closed, and markets whose close failed (with why). */
export type CloseAllResult = { closed: Market[]; failed: Array<{ market: Market; error: string }> };

type Trading = {
  busy: string | null;
  quickSession: QuickSession | null;
  /** This browser holds a live one-tap key. Trading screens show Start trading until it does. */
  quickLive: boolean;
  /** Whether the quick-trading key can sign a market trade of this size without a wallet prompt. */
  quickCovers(market: Market, amountMicro: bigint | null): boolean;
  /**
   * A firm quote for the order, without placing it, held against this device's clock (lib/clock.ts). Calls are
   * spaced at least FIRM_QUOTE_SPACING_MS apart, so no refresh loop can flood POST /v1/quote. Throws the API's reason.
   */
  firmQuote(order: MarketOrder): Promise<HeldQuote<Quote>>;
  /** Places a market order at `quote` when given (it must still be valid), else at a fresh firm quote. Resolves true once filled or approved. */
  marketOrder(order: MarketOrder, quote?: Quote): Promise<boolean>;
  /** Places a 24-hour limit order. Resolves true once it is open. */
  limitOrder(order: LimitOrder): Promise<boolean>;
  /** Places a stop-loss, take-profit or stop-entry order; resolves to its orderId. Signed with the wallet. */
  triggerOrder(order: TriggerOrderInput): Promise<string | undefined>;
  /** Places a TP and/or SL for the whole position (two legs, one nonce, one wallet prompt per leg). Resolves to the placed orderIds. */
  placeTpsl(input: TpslInput): Promise<string[] | undefined>;
  /** Cancels an order by its nonce; for a TP/SL leg this cancels both legs. */
  cancelOrder(order: RestingOrder): Promise<void>;
  /**
   * Closes `fractionBps` of the position (1..10_000, default all) at a firm reduce-only quote; resolves to the fill
   * when it settles. With `isolated`, closes the isolated account's position and returns its margin to the balance.
   */
  closePosition(market: Market, fractionBps?: number, isolated?: boolean): Promise<ClosedAt | undefined>;
  /** Closes `fractionBps` of every open position, one quote each. Quick trading signs within its limits without prompts. */
  closeAll(fractionBps?: number): Promise<CloseAllResult | undefined>;
  /** Closes the whole position at the oracle price (while trading is paused). Resolves true once closed. */
  emergencyClose(market: Market): Promise<boolean>;
  /**
   * Moves everything held in `market`'s isolated account back to the balance: for a Home trade's margin left
   * there with no open position (a trade that failed after its amount was set aside). Resolves true once moved.
   */
  returnMargin(market: Market): Promise<boolean>;
  /** Deposits Base USDC from the wallet: gas-free (one signature) when the wallet can, else approve and deposit. */
  deposit(amountMicro: bigint): Promise<boolean>;
  /** Sends a LI.FI route from its source network; resolves to the source transaction once it is included. */
  bridge(route: Route, source: SourceToken): Promise<{ hash: Hex; route: Route } | undefined>;
  withdraw(amountMicro: bigint): Promise<boolean>;
  /** Grants a one-tap key with `limits` (see `useQuickLimits`). */
  enableQuickTrading(limits: QuickLimits): Promise<boolean>;
  /**
   * Readies one-tap for a market trade of `amountMicro`: true when the key already covers it, else (within
   * `limits`) grants a fresh key with one wallet signature first. False means the wallet signs this trade.
   */
  readyQuick(market: Market, amountMicro: bigint, limits: QuickLimits): Promise<boolean>;
  revokeQuickTrading(): Promise<void>;
};

/** The price and fee a close settled at (USDC 1e6). */
export type ClosedAt = { price: bigint; fee: bigint };

const TradingContext = createContext<Trading | null>(null);
const sideLabel = (side: Side) => (side === "buy" ? "Long" : "Short");
const TRIGGER_LABELS = {
  "stop-loss": "Stop-loss",
  "take-profit": "Take-profit",
  "stop-entry": "Stop",
} as const;
const triggerLabel = (kind: keyof typeof TRIGGER_LABELS) => TRIGGER_LABELS[kind];
/** "Closes $950.00 of BTC when price ≤ $95,000.00" for TP/SL, "Long $500.00 BTC when price ≥ …" for a stop entry. */
const triggerLine = ({ summary }: PreparedTrigger) =>
  `${summary.reduceOnly ? `Closes ${usdc((abs(BigInt(summary.baseDelta)) * BigInt(summary.triggerPrice)) / 10n ** 18n)} of ${summary.market}` : `${sideLabel(summary.side)} ${usdc(parseUsdcInput(summary.amount))} ${summary.market}`} when price ${summary.triggerAbove ? "≥" : "≤"} ${usdPrice(summary.triggerPrice)}`;
const fractionLabel = (fractionBps: number, market: Market) =>
  fractionBps < 10_000 ? `${fractionBps / 100}% of ${market} position` : `${market} position`;
/** The API refused the signed price because the market moved past it before settlement. */
const priceMoved = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && error.message.startsWith("price moved");

/** An error whose message is already written for the trader; the error toast shows it as is. */
class TraderFacingError extends Error {}

/** A session-signed resting order expires this long before its key. */
const SESSION_ORDER_MARGIN_SECONDS = 600;
/** Firm quote requests from screens are spaced at least this far apart. */
const FIRM_QUOTE_SPACING_MS = 1_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The approvers refused a one-tap signature: the session's limits don't cover this trade. */
const sessionRefused = (error: unknown) =>
  error instanceof ApiError && /user authorization rejected|invalid user signature/i.test(error.message);

export function TradingProvider({ children }: { children: ReactNode }) {
  const trader = useTrader(),
    config = useConfig(),
    client = useQueryClient(),
    { notify } = useToasts();
  const quick = useQuickSession(trader.address);
  // The newest session, also right after it is granted (before React re-renders), so a trade placed
  // in the same flow as turning one-click on already signs with it.
  const sessionRef = useRef(quick.session);
  if (quick.session || sessionRef.current?.account !== trader.address) sessionRef.current = quick.session;
  const marketList = useMarketList();
  const [busy, setBusy] = useState<string | null>(null);
  // Set synchronously, so a double tap (or a second action started in the same tick) sees it before React
  // re-renders: two signing flows must never overlap.
  const busyRef = useRef<string | null>(null);
  const lastFirmQuoteAt = useRef(0);
  const api = <T,>(path: string, body: unknown) => postJson<T>(`${API}${path}`, body);

  /** When account reads repeat after an action, for RPC nodes a block or two behind. */
  const REFRESH_AGAIN_MS = 4_000;
  /** Runs one action with a pending toast, then a success or error toast. */
  async function run<T>(
    label: string,
    pending: string,
    action: (
      progress: (detail: string) => void,
    ) => Promise<{ title: string; detail?: string; txHash?: string; value: T }>,
  ): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    const address = trader.address;
    if (!address) {
      notify({ kind: "error", title: "Connect a wallet first" });
      return undefined;
    }
    busyRef.current = label;
    setBusy(label);
    const id = notify({ kind: "pending", title: pending });
    try {
      const result = await action((detail) => notify({ kind: "pending", title: pending, detail }, id));
      notify({ kind: "success", title: result.title, detail: result.detail, txHash: result.txHash }, id);
      return result.value;
    } catch (error) {
      notify(
        {
          kind: "error",
          title: `${label} failed`,
          detail:
            error instanceof TraderFacingError
              ? error.message
              : friendlyError(errorMessage(error, "Unavailable")),
        },
        id,
      );
      return undefined;
    } finally {
      busyRef.current = null;
      setBusy(null);
      // Every account query (the connected account's and its isolated accounts') and the wallet's
      // balances on other networks; again a few seconds later, since a load-balanced RPC can answer
      // the first read from a node that has not seen the transaction yet.
      const refresh = () =>
        Promise.all(
          [["account"], ["source-balance"], ["lifi", "holdings"]].map((queryKey) =>
            client.invalidateQueries({ queryKey }),
          ),
        );
      void refresh();
      setTimeout(() => void refresh(), REFRESH_AGAIN_MS);
    }
  }

  const account = () => trader.address as Address;

  /** Whether the quick-trading key may sign a trade of `amountMicro` in `market` (limits and market mask). */
  const quickCovers = (market: Market, amountMicro: bigint | null) =>
    amountMicro !== null &&
    sessionCovers(sessionRef.current, amountMicro, marketList.get(market)?.index ?? Number.MAX_SAFE_INTEGER);
  const requestQuote = (order: MarketOrder) =>
    api<Quote>("/v1/quote", {
      market: order.market,
      side: order.side,
      amount: microToInput(order.amountMicro),
      ...(order.slippageBps === undefined ? {} : { slippageBps: clampSlippageBps(order.slippageBps) }),
    });
  const quoteAmount = (quote: Quote) => (quote.amount === undefined ? null : BigInt(quote.amount));
  /** The contract index of `market`, which every signed trade names. */
  const marketIndex = (market: Market) => {
    const index = marketList.get(market)?.index;
    if (index === undefined || index >= Number.MAX_SAFE_INTEGER)
      throw new Error(`${market} is not in the market list yet; try again`);
    return index;
  };

  /**
   * What the user asked for in a trade at a firm quote; checked against the quote and the prepared intent before
   * signing. `isolated` trades the connected account's isolated account in the market.
   */
  type TradeRequest = {
    market: Market;
    side?: Side;
    amountMicro?: bigint;
    slippageBps?: number;
    isolated?: boolean;
  };
  /** The account a trade is for: the connected account, or its isolated account in the market. */
  const tradeAccount = (market: Market, isolated?: boolean) =>
    isolated ? isolatedAccountOf(account(), marketIndex(market)) : account();
  /** The one-tap key, when it is live in this tab. */
  const liveSession = () => {
    const session = sessionRef.current;
    return session?.privateKey && session.validUntil > Date.now()
      ? (session as QuickSession & { privateKey: Hex })
      : null;
  };

  /**
   * How long a resting order may live when the one-tap key signs it: the contract only executes a session-signed
   * order whose deadline is within the key's validity, so it ends a little before the key does. Null when the key
   * is missing, does not cover the market, or has too little time left (the wallet signs then).
   */
  const sessionOrderSeconds = (market: Market) => {
    const session = liveSession();
    if (!session || !quickCovers(market, 0n)) return null;
    const seconds = Math.min(
      TRIGGER_ORDER_DURATION_SECONDS,
      Math.floor((session.validUntil - Date.now()) / 1000) - SESSION_ORDER_MARGIN_SECONDS,
    );
    return seconds >= MIN_ORDER_DURATION_SECONDS ? seconds : null;
  };

  /**
   * Places a prepared resting order. The one-tap key signs when `viaSession` and it covers the order's notional at
   * the trigger; if the API refuses that signature, or otherwise, the wallet signs (`prompt` is the wallet step).
   */
  async function placeResting(
    prepared: PreparedTrigger,
    expected: Expectation,
    viaSession: boolean,
    progress: (detail: string) => void,
    prompt: string,
  ) {
    const { summary } = prepared,
      notional = (abs(BigInt(summary.baseDelta)) * BigInt(summary.triggerPrice)) / 10n ** 18n,
      session = viaSession && quickCovers(summary.market, notional) ? liveSession() : null;
    const place = (userSignature: Hex) => api("/v1/orders", { orderId: prepared.orderId, userSignature });
    if (session) {
      try {
        return await place(
          await privateKeyToAccount(session.privateKey).signTypedData(
            trader.verified(prepared, "TriggeredTradeIntent", expected) as never,
          ),
        );
      } catch (error) {
        if (!(error instanceof ApiError && /invalid order signature/i.test(error.message))) throw error;
      }
    }
    progress(prompt);
    return place(await trader.signIntent(prepared, "TriggeredTradeIntent", expected));
  }

  async function settleTrade(
    quote: Quote,
    reduceOnly: boolean,
    progress: (detail: string) => void,
    sessionAllowed: boolean,
    request: TradeRequest,
  ) {
    if (quote.market !== request.market || (request.side && quote.side !== request.side))
      throw new IntentMismatchError("the quote is for another market or side");
    const nonce = randomNonce(),
      onAccount = tradeAccount(request.market, request.isolated);
    const expected = {
      kind: "trade" as const,
      isolated: request.isolated,
      market: marketIndex(request.market),
      side: request.side,
      reduceOnly,
      nonce,
      quote: quoteTerms(quote),
      amountMicro: request.amountMicro,
      slippageBps: request.slippageBps,
    };
    const prepared = await api<Prepared>("/v1/prepare", {
      quoteId: quote.quoteId,
      account: onAccount,
      nonce,
      reduceOnly,
    });
    const session = sessionAllowed ? liveSession() : null;
    const submit = (userSignature: Hex) =>
      api<Settled>("/v1/approve", { quoteId: quote.quoteId, account: onAccount, nonce, userSignature });
    if (session) {
      progress("Signing with one tap");
      try {
        return await submit(
          await privateKeyToAccount(session.privateKey).signTypedData(
            trader.verified(prepared, "TradeIntent", expected) as never,
          ),
        );
      } catch (error) {
        // Past the session's limits (its total, or a winning exit above the per-trade cap) the approvers
        // refuse the session's signature. Nothing was traded. An exit is then signed by the wallet: getting out
        // must never depend on the one-tap allowance. A new trade is not, since its price would expire while the
        // wallet asks: the key is dropped, so the screen offers Start trading again.
        if (!sessionRefused(error)) throw error;
        if (!reduceOnly) {
          quick.clear();
          sessionRef.current = null;
          throw new TraderFacingError(
            "One-tap trading needs turning on again in this browser. Nothing was traded. Tap Start trading, then try again.",
          );
        }
        if (!quoteUsable(localDeadline(quote), Date.now())) throw error;
      }
    }
    progress("Confirm in your wallet");
    const userSignature = await trader.signIntent(prepared, "TradeIntent", expected);
    progress("Placing your trade");
    return submit(userSignature);
  }

  /** Settles a reduce-only close. If the price moves past the signed limit first, re-quotes and signs once more: getting out should not fail on a tick. */
  async function settleClose(
    market: Market,
    fractionBps: number,
    quote: Quote,
    progress: (detail: string) => void,
    isolated?: boolean,
  ) {
    try {
      return {
        quote,
        result: await settleTrade(quote, true, progress, quickCovers(market, quoteAmount(quote)), {
          market,
          isolated,
        }),
      };
    } catch (error) {
      if (!priceMoved(error)) throw error;
      progress("Price moved, getting a new price");
      const fresh = await api<Quote>("/v1/close/quote", {
        account: tradeAccount(market, isolated),
        market,
        fraction: fractionBps,
      });
      return {
        quote: fresh,
        result: await settleTrade(fresh, true, progress, quickCovers(market, quoteAmount(fresh)), {
          market,
          isolated,
        }),
      };
    }
  }

  /**
   * The connected account's isolated account in `market`: its margin, and whether it exists on chain yet. Read
   * from the chain at its latest block, since a cash out moves exactly what is there right after the close.
   */
  const isolatedState = async (market: Market) => {
    const clearing = trader.settlement?.clearingAddress,
      reader = getPublicClient(config, { chainId: trader.chain.id });
    if (!clearing || !reader) throw new Error("Settlement contract is not configured");
    const address = tradeAccount(market, true);
    const [held, registered] = await Promise.all([
      reader.readContract({
        address: clearing,
        abi: clearingAbi,
        functionName: "collateralOf",
        args: [address],
      }),
      reader.readContract({
        address: clearing,
        abi: clearingAbi,
        functionName: "accountRegistered",
        args: [address],
      }),
    ]);
    return { held, registered };
  };
  /** Whether the isolated account in `market` holds a position (null when it cannot be read). */
  const isolatedOpen = async (market: Market): Promise<boolean | null> => {
    const clearing = trader.settlement?.clearingAddress,
      reader = getPublicClient(config, { chainId: trader.chain.id });
    if (!clearing || !reader) return null;
    return reader
      .readContract({
        address: clearing,
        abi: clearingAbi,
        functionName: "positionOf",
        args: [tradeAccount(market, true), marketIndex(market)],
      })
      .then(
        (position) => position.size !== 0n,
        () => null,
      );
  };

  /**
   * Moves `amountMicro` into (positive) or out of (negative) the isolated account for `market`. The one-tap key
   * signs when it is live and covers the market (the contract caps what it may add at its per-trade limit);
   * otherwise the wallet does.
   */
  async function moveMargin(market: Market, amountMicro: bigint, progress: (detail: string) => void) {
    const nonce = randomNonce(),
      index = marketIndex(market);
    const prepared = await api<Prepared>("/v1/isolated/margin/prepare", {
      account: account(),
      market,
      direction: amountMicro > 0n ? "add" : "remove",
      amount: microToInput(abs(amountMicro)),
      nonce,
    });
    const expected = { kind: "isolated-margin" as const, market: index, amountMicro, nonce };
    const session = liveSession();
    let userSignature: Hex;
    if (session && quickCovers(market, amountMicro > 0n ? amountMicro : 0n)) {
      userSignature = await privateKeyToAccount(session.privateKey).signTypedData(
        trader.verified(prepared, "IsolatedMarginIntent", expected) as never,
      );
    } else {
      progress(
        amountMicro > 0n
          ? "Confirm the trade's amount in your wallet"
          : "Confirm returning the money to your balance in your wallet",
      );
      userSignature = await trader.signIntent(prepared, "IsolatedMarginIntent", expected);
    }
    return api<Settled>("/v1/isolated/margin/execute", { intent: prepared.intent, userSignature });
  }

  const value: Trading = {
    busy,
    quickSession: quick.session,
    quickLive: sessionCovers(quick.session, 0n),
    quickCovers,
    firmQuote: async (order) => {
      const wait = lastFirmQuoteAt.current + FIRM_QUOTE_SPACING_MS - Date.now();
      if (wait > 0) await pause(wait);
      lastFirmQuoteAt.current = Date.now();
      const quote = await requestQuote(order);
      return holdQuote(quote);
    },

    marketOrder: async (order, reviewed) =>
      (await run(
        "Trade",
        order.reduceOnly ? `Reduce ${order.market}` : `${sideLabel(order.side)} ${order.market}`,
        async (progress) => {
          if (reviewed && !quoteUsable(localDeadline(reviewed), Date.now()))
            throw new Error("The quote expired. Review the new price");
          const slippageBps =
            order.slippageBps === undefined ? undefined : clampSlippageBps(order.slippageBps);
          // Set the trade's own margin aside first, so the trade itself opens on the isolated account. If the trade
          // then fails, the amount moved goes back (below); margin already there (an earlier attempt whose return
          // failed) is used, so nothing more moves.
          let isolated = false,
            setAside = 0n;
          if (order.isolated && !order.reduceOnly) {
            const { held, registered } = await isolatedState(order.market);
            const move = marginTopUp(order.isolated.payMicro, held, registered);
            if (move !== null) {
              if (move !== 0n) {
                progress("Setting the amount aside");
                await moveMargin(order.market, move, progress);
                if (move > 0n) setAside = move;
              }
              isolated = true;
            }
          }
          let quote: Quote, result: Settled;
          try {
            if (!reviewed) progress("Getting a price");
            quote = reviewed ?? (await requestQuote(order));
            result = await settleTrade(
              quote,
              order.reduceOnly,
              progress,
              quickCovers(order.market, order.amountMicro),
              {
                market: order.market,
                side: order.side,
                amountMicro: order.amountMicro,
                slippageBps,
                isolated,
              },
            );
          } catch (error) {
            if (setAside <= 0n) throw error;
            // The amount was set aside for a trade that did not happen: put it back, so it never sits where
            // the balance and withdraw cannot see it. Best effort; Home and Portfolio offer it back otherwise.
            const why = friendlyError(errorMessage(error, "Unavailable"));
            // A lost response or a timeout can hide a fill that landed: never return the margin of an open trade.
            const open = await isolatedOpen(order.market);
            if (open !== false)
              throw new TraderFacingError(
                open
                  ? `The app lost track of this trade, but it went through. Check Your trade on Home.`
                  : `${why} ${usdc(setAside)} may still be set aside for ${order.market}. Use Return to balance on Home or in Portfolio if it is.`,
              );
            progress("Returning the amount to your balance");
            const returned = await moveMargin(order.market, -setAside, progress).then(
              () => true,
              () => false,
            );
            throw new TraderFacingError(
              returned
                ? `${why} ${usdc(setAside)} went back to your balance.`
                : `${why} ${usdc(setAside)} is still set aside for ${order.market}. Use Return to balance on Home or in Portfolio to get it back.`,
            );
          }
          return {
            title: order.title
              ? order.title
              : order.reduceOnly
                ? `Reduced ${order.market} by ${usdc(order.amountMicro)}`
                : `${sideLabel(order.side)} ${order.market} ${usdc(order.amountMicro)} ${result.transaction ? "filled" : "approved"}`,
            detail: `at ${usdPrice(quote.expectedPrice)}`,
            txHash: result.transaction?.hash,
            value: true,
          };
        },
      )) ?? false,

    limitOrder: async (order) =>
      (await run("Limit order", `Place ${sideLabel(order.side).toLowerCase()} limit`, async (progress) => {
        const nonce = randomNonce();
        const expected = {
          kind: "limit" as const,
          market: marketIndex(order.market),
          side: order.side,
          reduceOnly: order.reduceOnly,
          nonce,
          amountMicro: order.amountMicro,
          limitPrice: parseUnits(order.limitPrice, 6),
        };
        // The one-tap key signs when it covers the order; the order then ends before the key does.
        const sessionSeconds = sessionOrderSeconds(order.market),
          session =
            sessionSeconds !== null && quickCovers(order.market, order.amountMicro) ? liveSession() : null;
        const prepared = await api<Prepared & { orderId: string }>("/v1/orders/prepare", {
          account: account(),
          market: order.market,
          side: order.side,
          amount: microToInput(order.amountMicro),
          limitPrice: order.limitPrice,
          durationSeconds: session
            ? Math.min(LIMIT_ORDER_DURATION_SECONDS, sessionSeconds!)
            : LIMIT_ORDER_DURATION_SECONDS,
          nonce,
          reduceOnly: order.reduceOnly,
        });
        const place = (userSignature: Hex) => api("/v1/orders", { orderId: prepared.orderId, userSignature });
        let placed = false;
        if (session)
          try {
            await place(
              await privateKeyToAccount(session.privateKey).signTypedData(
                trader.verified(prepared, "TradeIntent", expected) as never,
              ),
            );
            placed = true;
          } catch (error) {
            if (!(error instanceof ApiError && /invalid order signature/i.test(error.message))) throw error;
          }
        if (!placed) {
          progress("Confirm in your wallet");
          await place(await trader.signIntent(prepared, "TradeIntent", expected));
        }
        return {
          title: `${sideLabel(order.side)} limit open`,
          detail: `${usdc(order.amountMicro)} ${order.market} at ${usdPrice((prepared.intent as { limitPrice: string }).limitPrice)}, good for 24 hours`,
          value: true,
        };
      })) ?? false,

    // The one-tap key signs trigger orders when it can (they then expire before the key does); else the wallet.
    triggerOrder: (order) =>
      run("Trigger order", `Place ${triggerLabel(order.kind).toLowerCase()}`, async (progress) => {
        const sessionSeconds = sessionOrderSeconds(order.market);
        const body = triggerPrepareBody(
          sessionSeconds
            ? { ...order, durationSeconds: Math.min(sessionSeconds, order.durationSeconds ?? sessionSeconds) }
            : order,
          account(),
          randomNonce(),
        );
        const prepared = await api<PreparedTrigger>("/v1/orders/trigger/prepare", body);
        await placeResting(
          prepared,
          {
            kind: "trigger",
            market: marketIndex(order.market),
            triggerKind: order.kind,
            triggerPrice: order.triggerPriceMicro,
            slippageBps: body.slippageBps,
            nonce: body.nonce,
            reduceOnly: body.reduceOnly,
            side: body.side,
            amountMicro: order.sizing === "position" ? undefined : order.amountMicro,
          },
          sessionSeconds !== null,
          progress,
          "Confirm in your wallet",
        );
        return {
          title: `${triggerLabel(prepared.type)} set`,
          detail: triggerLine(prepared),
          value: prepared.orderId,
        };
      }),

    placeTpsl: (input) =>
      run("TP/SL", `Protect ${input.market}`, async (progress) => {
        const sessionSeconds = sessionOrderSeconds(input.market);
        const body = tpslPrepareBody(
            sessionSeconds
              ? {
                  ...input,
                  durationSeconds: Math.min(sessionSeconds, input.durationSeconds ?? sessionSeconds),
                }
              : input,
            account(),
            randomNonce(),
          ),
          market = marketIndex(input.market);
        const pair = await api<PreparedTpsl>("/v1/orders/tpsl/prepare", body);
        verifyTpslPair(pair.orders, { takeProfit: input.takeProfitMicro, stopLoss: input.stopLossMicro });
        for (const [index, leg] of pair.orders.entries())
          await placeResting(
            leg,
            {
              kind: "trigger",
              market,
              triggerKind: leg.type,
              triggerPrice: (leg.type === "take-profit" ? input.takeProfitMicro : input.stopLossMicro)!,
              slippageBps: body.slippageBps,
              nonce: body.nonce,
              reduceOnly: true,
            },
            sessionSeconds !== null,
            progress,
            pair.orders.length > 1
              ? `Confirm the ${triggerLabel(leg.type).toLowerCase()} in your wallet (${index + 1} of ${pair.orders.length})`
              : "Confirm in your wallet",
          );
        return {
          title: `${input.market} ${pair.orders.map((leg) => triggerLabel(leg.type).toLowerCase()).join(" and ")} set`,
          detail: pair.orders.map(triggerLine).join(" · "),
          value: pair.orders.map((leg) => leg.orderId),
        };
      }),

    cancelOrder: (order) =>
      run("Cancel", order.pairId ? "Cancel TP/SL" : "Cancel order", async (progress) => {
        const prepared = await api<Prepared & { orderIds?: string[] }>(
          `/v1/orders/${order.orderId}/cancel/prepare`,
          {},
        );
        const affected = prepared.orderIds?.length ?? 1;
        progress(
          affected > 1 ? `Confirm in your wallet (cancels ${affected} orders)` : "Confirm in your wallet",
        );
        const userSignature = await trader.signIntent(prepared, "CancelIntent", {
          kind: "cancel",
          nonce: order.nonce,
        });
        const result = await api<CancelResult>(`/v1/orders/${order.orderId}/cancel`, {
          intent: prepared.intent,
          userSignature,
        });
        const count = result.cancelledOrderIds?.length ?? 1;
        return {
          title: count > 1 ? `${count} orders cancelled` : "Order cancelled",
          txHash: result.transaction?.hash,
          value: undefined,
        };
      }),

    closePosition: (market, fractionBps = 10_000, isolated = false) =>
      run("Close", `Close ${fractionLabel(fractionBps, market)}`, async (progress) => {
        progress("Getting a price");
        const { quote, result } = await settleClose(
          market,
          fractionBps,
          await api<Quote>("/v1/close/quote", {
            account: tradeAccount(market, isolated),
            market,
            fraction: fractionBps,
          }),
          progress,
          isolated,
        );
        // The trade's margin goes back to the balance once it is fully closed. If that fails the money stays
        // set aside for the market, and the next trade there starts with it.
        let leftover = "";
        if (isolated && fractionBps === 10_000) {
          const { held } = await isolatedState(market);
          if (held > 0n) {
            progress("Returning the money to your balance");
            await moveMargin(market, -held, progress).catch(() => {
              leftover = `. ${usdc(held)} is still set aside for your next ${market} trade`;
            });
          }
        }
        return {
          title: `${fractionLabel(fractionBps, market)} closed`,
          detail: `at ${usdPrice(quote.expectedPrice)}${leftover}`,
          txHash: result.transaction?.hash,
          value: { price: BigInt(quote.expectedPrice), fee: BigInt(quote.fee) },
        };
      }),

    closeAll: (fractionBps = 10_000) =>
      run(
        "Close all",
        fractionBps < 10_000 ? `Close ${fractionBps / 100}% of every position` : "Close all positions",
        async (progress) => {
          progress("Getting prices");
          const { quotes } = await api<{ quotes: Quote[] }>("/v1/close/all/quote", {
            account: account(),
            fraction: fractionBps,
          });
          const outcome: CloseAllResult = { closed: [], failed: [] };
          if (!quotes.length) return { title: "No open positions", value: outcome };
          let lastTx: Transaction | undefined;
          for (const [index, first] of quotes.entries()) {
            const market = first.market!;
            try {
              // Quotes live seconds; wallet prompts for earlier positions can outlast later quotes.
              const quote = quoteUsable(localDeadline(first), Date.now())
                ? first
                : await api<Quote>("/v1/close/quote", { account: account(), market, fraction: fractionBps });
              const step = (detail: string) =>
                progress(`${market} (${index + 1} of ${quotes.length}): ${detail}`);
              const { result } = await settleClose(market, fractionBps, quote, step);
              lastTx = result.transaction ?? lastTx;
              outcome.closed.push(market);
            } catch (error) {
              outcome.failed.push({ market, error: friendlyError(errorMessage(error, "Unavailable")) });
            }
          }
          if (!outcome.closed.length)
            throw new Error(outcome.failed.map((item) => `${item.market}: ${item.error}`).join("; "));
          return {
            title: outcome.failed.length
              ? `Closed ${outcome.closed.join(", ")}; ${outcome.failed.map((item) => item.market).join(", ")} still open`
              : `Closed ${outcome.closed.join(", ")}`,
            detail: outcome.failed.map((item) => `${item.market}: ${item.error}`).join(" · ") || undefined,
            txHash: lastTx?.hash,
            value: outcome,
          };
        },
      ),

    emergencyClose: async (market) =>
      (await run("Emergency close", `Close ${market} at oracle`, async (progress) => {
        const nonce = randomNonce(),
          index = marketIndex(market);
        const prepared = await api<Prepared>("/v1/close/prepare", { account: account(), market, nonce });
        progress("Confirm in your wallet");
        const userSignature = await trader.signIntent(prepared, "CloseIntent", {
          kind: "close",
          market: index,
          nonce,
        });
        progress("Closing");
        const result = await api<Settled>("/v1/close/execute", { intent: prepared.intent, userSignature });
        return {
          title: `${market} position closed`,
          txHash: result.transaction?.hash,
          value: true,
        };
      })) ?? false,

    returnMargin: async (market) =>
      (await run("Return to balance", `Return ${market} money to your balance`, async (progress) => {
        const { held } = await isolatedState(market);
        if (held <= 0n) return { title: "Nothing to return", value: true };
        await moveMargin(market, -held, progress);
        return { title: `${usdc(held)} is back in your balance`, value: true };
      })) ?? false,

    deposit: async (amount) =>
      (await run("Deposit", `Deposit ${usdc(amount)}`, async (progress) => {
        const token = trader.settlement?.tokenAddress,
          clearing = trader.settlement?.clearingAddress;
        if (!token || !clearing) throw new Error("Settlement contract is not configured");
        const reader = getPublicClient(config, { chainId: trader.chain.id });
        if (!reader) throw new Error("No RPC for the settlement chain");
        // Gas-free first: sign USDC's receive authorization and the API pays the gas. Smart wallets
        // cannot produce the plain signature USDC's authorization takes, so they deposit directly.
        if (amount >= MIN_GAS_FREE_DEPOSIT && plainAccount(await reader.getCode({ address: account() }))) {
          const prepared = await api<PreparedDeposit>("/v1/deposit/prepare", {
            account: account(),
            amount: microToInput(amount),
          }).catch((error: unknown) => {
            // An API without gas-free deposits (or with its chain down) leaves the direct path.
            if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
            throw error;
          });
          if (prepared) {
            const payload = verifyDeposit(prepared, {
              account: account(),
              chainId: trader.chain.id,
              token,
              clearing,
              amount,
            });
            progress("Sign the deposit in your wallet. No gas needed");
            const userSignature = await trader.signTyped(payload);
            progress("Depositing");
            const result = await api<Settled>("/v1/deposit/execute", {
              authorization: prepared.authorization,
              userSignature,
            });
            return {
              title: `Deposited ${usdc(amount)}`,
              txHash: result.transaction?.hash,
              value: true,
            };
          }
        }
        const allowance = await reader.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account(), clearing],
        });
        if (allowance < amount) {
          progress("Approve USDC in your wallet");
          await trader.send({
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [clearing, amount] }),
          });
        }
        progress("Confirm the deposit in your wallet");
        const receipt = await trader.send({
          to: clearing,
          data: encodeFunctionData({ abi: clearingAbi, functionName: "deposit", args: [amount] }),
        });
        return {
          title: `Deposited ${usdc(amount)}`,
          txHash: receipt.hash,
          value: true,
        };
      })) ?? false,

    bridge: (route, source) =>
      run(
        "Deposit",
        `Deposit ${source.symbol} from ${sourceChain(route.request.fromChain)?.name ?? "another network"}`,
        async (progress) => {
          const network = sourceChain(route.request.fromChain)?.name ?? "the source network";
          // Quotes age quickly: fetch a fresh one, check it the same way, and stop if it now delivers less.
          progress("Refreshing the route");
          const fresh = checkRoute(
            await lifiGet<LifiQuote>(quoteUrl(route.request)),
            route.request,
            source.decimals,
          );
          if (fresh.toAmountMin * 100n < route.toAmountMin * 99n)
            throw new Error("The rate moved. Review the new quote and try again");
          if (fresh.approval) {
            const reader = getPublicClient(config, { chainId: route.request.fromChain });
            if (!reader) throw new Error(`No RPC for ${network}`);
            const allowance = await reader.readContract({
              address: route.request.fromToken,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account(), fresh.approval],
            });
            if (allowance < route.request.fromAmount) {
              // USDT on Ethereum refuses to change a nonzero allowance without resetting it first.
              if (allowance > 0n) {
                progress(`Reset the ${source.symbol} approval in your wallet`);
                await trader.sendOn(
                  route.request.fromChain,
                  {
                    to: route.request.fromToken,
                    data: encodeFunctionData({
                      abi: erc20Abi,
                      functionName: "approve",
                      args: [fresh.approval, 0n],
                    }),
                  },
                  { stay: true },
                );
              }
              progress(`Approve ${source.symbol} on ${network} in your wallet`);
              await trader.sendOn(
                route.request.fromChain,
                {
                  to: route.request.fromToken,
                  data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [fresh.approval, route.request.fromAmount],
                  }),
                },
                { stay: true },
              );
            }
          }
          progress(`Confirm the transfer on ${network} in your wallet`);
          const sent = await trader.sendOn(route.request.fromChain, fresh.transaction);
          return {
            title: `Sent from ${network}`,
            detail: `About ${usdc(fresh.toAmount)} arrives on Base in ${formatDuration(fresh.durationSeconds).replace("about ", "")}`,
            value: { hash: sent.hash, route: fresh },
          };
        },
      ),

    withdraw: async (amount) =>
      (await run("Withdrawal", `Withdraw ${usdc(amount)}`, async (progress) => {
        const nonce = randomNonce();
        const prepared = await api<Prepared>("/v1/withdraw/prepare", {
          account: account(),
          amount: microToInput(amount),
          nonce,
        });
        progress("Confirm in your wallet");
        // The recipient must be the signing wallet and the amount the one requested.
        const userSignature = await trader.signIntent(prepared, "WithdrawalIntent", {
          kind: "withdraw",
          amountMicro: amount,
          nonce,
        });
        progress("Sending");
        const result = await api<Settled>("/v1/withdraw/execute", { intent: prepared.intent, userSignature });
        return {
          title: `Withdrew ${usdc(amount)}`,
          txHash: result.transaction?.hash,
          value: true,
        };
      })) ?? false,

    enableQuickTrading: async (limits) =>
      (await run("One-tap trading", "Turn on one-tap trading", async (progress) => {
        const privateKey = generatePrivateKey(),
          sessionAddress = privateKeyToAccount(privateKey).address;
        // Covers every registered market; one added later needs a new session (sessionCovers checks the mask).
        const request = quickSessionRequest(Math.max(1, marketList.markets.length), limits),
          nonce = randomNonce();
        const prepared = await api<Omit<Prepared, "intent"> & { grant: Record<string, unknown> }>(
          "/v1/session/prepare",
          {
            account: account(),
            session: sessionAddress,
            ...request,
            nonce,
          },
        );
        progress("Confirm one tap in your wallet");
        // Only the key generated above, with exactly the quick-trading limits, may be authorized.
        const userSignature = await trader.signIntent(
          { ...prepared, intent: prepared.grant },
          "SessionGrant",
          {
            kind: "session",
            session: sessionAddress,
            marketMask: BigInt(request.marketMask),
            nonce,
            maxTradeNotional: limits.maxTradeMicro,
            maxCumulativeNotional: limits.maxCumulativeMicro,
            maxFee: parseUnits(request.maxFee, 6),
            durationSeconds: request.durationSeconds,
          },
        );
        progress("Turning on one tap");
        const result = await api<{ validUntil: string; transaction?: Transaction }>("/v1/session/execute", {
          grant: prepared.grant,
          userSignature,
        });
        const granted = {
          account: account(),
          sessionAddress,
          privateKey,
          validUntil: Number(result.validUntil) * 1_000,
          marketMask: String(request.marketMask),
          maxTradeNotional: limits.maxTradeMicro.toString(),
        };
        quick.save(granted);
        sessionRef.current = granted;
        return {
          title: "One-tap trading on",
          detail: `Trades up to ${usdcCompact(limits.maxTradeMicro)} fill without a wallet prompt in this browser for ${QUICK_DAYS} days`,
          txHash: result.transaction?.hash,
          value: true,
        };
      })) ?? false,

    readyQuick: async (market, amountMicro, limits) =>
      quickCovers(market, amountMicro) ||
      (amountMicro <= limits.maxTradeMicro &&
        (await value.enableQuickTrading(limits)) &&
        quickCovers(market, amountMicro)),

    revokeQuickTrading: () =>
      run("Revoke", "Turn off one-tap trading", async (progress) => {
        const session = quick.session;
        if (!session) throw new Error("No active session");
        const nonce = randomNonce();
        // Gas-free: the wallet signs the revocation and the API relays it.
        const prepared = await api<Prepared>("/v1/session/revoke/prepare", {
          account: account(),
          session: session.sessionAddress,
          nonce,
        });
        progress("Confirm the revocation in your wallet");
        const userSignature = await trader.signIntent(prepared, "SessionRevoke", {
          kind: "session-revoke",
          session: session.sessionAddress,
          nonce,
        });
        progress("Turning off one tap");
        const result = await api<Settled>("/v1/session/revoke/execute", {
          intent: prepared.intent,
          userSignature,
        });
        quick.clear();
        sessionRef.current = null;
        return {
          title: "One-tap trading off",
          detail: result.transaction ? `Block ${result.transaction.blockNumber}` : undefined,
          txHash: result.transaction?.hash,
          value: undefined,
        };
      }),
  };

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}

export function useTrading() {
  const value = useContext(TradingContext);
  if (!value) throw new Error("useTrading outside TradingProvider");
  return value;
}
