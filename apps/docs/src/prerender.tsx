// Build-time entry (vite.config.ts): renders each page to static HTML so search engines and
// AI tools that do not run JavaScript still read the full docs, sidebar and links included.
import React from "react";
import { renderToString } from "react-dom/server";
import { App, MOVED } from "./App.js";
import { pages } from "./pages.js";
import { headTags, llmsFullTxt, llmsTxt, markdownPath, robots, sitemap } from "./seo.js";

export const NOT_FOUND = "/404";
export { MOVED, headTags, llmsFullTxt, llmsTxt, markdownPath, pages, robots, sitemap };
export const render = (route: string) => renderToString(<App initialRoute={route} />);
