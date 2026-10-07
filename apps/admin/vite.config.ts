import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
  // Every app's dev server otherwise shares the repository's node_modules/.vite. When the e2e harness
  // starts them together, one server's dependency optimisation invalidates another's
  // (504 "Outdated Optimize Dep" in the trading app).
  cacheDir: "../../node_modules/.vite/admin",
});
