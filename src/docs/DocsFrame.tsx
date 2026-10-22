import type { ReactNode } from "react";
import { DOCS_GROUPS, docEntry, docGroupOf, docHref, docNeighbours } from "./registry";

export interface DocContent { intro?: ReactNode; sections: { id: string; title: string; body: ReactNode }[] }


export function DocsHeader() {
  return (
    <header className="docs-header">
      <a className="docs-skip" href="#docs-main">Skip to content</a>
      <div className="docs-header-in">
        <a className="docs-brand" href="/" aria-label="Vektor home"><img src="/brand/vektor-header.png" alt="Vektor" style={{ height: 60, width: "auto", display: "block" }} /> <span className="docs-brand-sub">Docs</span></a>
        <a className="docs-btn" href="/app.html">Open the app</a>
      </div>
    </header>
  );
}

export function DocsFooter() {
  return (
    <footer className="docs-footer">
      <div className="docs-footer-in">
        <span className="docs-brand-sm"><img src="/brand/vektor-header.png" alt="Vektor" style={{ height: 48, width: "auto", display: "inline-block", verticalAlign: "middle", marginRight: 8 }} />built for the Strike Finance 48-hour hackathon</span>
        <span><a href="https://strikefinance.org" target="_blank" rel="noopener noreferrer">strikefinance.org</a> · <a href="/docs">Docs</a> · <a href="/app.html">Launch App</a></span>
      </div>
    </footer>
  );
}

function Toc({ current }: { current: string }) {
  return (
    <nav aria-label="Docs">
      {DOCS_GROUPS.map((g) => (
        <div key={g.label} className="docs-toc-group">
          <div className="docs-toc-label">{g.label}</div>
          <ul>
            {g.pages.map((p) => (
              <li key={p.slug}>
                <a href={docHref(p.slug)} aria-current={p.slug === current ? "page" : undefined} className={p.slug === current ? "is-active" : ""}>{p.nav ?? p.title}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function DocsFrame({ slug, content }: { slug: string; content: DocContent }) {
  const page = docEntry(slug)!;
  const group = docGroupOf(slug);
  const { prev, next } = docNeighbours(slug);
  return (
    <div className="docs-shell">
      <details className="docs-picker" key={slug}>
        <summary>Docs <span aria-hidden="true">▾</span> <span className="docs-picker-cur">{page.nav ?? page.title}</span></summary>
        <Toc current={slug} />
      </details>
      <aside className="docs-sidebar"><Toc current={slug} /></aside>
      <main id="docs-main" className="docs-main" tabIndex={-1}>
        <article>
          {group && <div className="docs-kicker">{group.label}</div>}
          <h1 className="docs-h1">{page.title}</h1>
          <p className="docs-lead">{page.description}</p>
          {content.intro && <div className="docs-intro">{content.intro}</div>}
          {content.sections.map((s) => (
            <section key={s.id} className="docs-section" aria-labelledby={s.id}>
              <h2 className="docs-h2" id={s.id}><a href={`#${s.id}`}>{s.title}</a></h2>
              {s.body}
            </section>
          ))}
        </article>
        <nav className="docs-pager" aria-label="Previous and next page">
          {prev ? <a className="docs-pager-card" rel="prev" href={docHref(prev.slug)}><span>Previous</span><strong>{prev.title}</strong></a> : <span />}
          {next ? <a className="docs-pager-card docs-pager-next" rel="next" href={docHref(next.slug)}><span>Next</span><strong>{next.title}</strong></a> : <span />}
        </nav>
      </main>
      {content.sections.length >= 3 && (
        <aside className="docs-onpage" aria-label="On this page">
          <div className="docs-toc-label">On this page</div>
          <ul>{content.sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ul>
        </aside>
      )}
    </div>
  );
}

export function DocsNotFound() {
  return (
    <div className="docs-shell docs-shell-404">
      <main id="docs-main" className="docs-main" tabIndex={-1}>
        <div className="docs-kicker">404</div>
        <h1 className="docs-h1">Page not found</h1>
        <p className="docs-lead">That docs page doesn't exist. Start from the <a className="docs-link" href="/docs">docs home</a>.</p>
      </main>
    </div>
  );
}
