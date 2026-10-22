// Prerender every docs page into dist/docs/<slug>/index.html (and dist/docs/404.html)
// using the built docs.html as the template. Run after `vite build`.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocsApp } from "../src/docs/DocsApp";
import { DOCS_FLAT } from "../src/docs/registry";

const dist = join(process.cwd(), "dist");
const template = readFileSync(join(dist, "docs.html"), "utf8");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function page(slug: string, title: string, description: string) {
  const html = renderToString(createElement(DocsApp, { slug }));
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(description)}" />`)
    .replace('<div id="root"></div>', `<div id="root">${html}</div>`);
}

let n = 0;
for (const p of DOCS_FLAT) {
  const dir = p.slug ? join(dist, "docs", p.slug) : join(dist, "docs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(p.slug, `${p.title} · Vektor Docs`, p.description));
  n++;
}
writeFileSync(join(dist, "docs", "404.html"), page("__not_found__", "Page not found · Vektor Docs", "This docs page does not exist."));
rmSync(join(dist, "docs.html"));
console.log(`prerendered ${n} docs pages + 404`);
