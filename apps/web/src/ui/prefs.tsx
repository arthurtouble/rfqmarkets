// Per-device preferences (the colour theme) and the layout hooks.
import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { store, storedChoice } from "../lib/storage.js";

export type Theme = "system" | "dark" | "light";
/** Which screen Home opens: the one-tap Up/Down view or the Pro terminal. Same account and positions either way. */
export type TradingView = "simple" | "pro";
/**
 * How a new trade is margined. Cross (the default) trades on the main account, so every position shares the
 * whole balance and a market holds one position. Isolated sets the trade's margin aside in its own account
 * for that market, so its loss stops at that margin.
 */
export type MarginMode = "cross" | "isolated";
type Prefs = {
  theme: Theme;
  setTheme(theme: Theme): void;
  view: TradingView;
  setView(view: TradingView): void;
  marginMode: MarginMode;
  setMarginMode(mode: MarginMode): void;
};

export const VIEW_KEY = "rfq.view";
const MARGIN_KEY = "rfq.margin";
/** The saved trading view (also read outside React, by the router's redirects). */
export const storedView = (): TradingView => storedChoice(VIEW_KEY, ["simple", "pro"], "simple");
/** Home's path for the saved view. */
export const homePath = (view: TradingView) => (view === "pro" ? "/trade/$market" : "/updown/$market");

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    storedChoice("rfq.theme", ["system", "dark", "light"], "system"),
  );
  const [view, setViewState] = useState<TradingView>(storedView);
  const [marginMode, setMarginState] = useState<MarginMode>(() =>
    storedChoice(MARGIN_KEY, ["cross", "isolated"], "cross"),
  );
  useEffect(() => {
    // tokens.css follows the system setting when no data-theme is set.
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const value: Prefs = {
    theme,
    setTheme: (next) => {
      store("rfq.theme", next);
      setThemeState(next);
    },
    view,
    setView: (next) => {
      store(VIEW_KEY, next);
      setViewState(next);
    },
    marginMode,
    setMarginMode: (next) => {
      store(MARGIN_KEY, next);
      setMarginState(next);
    },
  };
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const value = useContext(PrefsContext);
  if (!value) throw new Error("usePrefs outside PrefsProvider");
  return value;
}

/**
 * True in Pro (the /trade terminal), which shows everything: limit and stop orders, close only,
 * slippage and price details. Home, Markets and Portfolio stay simple.
 */
export const useAdvanced = () =>
  useRouterState({ select: (state) => state.location.pathname.startsWith("/trade") });

const DESKTOP = "(min-width: 900px)";
const subscribe = (notify: () => void) => {
  const query = matchMedia(DESKTOP);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
/** Desktop layout (top bar, two columns, dialogs) from 900px; phone layout below. */
export const useDesktop = () =>
  useSyncExternalStore(
    subscribe,
    () => matchMedia(DESKTOP).matches,
    () => true,
  );
