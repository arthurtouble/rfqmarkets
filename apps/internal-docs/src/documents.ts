// Every Markdown file under docs/, bundled at build time. The model lives in manual.ts.
import { buildManual } from "./manual.js";

export const pages = buildManual(
  import.meta.glob<string>("../../../docs/**/*.md", { query: "?raw", import: "default", eager: true }),
);
