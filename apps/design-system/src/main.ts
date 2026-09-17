const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
const apply = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  if (button) button.textContent = theme === "light" ? "Dark mode" : "Light mode";
};
apply(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
button?.addEventListener("click", () => apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
