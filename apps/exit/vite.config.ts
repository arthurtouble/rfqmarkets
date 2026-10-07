import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The exit page must work with nothing but a wallet, so the build is fully static and self-contained.
export default defineConfig({ plugins: [react()], server: { host: "127.0.0.1", port: 4178 }, // No inlined assets: the CSP allows fonts from this origin only, not data: URLs.
  build: { chunkSizeWarningLimit: 600, assetsInlineLimit: 0 } });
