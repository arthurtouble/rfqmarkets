import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4173 },
  // Pre-bundle every dependency the app can import, including lazy ones, so the dev server never
  // re-optimizes mid-session and answers a module request with "504 Outdated Optimize Dep".
  optimizeDeps: { entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/*.test.ts"] },
  // Every chunk stays under Vite's default 500 kB warning: pages other than Home load lazily
  // (router.tsx) and the shared market registry carries no ethers.
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
});
