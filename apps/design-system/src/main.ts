import { flipTheme, initializeTheme } from "../../../packages/design-system/theme.js";

let theme = initializeTheme();
const control = document.querySelector<HTMLButtonElement>("#theme")!;
const render = () => {
  control.textContent = theme === "dark" ? "☀" : "☾";
  control.setAttribute("aria-label", `Use ${theme === "dark" ? "light" : "dark"} theme`);
};
control.addEventListener("click", () => { theme = flipTheme(theme); render(); });
render();
