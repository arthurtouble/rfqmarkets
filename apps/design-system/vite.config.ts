import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 4177, strictPort: true },
  // Ship every asset as a file: the CSP's font-src 'self' blocks fonts Vite would inline as data: URLs.
  build: { assetsInlineLimit: 0 },
});
