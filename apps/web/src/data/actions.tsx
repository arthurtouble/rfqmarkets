// Every user action (trade, order, trigger/TP-SL, close, funds, quick trading)
// as one async function: prepare with the API, sign, submit, toast the outcome
// and refresh.
import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { encodeFunctionData, erc20Abi, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API } from "../lib/env.js";
import { ApiError, errorMessage, postJson, randomNonce } from "../lib/http.js";
import { microToInput, shortHash, usdc } from "../lib/format.js";
import { LIMIT_ORDER_DURATION_SECONDS, tpslPrepareBody, triggerPrepareBody, type TpslInput, type TriggerOrderInput } from "../lib/orders.js";
import { clampSlippageBps } from "../lib/slippage.js";
import type { CancelResult, Market, Prepared, PreparedTpsl, PreparedTrigger, Quote, RestingOrder, Side, Transaction } from "../lib/types.js";
import { QUICK_LIMITS, quickSessionRequest, sessionCovers, useQuickSession, type QuickSession } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { IntentMismatchError, quoteTerms, verifyTpslPair } from "../wallet/verify-intent.js";
import { useToasts } from "../ui/toasts.js";
import { useMarketList } from "./markets.js";
import { keys } from "./queries.js";

const clearingAbi = parseAbi(["function deposit(uint256 amount)", "function revokeSession(address session)"]);
type Settled = { transaction?: Transaction; status?: string };

/** `slippageBps` (1..500, default 8) sets the signed worst price beyond the expected price. */
export type MarketOrder = { market: Market; side: Side; amountMicro: bigint; reduceOnly: boolean; slippageBps?: number };
export type LimitOrder = MarketOrder & { limitPrice: string };
export type { TpslInput, TriggerOrderInput };
/** Outcome of closeAll: markets closed, and markets whose close failed (with why). */
export type CloseAllResult = { closed: Market[]; failed: Array<{ market: Market; error: string }> };

type Trading = {
  busy: string | null;
  quickSession: QuickSession | null;
  marketOrder(order: MarketOrder): Promise<void>;
  limitOrder(order: LimitOrder): Promise<void>;
  /** Places a stop-loss, take-profit or stop-entry order; resolves to its orderId. Signed with the wallet. */
  triggerOrder(order: TriggerOrderInput): Promise<string | undefined>;
  /** Places a TP and/or SL for the whole position (two legs, one nonce, one wallet prompt per leg). Resolves to the placed orderIds. */
  placeTpsl(input: TpslInput): Promise<string[] | undefined>;
  /** Cancels an order by its nonce; for a TP/SL leg this cancels both legs. */
  cancelOrder(order: RestingOrder): Promise<void>;
  /** Closes `fractionBps` of the position (1..10_000, default all) at a firm reduce-only quote. */
  closePosition(market: Market, fractionBps?: number): Promise<void>;
  /** Closes `fractionBps` of every open position, one quote each. Quick trading signs within its limits without prompts. */
  closeAll(fractionBps?: number): Promise<CloseAllResult | undefined>;
  emergencyClose(market: Market): Promise<void>;
  deposit(amountMicro: bigint): Promise<boolean>;
  withdraw(amountMicro: bigint): Promise<boolean>;
  enableQuickTrading(): Promise<void>;
  revokeQuickTrading(): Promise<void>;
};

const TradingContext = createContext<Trading | null>(null);
const sideLabel = (side: Side) => (side === "buy" ? "Long" : "Short");
const blockLine = (tx?: Transaction) => (tx ? `Block ${tx.blockNumber} · ${shortHash(tx.hash)}` : undefined);
const TRIGGER_LABELS = { "stop-loss": "Stop-loss", "take-profit": "Take-profit", "stop-entry": "Stop entry" } as const;
const triggerLabel = (kind: keyof typeof TRIGGER_LABELS) => TRIGGER_LABELS[kind];
const triggerLine = ({ summary }: PreparedTrigger) =>
  `${sideLabel(summary.side)} ${summary.amount} USDC ${summary.market} when price ${summary.triggerAbove ? "≥" : "≤"} ${usdc(summary.triggerPrice)}`;
const fractionLabel = (fractionBps: number, market: Market) => (fractionBps < 10_000 ? `${fractionBps / 100}% of ${market} position` : `${market} position`);
/** Re-quote a close-all leg when less than this remains on its quote. */
const QUOTE_EXPIRY_MARGIN_MS = 1_500;
/** The API refused the signed price because the market moved past it before settlement. */
const priceMoved = (error: unknown) => error instanceof ApiError && error.status === 409 && error.message.startsWith("price moved");

export function TradingProvider({ children }: { children: ReactNode }) {
  const trader = useTrader(), config = useConfig(), client = useQueryClient(), { notify } = useToasts();
  const quick = useQuickSession(trader.address);
  const marketList = useMarketList();
  const [busy, setBusy] = useState<string | null>(null);
  const api = <T,>(path: string, body: unknown) => postJson<T>(`${API}${path}`, body);

  /** Runs one action with a pending toast, then a success or error toast. */
  async function run<T>(label: string, pending: string, action: (progress: (detail: string) => void) => Promise<{ title: string; detail?: string; txHash?: string; value: T }>): Promise<T | undefined> {
    if (busy) return undefined;
    const address = trader.address;
    if (!address) { notify({ kind: "error", title: "Connect a wallet first" }); return undefined; }
    setBusy(label);
    const id = notify({ kind: "pending", title: pending });
    try {
      const result = await action(detail => notify({ kind: "pending", title: pending, detail }, id));
      notify({ kind: "success", title: result.title, detail: result.detail, txHash: result.txHash }, id);
      return result.value;
    } catch (error) {
      notify({ kind: "error", title: `${label} failed`, detail: errorMessage(error, "Unavailable") }, id);
      return undefined;
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.account(address) });
    }
  }

  const account = () => trader.address as Address;

  /** Whether the quick-trading key may sign a trade of `amountMicro` in `market` (limits and market mask). */
  const quickCovers = (market: Market, amountMicro: bigint | null) =>
    amountMicro !== null && sessionCovers(quick.session, amountMicro, marketList.get(market)?.index ?? Number.MAX_SAFE_INTEGER);
  const quoteAmount = (quote: Quote) => (quote.amount === undefined ? null : BigInt(quote.amount));
  /** The contract index of `market`, which every signed trade names. */
  const marketIndex = (market: Market) => {
    const index = marketList.get(market)?.index;
    if (index === undefined || index >= Number.MAX_SAFE_INTEGER) throw new Error(`${market} is not in the market list yet; try again`);
    return index;
  };

  /** What the user asked for in a trade at a firm quote; checked against the quote and the prepared intent before signing. */
  type TradeRequest = { market: Market; side?: Side; amountMicro?: bigint; slippageBps?: number };

  async function settleTrade(quote: Quote, reduceOnly: boolean, progress: (detail: string) => void, sessionAllowed: boolean, request: TradeRequest) {
    if (quote.market !== request.market || (request.side && quote.side !== request.side))
      throw new IntentMismatchError("the quote is for another market or side");
    const nonce = randomNonce();
    const expected = {
      kind: "trade" as const, market: marketIndex(request.market), side: request.side, reduceOnly, nonce,
      quote: quoteTerms(quote), amountMicro: request.amountMicro, slippageBps: request.slippageBps,
    };
    const prepared = await api<Prepared>("/v1/prepare", { quoteId: quote.quoteId, account: account(), nonce, reduceOnly });
    const session = sessionAllowed && quick.session?.privateKey ? quick.session as QuickSession & { privateKey: Hex } : null;
    progress(session ? "Signing with one-click trading" : "Confirm in your wallet");
    const userSignature: Hex = session
      ? await privateKeyToAccount(session.privateKey).signTypedData(trader.verified(prepared, "TradeIntent", expected) as never)
      : await trader.signIntent(prepared, "TradeIntent", expected);
    progress("Collecting approver signatures");
    return api<Settled>("/v1/approve", { quoteId: quote.quoteId, account: account(), nonce, userSignature });
  }

  /** Settles a reduce-only close. If the price moves past the signed limit first, re-quotes and signs once more: getting out should not fail on a tick. */
  async function settleClose(market: Market, fractionBps: number, quote: Quote, progress: (detail: string) => void) {
    try {
      return { quote, result: await settleTrade(quote, true, progress, quickCovers(market, quoteAmount(quote)), { market }) };
    } catch (error) {
      if (!priceMoved(error)) throw error;
      progress("Price moved, getting a new quote");
      const fresh = await api<Quote>("/v1/close/quote", { account: account(), market, fraction: fractionBps });
      return { quote: fresh, result: await settleTrade(fresh, true, progress, quickCovers(market, quoteAmount(fresh)), { market }) };
    }
  }

  const value: Trading = {
    busy,
    quickSession: quick.session,

    marketOrder: order => run("Trade", order.reduceOnly ? `Reduce ${order.market}` : `${sideLabel(order.side)} ${order.market}`, async progress => {
      progress("Getting a firm quote");
      const slippageBps = order.slippageBps === undefined ? undefined : clampSlippageBps(order.slippageBps);
      const quote = await api<Quote>("/v1/quote", {
        market: order.market, side: order.side, amount: microToInput(order.amountMicro),
        ...(slippageBps === undefined ? {} : { slippageBps }),
      });
      const result = await settleTrade(quote, order.reduceOnly, progress, quickCovers(order.market, order.amountMicro),
        { market: order.market, side: order.side, amountMicro: order.amountMicro, slippageBps });
      return {
        title: order.reduceOnly
          ? `Reduced ${order.market} by ${usdc(order.amountMicro)}`
          : `${sideLabel(order.side)} ${order.market} ${usdc(order.amountMicro)} ${result.transaction ? "filled" : "approved"}`,
        detail: [`at ${usdc(quote.expectedPrice)}`, blockLine(result.transaction)].filter(Boolean).join(" · "),
        txHash: result.transaction?.hash, value: undefined,
      };
    }),

    limitOrder: order => run("Limit order", `Place ${order.side} limit`, async progress => {
      const nonce = randomNonce();
      const expected = {
        kind: "limit" as const, market: marketIndex(order.market), side: order.side, reduceOnly: order.reduceOnly, nonce,
        amountMicro: order.amountMicro, limitPrice: parseUnits(order.limitPrice, 6),
      };
      const prepared = await api<Prepared & { orderId: string }>("/v1/orders/prepare", {
        account: account(), market: order.market, side: order.side, amount: microToInput(order.amountMicro),
        limitPrice: order.limitPrice, durationSeconds: LIMIT_ORDER_DURATION_SECONDS, nonce, reduceOnly: order.reduceOnly,
      });
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "TradeIntent", expected);
      await api("/v1/orders", { orderId: prepared.orderId, userSignature });
      return { title: `${sideLabel(order.side)} limit open`, detail: `${usdc(order.amountMicro)} ${order.market} at ${usdc((prepared.intent as { limitPrice: string }).limitPrice)}, good for 24 hours`, value: undefined };
    }),

    // POST /v1/orders verifies the owner's signature (EOA or ERC-1271) only, so resting trigger
    // orders are always signed with the wallet, never the quick-trading key.
    triggerOrder: order => run("Trigger order", `Place ${triggerLabel(order.kind).toLowerCase()}`, async progress => {
      const body = triggerPrepareBody(order, account(), randomNonce());
      const prepared = await api<PreparedTrigger>("/v1/orders/trigger/prepare", body);
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "TriggeredTradeIntent", {
        kind: "trigger", market: marketIndex(order.market), triggerKind: order.kind, triggerPrice: order.triggerPriceMicro,
        slippageBps: body.slippageBps, nonce: body.nonce, reduceOnly: body.reduceOnly, side: body.side,
        amountMicro: order.sizing === "position" ? undefined : order.amountMicro,
      });
      await api("/v1/orders", { orderId: prepared.orderId, userSignature });
      return { title: `${triggerLabel(prepared.type)} set`, detail: triggerLine(prepared), value: prepared.orderId };
    }),

    placeTpsl: input => run("TP/SL", `Protect ${input.market}`, async progress => {
      const body = tpslPrepareBody(input, account(), randomNonce()), market = marketIndex(input.market);
      const pair = await api<PreparedTpsl>("/v1/orders/tpsl/prepare", body);
      verifyTpslPair(pair.orders, { takeProfit: input.takeProfitMicro, stopLoss: input.stopLossMicro });
      // Sign every leg before placing any, so a rejected prompt leaves nothing half-placed.
      const signatures: Hex[] = [];
      for (const [index, leg] of pair.orders.entries()) {
        progress(pair.orders.length > 1 ? `Confirm the ${triggerLabel(leg.type).toLowerCase()} in your wallet (${index + 1} of ${pair.orders.length})` : "Confirm in your wallet");
        signatures.push(await trader.signIntent(leg, "TriggeredTradeIntent", {
          kind: "trigger", market, triggerKind: leg.type, triggerPrice: (leg.type === "take-profit" ? input.takeProfitMicro : input.stopLossMicro)!,
          slippageBps: body.slippageBps, nonce: body.nonce, reduceOnly: true,
        }));
      }
      progress("Placing orders");
      for (const [index, leg] of pair.orders.entries()) await api("/v1/orders", { orderId: leg.orderId, userSignature: signatures[index] });
      return { title: `${input.market} ${pair.orders.map(leg => triggerLabel(leg.type).toLowerCase()).join(" and ")} set`, detail: pair.orders.map(triggerLine).join(" · "), value: pair.orders.map(leg => leg.orderId) };
    }),

    cancelOrder: order => run("Cancel", order.pairId ? "Cancel TP/SL" : "Cancel order", async progress => {
      const prepared = await api<Prepared & { orderIds?: string[] }>(`/v1/orders/${order.orderId}/cancel/prepare`, {});
      const affected = prepared.orderIds?.length ?? 1;
      progress(affected > 1 ? `Confirm in your wallet (cancels ${affected} orders)` : "Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "CancelIntent", { kind: "cancel", nonce: order.nonce });
      const result = await api<CancelResult>(`/v1/orders/${order.orderId}/cancel`, { intent: prepared.intent, userSignature });
      const count = result.cancelledOrderIds?.length ?? 1;
      return { title: count > 1 ? `${count} orders cancelled` : "Order cancelled", detail: blockLine(result.transaction), txHash: result.transaction?.hash, value: undefined };
    }),

    closePosition: (market, fractionBps = 10_000) => run("Close", `Close ${fractionLabel(fractionBps, market)}`, async progress => {
      progress("Getting an exact close quote");
      const { quote, result } = await settleClose(market, fractionBps, await api<Quote>("/v1/close/quote", { account: account(), market, fraction: fractionBps }), progress);
      return { title: `${fractionLabel(fractionBps, market)} closed`, detail: [`at ${usdc(quote.expectedPrice)}`, blockLine(result.transaction)].filter(Boolean).join(" · "), txHash: result.transaction?.hash, value: undefined };
    }),

    closeAll: (fractionBps = 10_000) => run("Close all", fractionBps < 10_000 ? `Close ${fractionBps / 100}% of every position` : "Close all positions", async progress => {
      progress("Getting close quotes");
      const { quotes } = await api<{ quotes: Quote[] }>("/v1/close/all/quote", { account: account(), fraction: fractionBps });
      const outcome: CloseAllResult = { closed: [], failed: [] };
      if (!quotes.length) return { title: "No open positions", value: outcome };
      let lastTx: Transaction | undefined;
      for (const [index, first] of quotes.entries()) {
        const market = first.market!;
        try {
          // Quotes live seconds; wallet prompts for earlier positions can outlast later quotes.
          const quote = Date.now() < first.expiresAtMs - QUOTE_EXPIRY_MARGIN_MS ? first
            : await api<Quote>("/v1/close/quote", { account: account(), market, fraction: fractionBps });
          const step = (detail: string) => progress(`${market} (${index + 1} of ${quotes.length}): ${detail}`);
          const { result } = await settleClose(market, fractionBps, quote, step);
          lastTx = result.transaction ?? lastTx;
          outcome.closed.push(market);
        } catch (error) {
          outcome.failed.push({ market, error: errorMessage(error, "Unavailable") });
        }
      }
      if (!outcome.closed.length) throw new Error(outcome.failed.map(item => `${item.market}: ${item.error}`).join("; "));
      return {
        title: outcome.failed.length ? `Closed ${outcome.closed.join(", ")}; ${outcome.failed.map(item => item.market).join(", ")} still open` : `Closed ${outcome.closed.join(", ")}`,
        detail: outcome.failed.map(item => `${item.market}: ${item.error}`).join(" · ") || blockLine(lastTx), txHash: lastTx?.hash, value: outcome,
      };
    }),

    emergencyClose: market => run("Emergency close", `Close ${market} at oracle`, async progress => {
      const nonce = randomNonce(), index = marketIndex(market);
      const prepared = await api<Prepared>("/v1/close/prepare", { account: account(), market, nonce });
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "CloseIntent", { kind: "close", market: index, nonce });
      progress("Submitting conservative close");
      const result = await api<Settled>("/v1/close/execute", { intent: prepared.intent, userSignature });
      return { title: `${market} position closed`, detail: blockLine(result.transaction), txHash: result.transaction?.hash, value: undefined };
    }),

    deposit: async amount => (await run("Deposit", `Deposit ${usdc(amount)}`, async progress => {
      const token = trader.settlement?.tokenAddress, clearing = trader.settlement?.clearingAddress;
      if (!token || !clearing) throw new Error("Settlement contract is not configured");
      const reader = getPublicClient(config, { chainId: trader.chain.id });
      if (!reader) throw new Error("No RPC for the settlement chain");
      const allowance = await reader.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account(), clearing] });
      if (allowance < amount) {
        progress("Approve USDC in your wallet");
        await trader.send({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [clearing, amount] }) });
      }
      progress("Confirm the deposit in your wallet");
      const receipt = await trader.send({ to: clearing, data: encodeFunctionData({ abi: clearingAbi, functionName: "deposit", args: [amount] }) });
      return { title: `Deposited ${usdc(amount)}`, detail: `Block ${receipt.blockNumber} · ${shortHash(receipt.hash)}`, txHash: receipt.hash, value: true };
    })) ?? false,

    withdraw: async amount => (await run("Withdrawal", `Withdraw ${usdc(amount)}`, async progress => {
      const nonce = randomNonce();
      const prepared = await api<Prepared>("/v1/withdraw/prepare", { account: account(), amount: microToInput(amount), nonce });
      progress("Confirm in your wallet");
      // The recipient must be the signing wallet and the amount the one requested.
      const userSignature = await trader.signIntent(prepared, "WithdrawalIntent", { kind: "withdraw", amountMicro: amount, nonce });
      progress("Submitting sponsored withdrawal");
      const result = await api<Settled>("/v1/withdraw/execute", { intent: prepared.intent, userSignature });
      return { title: `Withdrew ${usdc(amount)}`, detail: blockLine(result.transaction), txHash: result.transaction?.hash, value: true };
    })) ?? false,

    enableQuickTrading: () => run("One-click trading", "Turn on one-click trading", async progress => {
      const privateKey = generatePrivateKey(), sessionAddress = privateKeyToAccount(privateKey).address;
      // Covers every registered market; one added later needs a new session (sessionCovers checks the mask).
      const request = quickSessionRequest(Math.max(1, marketList.markets.length)), nonce = randomNonce();
      const prepared = await api<Omit<Prepared, "intent"> & { grant: Record<string, unknown> }>("/v1/session/prepare", {
        account: account(), session: sessionAddress, ...request, nonce,
      });
      progress("Confirm the session in your wallet");
      // Only the key generated above, with exactly the quick-trading limits, may be authorized.
      const userSignature = await trader.signIntent({ ...prepared, intent: prepared.grant }, "SessionGrant", {
        kind: "session", session: sessionAddress, marketMask: BigInt(request.marketMask), nonce,
        maxTradeNotional: parseUnits(QUICK_LIMITS.maxTradeAmount, 6), maxCumulativeNotional: parseUnits(QUICK_LIMITS.maxCumulativeAmount, 6),
        maxFee: parseUnits(QUICK_LIMITS.maxFee, 6), durationSeconds: QUICK_LIMITS.durationSeconds,
      });
      progress("Activating sponsored session");
      const result = await api<{ validUntil: string; transaction?: Transaction }>("/v1/session/execute", { grant: prepared.grant, userSignature });
      quick.save({ account: account(), sessionAddress, privateKey, validUntil: Number(result.validUntil) * 1_000, marketMask: String(request.marketMask) });
      return { title: "One-click trading on", detail: `Trades up to ${QUICK_LIMITS.maxTradeAmount} USDC sign instantly in this tab for 8 hours`, txHash: result.transaction?.hash, value: undefined };
    }),

    revokeQuickTrading: () => run("Revoke", "Turn off one-click trading", async progress => {
      const session = quick.session, clearing = trader.settlement?.clearingAddress;
      if (!session || !clearing) throw new Error("No active session");
      progress("Confirm the revocation in your wallet");
      const receipt = await trader.send({ to: clearing, data: encodeFunctionData({ abi: clearingAbi, functionName: "revokeSession", args: [session.sessionAddress as Address] }) });
      quick.clear();
      return { title: "One-click trading off", detail: `Block ${receipt.blockNumber}`, txHash: receipt.hash, value: undefined };
    }),
  };

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}

export function useTrading() {
  const value = useContext(TradingContext);
  if (!value) throw new Error("useTrading outside TradingProvider");
  return value;
}
