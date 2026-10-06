import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4173 },
  // React, TanStack, wagmi and viem together are ~175 kB gzip; signing and
  // CCIP code still load lazily.
  build: { chunkSizeWarningLimit: 650 },
});
