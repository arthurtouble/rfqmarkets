// Browser wallets, found through EIP-6963 announcements with window.ethereum as a fallback.
import type { ChainInfo } from "./config.js";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193;
}

interface Announcement {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

/** Collects announced wallets for `waitMs`, then adds window.ethereum if no announced wallet is the same object. */
export async function discoverWallets(target: Window = window, waitMs = 250): Promise<WalletOption[]> {
  const found = new Map<string, WalletOption>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Announcement>).detail;
    if (!detail?.provider || !detail.info?.rdns) return;
    found.set(detail.info.rdns, { id: detail.info.rdns, name: detail.info.name, icon: safeIcon(detail.info.icon), provider: detail.provider });
  };
  target.addEventListener("eip6963:announceProvider", listener);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise(done => setTimeout(done, waitMs));
  target.removeEventListener("eip6963:announceProvider", listener);
  const injected = (target as unknown as { ethereum?: Eip1193 }).ethereum;
  const wallets = [...found.values()];
  if (injected && !wallets.some(wallet => wallet.provider === injected)) wallets.push({ id: "injected", name: "Browser wallet", provider: injected });
  return wallets;
}

/** Only inline images: the page's CSP blocks remote ones, and an icon must not run script. */
const safeIcon = (icon: string | undefined) => (icon && /^data:image\/(png|svg\+xml|webp|jpeg|gif)[;,]/.test(icon) ? icon : undefined);

export async function requestAccount(provider: Eip1193): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("Your wallet did not share an account.");
  return accounts[0];
}

export async function walletChainId(provider: Eip1193): Promise<bigint> {
  return BigInt((await provider.request({ method: "eth_chainId" })) as string);
}

/** Asks the wallet to switch to `chainId`, adding the chain first if the wallet does not know it. */
export async function switchChain(provider: Eip1193, chainId: bigint, chain: ChainInfo) {
  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 || !chain.add) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, ...chain.add }] });
  }
}

/** Links that open this page inside a mobile wallet's own browser, for phones without an injected wallet. */
export function walletAppLinks(pageUrl: string) {
  const url = new URL(pageUrl);
  const hostAndPath = `${url.host}${url.pathname}`;
  return [
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url.href)}` },
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${hostAndPath}` },
  ];
}
