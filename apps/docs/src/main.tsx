import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/500.css";
import { Markdown } from "./Markdown.js";
import { pages, resolveLink, sections } from "./pages.js";
import "./styles.css";

const APP_URL = "https://dev.rfq-markets.workers.dev";

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
    <div className="shell">
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="brand-row">
          {link("/", <><i>R</i><span><b>RFQ Markets</b><small>Documentation</small></span></>, "brand")}
          <button className="menu" aria-expanded={menuOpen} aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? "Close" : "Menu"}</button>
        </div>
        <input className="search" type="search" aria-label="Search the docs" placeholder="Search the docs" value={query} onChange={(event) => setQuery(event.target.value)} />
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
          </nav>
        )}
      </aside>
      <main>
        <header className="topbar">
          <span>{page?.section ?? "Docs"}</span>
          <a href={APP_URL}>Open the app ↗</a>
        </header>
        <div className="page">
          <article className="content">
            {page ? (
              <>
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
  );
}

createRoot(document.getElementById("root")!).render(<App />);
