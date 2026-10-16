import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The app's public address: link previews (og:url, og:image) need absolute URLs.
const APP_URL = (process.env.VITE_APP_URL || "https://dev.rfq-markets.workers.dev").replace(/\/+$/, "");
const appUrl: Plugin = {
  name: "rfq-app-url",
  transformIndexHtml: (html) => html.replaceAll("%RFQ_APP_URL%", APP_URL),
};

export default defineConfig({
  plugins: [react(), appUrl],
  server: { host: "127.0.0.1", port: 4173 },
  // Pre-bundle every dependency the app can import, including lazy ones, so the dev server never
  // re-optimizes mid-session and answers a module request with "504 Outdated Optimize Dep".
  optimizeDeps: { entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/*.test.ts"] },
  // Every chunk stays under Vite's default 500 kB warning: pages other than Home load lazily
  // (router.tsx) and the shared market registry carries no ethers.
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
});
