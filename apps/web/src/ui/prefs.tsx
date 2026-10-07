// Per-device preferences: Simple or Advanced view, and the colour theme.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

export type Mode = "simple" | "advanced";
export type Theme = "system" | "dark" | "light";
type Prefs = { mode: Mode; setMode(mode: Mode): void; theme: Theme; setTheme(theme: Theme): void };

const PrefsContext = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key); return allowed.includes(value as T) ? value as T : fallback; } catch { return fallback; }
}
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => stored("rfq.mode", ["simple", "advanced"], "simple"));
  const [theme, setThemeState] = useState<Theme>(() => stored("rfq.theme", ["system", "dark", "light"], "system"));
  useEffect(() => {
    // tokens.css follows the system setting when no data-theme is set.
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const value: Prefs = {
    mode, theme,
    setMode: next => { save("rfq.mode", next); setModeState(next); },
    setTheme: next => { save("rfq.theme", next); setThemeState(next); },
  };
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const value = useContext(PrefsContext);
  if (!value) throw new Error("usePrefs outside PrefsProvider");
  return value;
}

/** True in the Advanced view. Features from the advanced layer render only when this is true. */
export const useAdvanced = () => usePrefs().mode === "advanced";

const DESKTOP = "(min-width: 900px)";
const subscribe = (notify: () => void) => { const query = matchMedia(DESKTOP); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); };
/** Desktop layout (top bar, two columns, dialogs) from 900px; phone layout below. */
export const useDesktop = () => useSyncExternalStore(subscribe, () => matchMedia(DESKTOP).matches, () => true);
