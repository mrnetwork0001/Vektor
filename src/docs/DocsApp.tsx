import { DocsFrame, DocsFooter, DocsHeader, DocsNotFound } from "./DocsFrame";
import { DOCS_CONTENT } from "./content";
import { docEntry } from "./registry";

export function DocsApp({ slug }: { slug: string }) {
  const content = docEntry(slug) ? DOCS_CONTENT[slug] : undefined;
  return (
    <div className="docs-root">
      <DocsHeader />
      {content ? <DocsFrame slug={slug} content={content} /> : <DocsNotFound />}
      <DocsFooter />
    </div>
  );
}
