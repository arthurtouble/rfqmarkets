import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ cacheDir:"../../.local-state/vite-cache/web", plugins:[react()], server:{ host:"127.0.0.1", port:4173 } });
