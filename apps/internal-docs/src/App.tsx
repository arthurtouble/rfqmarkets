import React, { useEffect, useMemo, useState } from "react";
import { pages } from "./documents.js";
import { resolveLink, search, sectionsOf, sourceUrl, type Page } from "./manual.js";
import { Markdown, type LinkProps } from "./Markdown.js";

const sections = sectionsOf(pages);
const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
const findPage = (route: string) => pages.find((page) => page.route === route);

/** Path routing (the worker serves index.html for every path); back and forward work as usual. */
function useRoute() {
  const [route, setRoute] = useState(() => normalize(decodeURI(window.location.pathname)));
  useEffect(() => {
    const onPop = () => setRoute(normalize(decodeURI(window.location.pathname)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (target: string) => {
    const [path, hash] = target.split("#");
    if (path && normalize(path) !== route) {
      history.pushState(null, "", target);
      setRoute(normalize(path));
    } else history.replaceState(null, "", target);
    requestAnimationFrame(() => (hash ? document.getElementById(hash)?.scrollIntoView() : window.scrollTo(0, 0)));
  };
  return [route, go] as const;
}

/** A click handler that keeps in-manual navigation in the page but leaves modified clicks to the browser. */
const navigate = (go: (target: string) => void, target: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go(target);
};

export function App() {
  const [route, go] = useRoute();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const page = findPage(route);
  const results = useMemo(() => search(pages, query), [query]);
  const open = (target: string) => {
    setQuery("");
    setMenuOpen(false);
    go(target);
  };

  useEffect(() => {
    document.title = page ? `${page.title} · RFQ internal manual` : "Not found · RFQ internal manual";
  }, [page]);
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="manual">
      <header className="rfq-topbar manual-topbar">
        <button
          className="rfq-icon-btn manual-menu"
          aria-expanded={menuOpen}
          aria-controls="manual-nav"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d={menuOpen ? "M4 4l10 10M14 4L4 14" : "M2 5h14M2 9h14M2 13h14"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <a className="rfq-logo" href="/" onClick={navigate(open, "/")}>
          <Mark />
          RFQ Markets
        </a>
        <span className="manual-tag">Internal manual</span>
        <div className="rfq-topbar__end">
          <span className="rfq-badge rfq-badge--warning" title="Behind Cloudflare Access. Contains architecture and operating details, never secrets.">
            Restricted
          </span>
        </div>
      </header>

      <div className="manual-body">
        {menuOpen && <div className="rfq-scrim manual-scrim" onClick={() => setMenuOpen(false)} />}
        <aside id="manual-nav" className={`manual-nav${menuOpen ? " is-open" : ""}`}>
          <div className="rfq-field__box manual-search">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input type="search" aria-label="Search the manual" placeholder="Search the manual" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          {query.trim().length > 1 ? (
            <nav className="manual-results" aria-label="Search results">
              <p className="caption rfq-faint">
                {results.length} {results.length === 1 ? "page" : "pages"}
              </p>
              {results.length ? (
                results.map(({ page: result, excerpt }) => (
                  <a key={result.id} href={result.route} onClick={navigate(open, result.route)}>
                    <b>{result.title}</b>
                    <span className="rfq-faint">{result.section}</span>
                    <span>{excerpt}</span>
                  </a>
                ))
              ) : (
                <p className="footnote rfq-muted">Nothing matches “{query.trim()}”.</p>
              )}
            </nav>
          ) : (
            <nav className="manual-sections" aria-label="Manual">
              {sections.map((section) => (
                <section key={section}>
                  <h2>{section}</h2>
                  {pages
                    .filter((item) => item.section === section)
                    .map((item) => (
                      <a key={item.id} href={item.route} aria-current={item.route === route ? "page" : undefined} onClick={navigate(open, item.route)}>
                        {item.title}
                      </a>
                    ))}
                </section>
              ))}
            </nav>
          )}
          <p className="manual-count caption rfq-faint">{pages.length} pages from docs/</p>
        </aside>

        <main className="manual-main">
          {page ? <Article page={page} open={open} /> : <NotFound route={route} open={open} />}
        </main>
      </div>
    </div>
  );
}

export function Article({ page, open }: { page: Page; open: (target: string) => void }) {
  const index = pages.indexOf(page),
    previous = pages[index - 1],
    next = pages[index + 1];
  const link = (href: string): LinkProps => {
    const target = resolveLink(page.id, href, pages);
    if (target.kind === "external") return { href: target.href, external: true };
    const destination = target.kind === "anchor" ? `#${target.hash}` : `${target.route}${target.hash ? `#${target.hash}` : ""}`;
    return { href: destination, onClick: navigate(open, destination) };
  };
  return (
    <div className="manual-page">
      <article className="manual-article">
        <div className="manual-meta caption">
          <span className="rfq-faint">{page.section}</span>
          <a href={sourceUrl(page)} target="_blank" rel="noreferrer">
            View source
          </a>
        </div>
        <Markdown source={page.body} link={link} diagramHref={sourceUrl(page)} />
        <footer className="manual-pager">
          {previous ? (
            <a href={previous.route} onClick={navigate(open, previous.route)}>
              <small>Previous</small>
              {previous.title}
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className="is-next" href={next.route} onClick={navigate(open, next.route)}>
              <small>Next</small>
              {next.title}
            </a>
          ) : (
            <span />
          )}
        </footer>
      </article>
      {page.headings.length > 1 && (
        <nav className="manual-toc" aria-label="On this page">
          <h2>On this page</h2>
          {page.headings.map((heading) => (
            <a key={heading.slug} href={`#${heading.slug}`} className={heading.level === 3 ? "is-sub" : undefined} onClick={navigate(open, `#${heading.slug}`)}>
              {heading.text}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

function NotFound({ route, open }: { route: string; open: (target: string) => void }) {
  return (
    <div className="manual-page">
      <article className="manual-article">
        <h1>Page not found</h1>
        <p>
          Nothing in the manual lives at <code>{route}</code>. The page may have moved when the docs were reorganised;
          try the search.
        </p>
        <p>
          <a href="/" onClick={navigate(open, "/")}>
            Go to the start page
          </a>
        </p>
      </article>
    </div>
  );
}

function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 22V10h4.5v4.5h5V10H23v12h-4.5v-4.5h-5V22z" fill="var(--on-brand)" />
    </svg>
  );
}
