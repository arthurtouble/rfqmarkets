// Per-device preferences (the colour theme) and the layout hooks.
import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { store, storedChoice } from "../lib/storage.js";

export type Theme = "system" | "dark" | "light";
type Prefs = { theme: Theme; setTheme(theme: Theme): void };

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    storedChoice("rfq.theme", ["system", "dark", "light"], "system"),
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
