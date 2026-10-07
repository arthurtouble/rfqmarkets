import { useSwitchChain } from "wagmi";
import { Banner, Warn } from "../ui/primitives.js";
import { useToasts } from "../ui/toasts.js";
import { useTrader } from "./trader.js";
import { walletErrorMessage } from "./wallets.js";

/** Asks the connected wallet to move to the settlement chain; a refusal shows as a toast. */
export function useSwitchNetwork() {
  const trader = useTrader();
  const { notify } = useToasts();
  const { mutate, isPending } = useSwitchChain();
  const switchNetwork = () => mutate({ chainId: trader.chain.id }, {
    onError: error => notify({ kind: "error", title: `Couldn't switch to ${trader.chain.name}`, detail: walletErrorMessage(error, trader.chain.name) }),
  });
  return { switching: isPending, switchNetwork };
}

/** Header-sized button shown while the wallet is on another network. */
export function SwitchNetworkButton({ className = "" }: { className?: string }) {
  const { chain } = useTrader();
  const { switching, switchNetwork } = useSwitchNetwork();
  return <button type="button" className={`rfq-btn rfq-btn--sm wallet-warn ${className}`} disabled={switching} onClick={switchNetwork}>
    <Warn />{switching ? "Switching…" : `Switch to ${chain.name}`}
  </button>;
}

/** Full-width notice for pages, with the same switch action. */
export function WrongNetworkBanner() {
  const { chain } = useTrader();
  const { switching, switchNetwork } = useSwitchNetwork();
  return <Banner tone="warning" action={<button type="button" className="rfq-btn rfq-btn--sm rfq-btn--primary" disabled={switching} onClick={switchNetwork}>{switching ? "Switching…" : "Switch"}</button>}>
    Your wallet is on another network. Switch to <b>{chain.name}</b> to trade.
  </Banner>;
}
