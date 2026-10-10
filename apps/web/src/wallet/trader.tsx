// One "trader" abstraction over the two ways to act: a browser wallet through
// wagmi, or the local stack's funded dev key (GET /v1/dev/wallet).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConfig, useConnection, useDisconnect } from "wagmi";
import {
  getConnection,
  sendTransaction,
  signTypedData,
  switchChain,
  waitForTransactionReceipt,
} from "wagmi/actions";
import { createWalletClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { API } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { ChainConfig, Prepared } from "../lib/types.js";
import { forgetSessionKeys } from "./quick-session.js";
import { walletLabel } from "./wallets.js";
import { verifyPrepared, type Expectation } from "./verify-intent.js";

type DevWallet = { account: Address; privateKey: Hex };
type Call = { to: Address; data: Hex; value?: bigint };
/** EIP-712 typed data already checked by the caller (verify-intent.ts, verify-deposit.ts). */
type TypedPayload = { domain: Record<string, unknown>; types: Record<string, readonly unknown[]>; primaryType: string; message: Record<string, unknown> };

export type Trader = {
  address: Address | null;
  source: "wallet" | "dev" | null;
  /** The connected browser wallet's name and icon, when one is connected. */
  wallet: { name: string; icon?: string } | null;
  chain: Chain;
  settlement: ChainConfig | null;
  /** Why the settlement config was refused (it disagrees with this build's pinned chain or contracts). */
  settlementError: string | null;
  /** A browser wallet is connected but on another chain. */
  wrongChain: boolean;
  devWalletAvailable: boolean;
  useDevWallet(): void;
  disconnect(): void;
  /** Verifies `prepared` against the trusted settlement and `expected` (verify-intent.ts), then signs it. */
  signIntent(prepared: Prepared, primaryType: string, expected: Expectation): Promise<Hex>;
  /** The typed data to sign for `prepared`, or a thrown IntentMismatchError. For the one-click key. */
  verified(prepared: Prepared, primaryType: string, expected: Expectation): ReturnType<typeof verifyPrepared>;
  /** Signs typed data on the settlement chain; the caller has verified it. */
  signTyped(payload: TypedPayload): Promise<Hex>;
  send(call: Call): Promise<{ hash: Hex; blockNumber: bigint }>;
  /** Sends from the browser wallet on another network (a deposit's source chain) and waits for it. */
  sendOn(chainId: number, call: Call): Promise<{ hash: Hex; blockNumber: bigint }>;
};

const TraderContext = createContext<Trader | null>(null);
const DEV_OPT_OUT = "rfq:dev-wallet-off";

export function TraderProvider({
  chain,
  settlement,
  settlementError = null,
  children,
}: {
  chain: Chain;
  settlement: ChainConfig | null;
  settlementError?: string | null;
  children: ReactNode;
}) {
  const config = useConfig();
  const connection = useConnection();
  const { mutate: disconnectWallet } = useDisconnect();
  const [devOptOut, setDevOptOut] = useState(() => {
    try {
      return sessionStorage.getItem(DEV_OPT_OUT) === "1";
    } catch {
      return false;
    }
  });
  const dev = useQuery({
    queryKey: ["dev-wallet"],
    queryFn: () => getJson<DevWallet>(`${API}/v1/dev/wallet`).catch(() => null),
    enabled: import.meta.env.DEV,
    staleTime: Infinity,
    retry: false,
  });
  const devWallet = dev.data?.account && dev.data.privateKey ? dev.data : null;
  const walletAddress = connection.status === "connected" ? connection.address : undefined;
  const usingDev = !walletAddress && !!devWallet && !devOptOut;

  useEffect(() => {
    try {
      sessionStorage.setItem(DEV_OPT_OUT, devOptOut ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [devOptOut]);

  const devClient = useMemo(
    () =>
      devWallet
        ? createWalletClient({
            account: privateKeyToAccount(devWallet.privateKey),
            chain,
            transport: http(chain.rpcUrls.default.http[0]),
          })
        : null,
    [devWallet, chain],
  );

  const ensureChain = useCallback(async () => {
    if (getConnection(config).chainId !== chain.id) await switchChain(config, { chainId: chain.id });
  }, [config, chain.id]);

  const signer = walletAddress ?? (usingDev ? devWallet!.account : null);
  const clearing = settlement?.clearingAddress;
  const verified = useCallback(
    (prepared: Prepared, primaryType: string, expected: Expectation) => {
      if (!signer) throw new Error("Connect a wallet first");
      return verifyPrepared(
        prepared,
        primaryType,
        { account: signer, chainId: chain.id, clearing },
        expected,
      );
    },
    [signer, chain.id, clearing],
  );

  const signIntent = useCallback(
    async (prepared: Prepared, primaryType: string, expected: Expectation) => {
      const payload = verified(prepared, primaryType, expected);
      if (usingDev && devClient) return devClient.signTypedData(payload as never);
      if (!walletAddress) throw new Error("Connect a wallet first");
      await ensureChain();
      return signTypedData(config, { account: walletAddress, ...payload } as never);
    },
    [verified, usingDev, devClient, walletAddress, ensureChain, config],
  );

  const signTyped = useCallback(
    async (payload: TypedPayload) => {
      if (usingDev && devClient) return devClient.signTypedData(payload as never);
      if (!walletAddress) throw new Error("Connect a wallet first");
      await ensureChain();
      return signTypedData(config, { account: walletAddress, ...payload } as never);
    },
    [usingDev, devClient, walletAddress, ensureChain, config],
  );

  const sendOn = useCallback(
    async (chainId: number, call: Call) => {
      if (!walletAddress) throw new Error("Connect a browser wallet to deposit from another network");
      if (getConnection(config).chainId !== chainId) await switchChain(config, { chainId });
      const hash = await sendTransaction(config, { account: walletAddress, chainId, ...call });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      return { hash, blockNumber: receipt.blockNumber };
    },
    [walletAddress, config],
  );

  const send = useCallback(
    async (call: Call) => {
      let hash: Hex;
      if (usingDev && devClient) hash = await devClient.sendTransaction(call);
      else {
        if (!walletAddress) throw new Error("Connect a wallet first");
        await ensureChain();
        hash = await sendTransaction(config, { account: walletAddress, chainId: chain.id, ...call });
      }
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: chain.id });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      return { hash, blockNumber: receipt.blockNumber };
    },
    [usingDev, devClient, walletAddress, ensureChain, config, chain.id],
  );

  const value: Trader = {
    address: signer,
    source: walletAddress ? "wallet" : usingDev ? "dev" : null,
    wallet:
      walletAddress && connection.connector
        ? { name: walletLabel(connection.connector), icon: connection.connector.icon }
        : null,
    chain,
    settlement,
    settlementError,
    wrongChain: !!walletAddress && connection.chainId !== chain.id,
    devWalletAvailable: !!devWallet,
    useDevWallet: () => {
      if (walletAddress) disconnectWallet();
      setDevOptOut(false);
    },
    // Disconnecting also drops this tab's one-click keys, so a shared computer keeps no signing key behind.
    disconnect: () => {
      forgetSessionKeys();
      if (walletAddress) disconnectWallet();
      setDevOptOut(true);
    },
    signIntent,
    verified,
    signTyped,
    send,
    sendOn,
  };
  return <TraderContext.Provider value={value}>{children}</TraderContext.Provider>;
}

export function useTrader() {
  const trader = useContext(TraderContext);
  if (!trader) throw new Error("useTrader outside TraderProvider");
  return trader;
}
