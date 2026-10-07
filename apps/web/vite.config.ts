import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4173 },
  // Lazily imported (Advanced chart); pre-bundled so a fresh dev server does not
  // re-optimize and break the dynamic import on first use.
  optimizeDeps: { include: ["lightweight-charts"] },
  // React, TanStack, wagmi and viem together are ~175 kB gzip; signing and
  // CCIP code still load lazily.
  build: { chunkSizeWarningLimit: 650 },
});
