import { StrictMode } from "react";
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
import { createWagmiConfig, loadSettlement } from "./wallet/chain.js";
import { TraderProvider } from "./wallet/trader.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 2, refetchOnWindowFocus: true } },
});

const settlement = await loadSettlement();
const wagmiConfig = createWagmiConfig(settlement.chain);

createRoot(document.getElementById("root")!).render(<StrictMode>
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <TraderProvider chain={settlement.chain} settlement={settlement.config} settlementError={settlement.error ?? null}>
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
</StrictMode>);
