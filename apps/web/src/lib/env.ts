// Service origins. Production builds use same-origin paths behind the
// Cloudflare edge; dev builds talk to the local stack (npm run dev:stack).
const local = (port: number) => (import.meta.env.PROD ? "" : `http://127.0.0.1:${port}`);

export const API = import.meta.env.VITE_API_URL ?? local(4100);
export const INDEXER = import.meta.env.VITE_INDEXER_URL ?? local(4300);
export const MARKET_STREAM = import.meta.env.VITE_MARKET_STREAM_URL ?? local(4500);
// Public WalletConnect (Reown) project id. It ships in the bundle by design;
// the Reown dashboard limits which domains may use it.
// VITE_WALLETCONNECT_PROJECT_ID overrides it.
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "72594c43947653367e6ac1ba4406fa34";
// Public companion sites, linked from the Account page.
export const DOCS_URL = import.meta.env.VITE_DOCS_URL ?? "https://docs.rfq-markets.workers.dev";
export const EXIT_URL = import.meta.env.VITE_EXIT_URL ?? "https://exit.rfq-markets.workers.dev";
