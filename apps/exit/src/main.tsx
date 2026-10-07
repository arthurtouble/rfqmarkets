import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/500.css";
import { App } from "./App.js";
import { readConfig } from "./config.js";
import "./styles.css";

const config = readConfig(import.meta.env);
const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode>{typeof config === "string"
  ? <main className="exit-page"><div className="exit-hero"><h1>Emergency exit</h1><div className="rfq-banner rfq-banner--danger" role="alert">{config}</div></div></main>
  : <App config={config} />}</StrictMode>);
