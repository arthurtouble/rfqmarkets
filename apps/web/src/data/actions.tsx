// Every user action (trade, order, close, funds, quick trading) as one async
// function: prepare with the API, sign, submit, toast the outcome and refresh.
import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API } from "../lib/env.js";
import { errorMessage, postJson, randomNonce } from "../lib/http.js";
import { microToInput, shortHash, usdc } from "../lib/format.js";
import type { Market, Prepared, Quote, RestingOrder, Side, Transaction } from "../lib/types.js";
import { QUICK_LIMITS, sessionCovers, useQuickSession, type QuickSession } from "../wallet/quick-session.js";
import { typedData, useTrader } from "../wallet/trader.js";
import { useToasts } from "../ui/toasts.js";
import { keys } from "./queries.js";

const clearingAbi = parseAbi(["function deposit(uint256 amount)", "function revokeSession(address session)"]);
type Settled = { transaction?: Transaction; status?: string };

export type MarketOrder = { market: Market; side: Side; amountMicro: bigint; reduceOnly: boolean };
export type LimitOrder = MarketOrder & { limitPrice: string };

type Trading = {
  busy: string | null;
  quickSession: QuickSession | null;
  marketOrder(order: MarketOrder): Promise<void>;
  limitOrder(order: LimitOrder): Promise<void>;
  cancelOrder(order: RestingOrder): Promise<void>;
  closePosition(market: Market): Promise<void>;
  emergencyClose(market: Market): Promise<void>;
  deposit(amountMicro: bigint): Promise<boolean>;
  withdraw(amountMicro: bigint): Promise<boolean>;
  enableQuickTrading(): Promise<void>;
  revokeQuickTrading(): Promise<void>;
};

const TradingContext = createContext<Trading | null>(null);
const sideLabel = (side: Side) => (side === "buy" ? "Long" : "Short");
const blockLine = (tx?: Transaction) => (tx ? `Block ${tx.blockNumber} · ${shortHash(tx.hash)}` : undefined);

export function TradingProvider({ children }: { children: ReactNode }) {
  const trader = useTrader(), config = useConfig(), client = useQueryClient(), { notify } = useToasts();
  const quick = useQuickSession(trader.address);
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

  async function settleTrade(quote: Quote, reduceOnly: boolean, progress: (detail: string) => void, sessionAllowed: boolean) {
    const nonce = randomNonce();
    const prepared = await api<Prepared>("/v1/prepare", { quoteId: quote.quoteId, account: account(), nonce, reduceOnly });
    const session = sessionAllowed && quick.session?.privateKey ? quick.session as QuickSession & { privateKey: Hex } : null;
    progress(session ? "Signing with one-click trading" : "Confirm in your wallet");
    const userSignature: Hex = session
      ? await privateKeyToAccount(session.privateKey).signTypedData(typedData(prepared, "TradeIntent") as never)
      : await trader.signIntent(prepared, "TradeIntent");
    progress("Collecting approver signatures");
    return api<Settled>("/v1/approve", { quoteId: quote.quoteId, account: account(), nonce, userSignature });
  }

  const value: Trading = {
    busy,
    quickSession: quick.session,

    marketOrder: order => run("Trade", order.reduceOnly ? `Reduce ${order.market}` : `${sideLabel(order.side)} ${order.market}`, async progress => {
      progress("Getting a firm quote");
      const quote = await api<Quote>("/v1/quote", { market: order.market, side: order.side, amount: microToInput(order.amountMicro) });
      const result = await settleTrade(quote, order.reduceOnly, progress, sessionCovers(quick.session, order.amountMicro));
      return {
        title: order.reduceOnly
          ? `Reduced ${order.market} by ${usdc(order.amountMicro)}`
          : `${sideLabel(order.side)} ${order.market} ${usdc(order.amountMicro)} ${result.transaction ? "filled" : "approved"}`,
        detail: [`at ${usdc(quote.expectedPrice)}`, blockLine(result.transaction)].filter(Boolean).join(" · "),
        txHash: result.transaction?.hash, value: undefined,
      };
    }),

    limitOrder: order => run("Limit order", `Place ${order.side} limit`, async progress => {
      const prepared = await api<Prepared & { orderId: string }>("/v1/orders/prepare", {
        account: account(), market: order.market, side: order.side, amount: microToInput(order.amountMicro),
        limitPrice: order.limitPrice, durationSeconds: 86_400, nonce: randomNonce(), reduceOnly: order.reduceOnly,
      });
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "TradeIntent");
      await api("/v1/orders", { orderId: prepared.orderId, userSignature });
      return { title: `${sideLabel(order.side)} limit open`, detail: `${usdc(order.amountMicro)} ${order.market} at ${usdc((prepared.intent as { limitPrice: string }).limitPrice)}, good for 24 hours`, value: undefined };
    }),

    cancelOrder: order => run("Cancel", "Cancel order", async progress => {
      const prepared = await api<Prepared>(`/v1/orders/${order.orderId}/cancel/prepare`, {});
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "CancelIntent");
      const result = await api<Settled>(`/v1/orders/${order.orderId}/cancel`, { intent: prepared.intent, userSignature });
      return { title: "Order cancelled", detail: blockLine(result.transaction), txHash: result.transaction?.hash, value: undefined };
    }),

    closePosition: market => run("Close", `Close ${market}`, async progress => {
      progress("Getting an exact close quote");
      const quote = await api<Quote>("/v1/close/quote", { account: account(), market });
      const result = await settleTrade(quote, true, progress, false);
      return { title: `${market} position closed`, detail: [`at ${usdc(quote.expectedPrice)}`, blockLine(result.transaction)].filter(Boolean).join(" · "), txHash: result.transaction?.hash, value: undefined };
    }),

    emergencyClose: market => run("Emergency close", `Close ${market} at oracle`, async progress => {
      const prepared = await api<Prepared>("/v1/close/prepare", { account: account(), market, nonce: randomNonce() });
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "CloseIntent");
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
      return { title: `Deposited ${usdc(amount)}`, detail: `Block ${receipt.blockNumber}`, txHash: receipt.hash, value: true };
    })) ?? false,

    withdraw: async amount => (await run("Withdrawal", `Withdraw ${usdc(amount)}`, async progress => {
      const prepared = await api<Prepared>("/v1/withdraw/prepare", { account: account(), amount: microToInput(amount), nonce: randomNonce() });
      progress("Confirm in your wallet");
      const userSignature = await trader.signIntent(prepared, "WithdrawalIntent");
      progress("Submitting sponsored withdrawal");
      const result = await api<Settled>("/v1/withdraw/execute", { intent: prepared.intent, userSignature });
      return { title: `Withdrew ${usdc(amount)}`, detail: blockLine(result.transaction), txHash: result.transaction?.hash, value: true };
    })) ?? false,

    enableQuickTrading: () => run("One-click trading", "Turn on one-click trading", async progress => {
      const privateKey = generatePrivateKey(), sessionAddress = privateKeyToAccount(privateKey).address;
      const prepared = await api<Omit<Prepared, "intent"> & { grant: Record<string, unknown> }>("/v1/session/prepare", {
        account: account(), session: sessionAddress, ...QUICK_LIMITS, nonce: randomNonce(),
      });
      progress("Confirm the session in your wallet");
      const userSignature = await trader.signIntent({ ...prepared, intent: prepared.grant }, "SessionGrant");
      progress("Activating sponsored session");
      const result = await api<{ validUntil: string; transaction?: Transaction }>("/v1/session/execute", { grant: prepared.grant, userSignature });
      quick.save({ account: account(), sessionAddress, privateKey, validUntil: Number(result.validUntil) * 1_000 });
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
