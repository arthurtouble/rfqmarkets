export type Theme = "light" | "dark";

const storageKey = "rfq-theme";

export function initializeTheme(): Theme {
  const saved = localStorage.getItem(storageKey);
  const theme: Theme = saved === "light" || saved === "dark"
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  return theme;
}

export function setTheme(theme: Theme) {
  localStorage.setItem(storageKey, theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d10" : "#f6f7f9");
  return theme;
}

export function flipTheme(theme: Theme) {
  return setTheme(theme === "dark" ? "light" : "dark");
}
