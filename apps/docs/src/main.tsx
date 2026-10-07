import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/500.css";
import { App, applyTheme, storedTheme } from "./App.js";
import "./styles.css";

applyTheme(storedTheme());
// The build ships every page pre-rendered for crawlers; the app then renders over it.
createRoot(document.getElementById("root")!).render(<App />);
