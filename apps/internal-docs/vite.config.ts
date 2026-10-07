import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 4176 },
  // Own dependency cache, so it cannot invalidate the other apps' dev servers (see apps/admin/vite.config.ts).
  cacheDir: "../../node_modules/.vite/internal-docs",
});
