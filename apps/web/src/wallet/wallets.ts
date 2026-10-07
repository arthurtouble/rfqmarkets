// Sorts wagmi connectors into the connect modal's sections. Kept free of
// React and wagmi runtime imports so it unit-tests under plain Node.
type ConnectorLike = { id: string; type: string; name: string };

export type WalletSections<C> = {
  /** Extensions that announced themselves (EIP-6963), or the generic browser wallet. */
  installed: C[];
  /** Base Account: a passkey smart wallet, nothing to install. */
  passkey: C[];
  /** WalletConnect: phone wallets by QR code or deep link. */
  remote: C[];
};

export function walletSections<C extends ConnectorLike>(connectors: readonly C[], hasInjectedProvider: boolean): WalletSections<C> {
  const announced = connectors.filter(connector => connector.type === "injected" && connector.id !== "injected");
  const generic = announced.length || !hasInjectedProvider ? [] : connectors.filter(connector => connector.id === "injected");
  return {
    installed: [...announced, ...generic],
    passkey: connectors.filter(connector => connector.type === "baseAccount"),
    remote: connectors.filter(connector => connector.type === "walletConnect"),
  };
}

export function walletLabel(connector: ConnectorLike) {
  if (connector.id === "injected") return "Browser wallet";
  if (connector.type === "walletConnect") return "WalletConnect";
  return connector.name;
}

type WalletError = { code?: unknown; name?: unknown; shortMessage?: unknown; message?: unknown; details?: unknown; cause?: unknown };

/** The error and its causes, outermost first (viem and wagmi wrap provider errors). */
function errorChain(error: unknown): WalletError[] {
  const chain: WalletError[] = [];
  for (let current = error; current && typeof current === "object" && chain.length < 6; current = (current as WalletError).cause) chain.push(current as WalletError);
  return chain;
}

const text = (error: WalletError) => [error.shortMessage, error.message, error.details].filter(part => typeof part === "string").join(" ");

/** The user dismissed the request in their wallet (EIP-1193 code 4001), or closed its window. */
export function isUserRejection(error: unknown) {
  return errorChain(error).some(item => item.code === 4001 || item.name === "UserRejectedRequestError"
    || /user (rejected|denied|cancel+ed|closed)|rejected by user|request rejected|connection request reset/i.test(text(item)));
}

/**
 * A short, plain sentence for a failed connect, network switch or signature.
 * `networkName` is the settlement chain, for the "wallet doesn't know this
 * network" case (EIP-1193 code 4902).
 */
export function walletErrorMessage(error: unknown, networkName: string) {
  if (isUserRejection(error)) return "You cancelled the request in your wallet.";
  const chain = errorChain(error);
  if (chain.some(item => item.code === 4902 || /unrecognized chain|chain .*not (been )?added|unsupported chain/i.test(text(item))))
    return `Your wallet doesn't have ${networkName} yet. Add it in the wallet, then try again.`;
  if (chain.some(item => item.code === -32002 || /already pending/i.test(text(item))))
    return "Your wallet already has a request open. Finish or close it there, then try again.";
  if (chain.some(item => item.name === "ProviderNotFoundError" || item.name === "ConnectorNotFoundError" || /provider not found|connector not found/i.test(text(item))))
    return "That wallet isn't available in this browser.";
  const first = chain[0];
  const message = first && typeof first.shortMessage === "string" ? first.shortMessage : first && typeof first.message === "string" ? first.message : "";
  return message.split("\n")[0] || "Your wallet didn't respond. Try again.";
}

/** Shown when nothing is installed, so a newcomer knows where to get one. */
export const GET_A_WALLET = [
  { name: "Rabby", url: "https://rabby.io" },
  { name: "MetaMask", url: "https://metamask.io/download" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
  { name: "Rainbow", url: "https://rainbow.me/download" },
] as const;
