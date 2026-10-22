import { createRoot, hydrateRoot } from "react-dom/client";
import "../styles/index.css";
import "../styles/theme.css";
import "./docs.css";
import { DocsApp } from "./DocsApp";
import { docEntry, slugFromPath } from "./registry";

const slug = slugFromPath(window.location.pathname);
const page = docEntry(slug);
document.title = page ? `${page.title} · Vektor Docs` : "Page not found · Vektor Docs";
const root = document.getElementById("root")!;
const app = <DocsApp slug={slug} />;
if (root.hasChildNodes()) hydrateRoot(root, app); else createRoot(root).render(app);
