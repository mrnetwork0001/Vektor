import { useState, type ReactNode } from "react";
import { docHref } from "./registry";

export function P({ lead, children }: { lead?: string; children: ReactNode }) {
  return <p className="docs-p">{lead && <strong>{lead} </strong>}{children}</p>;
}

export function H3({ id, children }: { id?: string; children: ReactNode }) {
  return <h3 className="docs-h3" id={id}>{id ? <a href={`#${id}`}>{children}</a> : children}</h3>;
}

export const Code = ({ children }: { children: ReactNode }) => <code className="docs-code">{children}</code>;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={`docs-copy ${done ? "is-done" : ""}`} aria-label={done ? "Copied" : label}
      onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function CodeBlock({ label, children }: { label?: string; children: string }) {
  return (
    <div className="docs-codeblock">
      <div className="docs-codeblock-head"><span>{label ?? "code"}</span><CopyButton value={children} label={`Copy ${label ?? "code"}`} /></div>
      <pre><code>{children}</code></pre>
    </div>
  );
}

export const DocLink = ({ to, children }: { to: string; children: ReactNode }) => {
  const [slug, hash] = to.split("#");
  return <a className="docs-link" href={docHref(slug) + (hash ? `#${hash}` : "")}>{children}</a>;
};

export const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="docs-link" href={href} target="_blank" rel="noopener noreferrer">
    {children}<span aria-hidden="true" className="docs-ext">↗</span><span className="docs-sr">(opens in a new tab)</span>
  </a>
);

export function Callout({ tone = "note", title, children }: { tone?: "note" | "warning" | "honest"; title?: string; children: ReactNode }) {
  const label = title ?? (tone === "warning" ? "Warning" : tone === "honest" ? "Honest status" : "Note");
  return <aside className={`docs-callout docs-callout-${tone}`} role="note"><strong className="docs-callout-title">{label}</strong><div>{children}</div></aside>;
}

export function StepList({ steps }: { steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="docs-steps">
      {steps.map((s, i) => <li key={i}><strong>{s.title}</strong><span>{s.body}</span></li>)}
    </ol>
  );
}

export function DocTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="docs-table-wrap" role="region" aria-label="table" tabIndex={0}>
      <table className="docs-table">
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export const Tag = ({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "warning"; children: ReactNode }) => (
  <span className={`docs-tag docs-tag-${tone}`}>{children}</span>
);

export function CopyValue({ value, href, label = "value" }: { value: string; href?: string; label?: string }) {
  return (
    <span className="docs-copyvalue">
      <code>{value}</code>
      <CopyButton value={value} label={`Copy ${label}`} />
      {href && <a className="docs-link" href={href} target="_blank" rel="noopener noreferrer">view<span className="docs-sr">(opens in a new tab)</span></a>}
    </span>
  );
}
