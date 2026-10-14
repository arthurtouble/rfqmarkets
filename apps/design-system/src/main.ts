// Renders the design system specimen from tokens.json, so it can never drift from what the apps use.
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import tokens from "../../../packages/design-system/tokens.json" with { type: "json" };

type Token = { name: string; value: string | Record<string, string>; usage?: string };
type Style = { name: string; fontSize: string; usage?: string; sample?: string };

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
const usage = (text?: string) =>
  text ? `<p>${escape(text).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>` : "";
const shown = (value: Token["value"]) =>
  typeof value === "string"
    ? value
    : Object.entries(value)
        .map(([theme, hex]) => `${theme} ${hex}`)
        .join(" · ");

const colors = (tokens.color.tokens as Token[])
  .map(
    (token) => `<figure class="ds-swatch" style="margin:0">
      <i style="background:var(--${token.name})"></i>
      <div><b>${token.name}</b><code>${escape(shown(token.value))}</code>${usage(token.usage)}</div>
    </figure>`,
  )
  .join("");

const type = (tokens.type.groups as Array<{ name: string; styles: Style[] }>)
  .map(
    (group) =>
      `<h3>${escape(group.name)}</h3>${group.styles
        .map(
          (style) => `<div><small>${style.name} · ${style.fontSize}</small>
        <span class="${style.name}">${escape(style.sample ?? "RFQ Markets: the price you see is the price you get")}</span>${usage(style.usage)}</div>`,
        )
        .join("")}`,
  )
  .join("");

const sizes = (family: "spacing" | "radius") =>
  ((tokens[family]?.tokens ?? []) as Token[])
    .map((token) => {
      const value = String(token.value);
      const box =
        family === "spacing"
          ? `width:${value};height:${value}`
          : `width:48px;height:48px;border-radius:${value}`;
      return `<div><b style="${box}"></b><small>${token.name} · ${escape(value)}</small></div>`;
    })
    .join("");

const components = `
  <h3>Buttons</h3>
  <div class="ds-row">
    <button class="rfq-btn rfq-btn--primary">Deposit</button>
    <button class="rfq-btn rfq-btn--long">Up</button>
    <button class="rfq-btn rfq-btn--short">Down</button>
    <button class="rfq-btn rfq-btn--secondary">Withdraw</button>
    <button class="rfq-btn rfq-btn--ghost">Pro</button>
    <button class="rfq-btn rfq-btn--primary" disabled>Disabled</button>
    <button class="rfq-btn rfq-btn--primary"><span class="rfq-spinner"></span>Placing your trade…</button>
  </div>
  <h3>Badges and chips</h3>
  <div class="ds-row">
    <span class="rfq-badge">Live</span><span class="rfq-badge rfq-badge--brand">One tap</span>
    <span class="rfq-badge rfq-badge--long">Up</span><span class="rfq-badge rfq-badge--short">Down</span>
    <span class="rfq-badge rfq-badge--warning">Price delayed</span>
  </div>
  <div class="rfq-chips ds-row"><button class="rfq-chip" aria-pressed="true">$10</button><button class="rfq-chip">$25</button><button class="rfq-chip">$50</button></div>
  <h3>Banners</h3>
  <div class="ds-stack">
    <div class="rfq-banner rfq-banner--warning"><b>Ethereum is paused.</b> You can still close a position.</div>
    <div class="rfq-banner rfq-banner--danger">Something went wrong. Nothing was sent. Try again.</div>
  </div>
  <h3>Toasts</h3>
  <div class="ds-stack">
    <div class="rfq-toast rfq-toast--pending"><span class="rfq-toast__icon"><span class="rfq-spinner"></span></span><div><div class="rfq-toast__title">Placing your trade</div></div></div>
    <div class="rfq-toast rfq-toast--success"><div><div class="rfq-toast__title">You're Up on Ethereum with $10</div></div></div>
    <div class="rfq-toast rfq-toast--error"><div><div class="rfq-toast__title">Price moved, getting a new price</div></div></div>
  </div>
  <h3>Card</h3>
  <div class="rfq-card rfq-card--pad ds-stack"><b>Your trade</b><span class="rfq-up tnum">+$1.24 (12.4%)</span><span class="rfq-faint">Entry $4,007.05 · Auto-closes at $3,650.20</span></div>`;

document.getElementById("specimen")!.innerHTML = `
  <section id="color"><h2>Color</h2><div class="ds-grid">${colors}</div></section>
  <section id="type"><h2>Type</h2><div class="ds-type">${type}</div></section>
  <section id="space"><h2>Space and radius</h2><div class="ds-space">${sizes("spacing")}</div><div class="ds-space" style="margin-top:24px">${sizes("radius")}</div></section>
  <section id="components"><h2>Components</h2>${components}</section>`;

const pick = (theme: string) => {
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"))
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"))
  button.addEventListener("click", () => pick(button.dataset.themeChoice!));
pick(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
