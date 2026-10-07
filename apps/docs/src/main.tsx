import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/500.css";
import { Markdown } from "./Markdown.js";
import { pages, resolveLink, sections } from "./pages.js";
import "./styles.css";

const APP_URL = "https://dev.rfq-markets.workers.dev";

type Theme = "system" | "dark" | "light";
const THEMES: Theme[] = ["system", "dark", "light"];
// Same key as the trading app. Without data-theme, tokens.css follows the system setting.
function storedTheme(): Theme {
  try { const value = localStorage.getItem("rfq.theme"); return THEMES.includes(value as Theme) ? (value as Theme) : "system"; } catch { return "system"; }
}
function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
applyTheme(storedTheme());

function ThemeSwitch({ className }: { className: string }) {
  const [theme, setTheme] = useState(storedTheme);
  const choose = (next: Theme) => { try { localStorage.setItem("rfq.theme", next); } catch { /* private mode */ } applyTheme(next); setTheme(next); };
  return (
    <div className={`rfq-seg ${className}`} role="group" aria-label="Colour theme">
      {THEMES.map((item) => <button key={item} type="button" aria-pressed={theme === item} onClick={() => choose(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
    </div>
  );
}

const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

function useRoute() {
  const [route, setRoute] = useState(() => normalize(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(normalize(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (target: string) => {
    const [path, hash] = target.split("#");
    if (!path) { document.getElementById(hash)?.scrollIntoView(); history.replaceState(null, "", `#${hash}`); return; }
    history.pushState(null, "", target);
    setRoute(normalize(path));
    requestAnimationFrame(() => (hash ? document.getElementById(hash)?.scrollIntoView() : window.scrollTo(0, 0)));
  };
  return [route, go] as const;
}

function snippet(body: string, query: string) {
  const text = body.replace(/```[\s\S]*?```/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*`>|]/g, "").replace(/\s+/g, " ");
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return "";
  const start = Math.max(0, at - 50);
  return `${start ? "…" : ""}${text.slice(start, at + query.length + 70).trim()}…`;
}

function App() {
  const [route, go] = useRoute();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const page = pages.find((item) => item.route === route);
  const index = page ? pages.indexOf(page) : -1;
  const needle = query.trim().toLowerCase();
  const results = useMemo(
    () => (needle.length < 2 ? [] : pages.filter((item) => `${item.title} ${item.body}`.toLowerCase().includes(needle)).slice(0, 12)),
    [needle],
  );

  useEffect(() => {
    document.title = page ? (page.route === "/" ? "RFQ Markets Docs" : `${page.title} · RFQ Markets Docs`) : "Not found · RFQ Markets Docs";
  }, [page]);
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
  }, []);

  const open = (target: string) => { setQuery(""); setMenuOpen(false); go(target); };
  const link = (target: string, label: React.ReactNode, className?: string) => (
    <a href={target} className={className} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); open(target); }}>{label}</a>
  );

  return (
    <>
      <header className="topbar">
        {link("/", <>RFQ Markets <span>Docs</span></>, "rfq-logo")}
        <div className="topbar__end">
          <ThemeSwitch className="theme" />
          <a className="rfq-btn rfq-btn--primary rfq-btn--sm open-app" href={APP_URL}>Open app</a>
          <button className="rfq-btn rfq-btn--secondary rfq-btn--sm menu" aria-expanded={menuOpen} aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? "Close" : "Menu"}</button>
        </div>
      </header>
      <div className="shell">
        <aside className={`sidebar${menuOpen ? " open" : ""}`}>
          <input className="search" type="search" aria-label="Search the docs" placeholder="Search the docs" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ThemeSwitch className="theme-mobile" />
          {needle.length >= 2 ? (
            <nav className="results" aria-label="Search results">
              {results.length ? results.map((item) => (
                <a key={item.route} href={item.route} onClick={(event) => { event.preventDefault(); open(item.route); }}>
                  <b>{item.title}</b><span>{snippet(item.body, needle) || item.summary}</span>
                </a>
              )) : <p className="empty">Nothing matches “{query.trim()}”.</p>}
            </nav>
          ) : (
            <nav aria-label="Documentation">
              {sections.map((section) => (
                <section key={section.id}>
                  <h2>{section.title}</h2>
                  {pages.filter((item) => item.path.startsWith(`${section.id}/`)).map((item) => (
                    <React.Fragment key={item.route}>{link(item.route, item.title, item.route === route ? "active" : undefined)}</React.Fragment>
                  ))}
                </section>
              ))}
              <section className="theme-mobile-link"><a href={APP_URL}>Open the app ↗</a></section>
            </nav>
          )}
        </aside>
        <main>
          <div className="page">
            <article className="content">
              {page ? (
                <>
                  <p className="eyebrow">{page.section}</p>
                  <Markdown source={page.body} resolve={(href) => resolveLink(page.path, href)} go={open} />
                  <footer className="pager">
                    {index > 0 ? link(pages[index - 1].route, <><small>Previous</small>{pages[index - 1].title}</>, "prev") : <span />}
                    {index < pages.length - 1 ? link(pages[index + 1].route, <><small>Next</small>{pages[index + 1].title}</>, "next") : <span />}
                  </footer>
                </>
              ) : (
                <>
                  <h1>Page not found</h1>
                  <p>There is no page at <code>{route}</code>. It may have moved when the docs were reorganised.</p>
                  <p>{link("/", "Go to the introduction")}</p>
                </>
              )}
            </article>
            {page && page.headings.length > 1 ? (
              <nav className="toc" aria-label="On this page">
                <h2>On this page</h2>
                {page.headings.map((heading) => <a key={heading.id} href={`#${heading.id}`}>{heading.title}</a>)}
              </nav>
            ) : null}
          </div>
        </main>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
