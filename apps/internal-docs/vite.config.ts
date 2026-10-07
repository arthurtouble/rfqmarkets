import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
  server: { port: 4176 },
  // Own dependency cache, so it cannot invalidate the other apps' dev servers (see apps/admin/vite.config.ts).
  cacheDir: "../../node_modules/.vite/internal-docs",
});
