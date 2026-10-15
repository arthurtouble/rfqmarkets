import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { WagmiProvider } from "wagmi";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/500.css";
import { MarketFeedProvider } from "./data/market-feed.js";
import { TradingProvider } from "./data/actions.js";
import { router } from "./router.js";
import { PrefsProvider } from "./ui/prefs.js";
import { ToastProvider } from "./ui/toasts.js";
import { createWagmiConfig, loadSettlement, type Settlement } from "./wallet/chain.js";
import { provisionalSettlement } from "./wallet/settlement.js";
import { TraderProvider } from "./wallet/trader.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 2, refetchOnWindowFocus: true } },
});

// A build pinned to a known chain draws at once and can sign once /v1/config arrives and checks out;
// an unpinned (local) build waits for the config, which names its chain.
const loading = loadSettlement();
const provisional = provisionalSettlement(import.meta.env);
const initial = provisional ?? (await loading);

function App() {
  const [settlement, setSettlement] = useState<Settlement>(initial);
  useEffect(() => {
    if (provisional) void loading.then(setSettlement);
  }, []);
  const wagmiConfig = useMemo(() => createWagmiConfig(settlement.chain), [settlement.chain]);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <TraderProvider
          chain={settlement.chain}
          settlement={settlement.config}
          settlementError={settlement.error ?? null}
        >
          <ToastProvider>
            <TradingProvider>
              <MarketFeedProvider>
                <PrefsProvider>
                  <RouterProvider router={router} />
                </PrefsProvider>
              </MarketFeedProvider>
            </TradingProvider>
          </ToastProvider>
        </TraderProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
