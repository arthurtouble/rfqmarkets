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

/** Shown when nothing is installed, so a newcomer knows where to get one. */
export const GET_A_WALLET = [
  { name: "Rabby", url: "https://rabby.io" },
  { name: "MetaMask", url: "https://metamask.io/download" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
  { name: "Rainbow", url: "https://rainbow.me/download" },
] as const;
