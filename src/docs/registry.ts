// Single source of truth for the docs table of contents. The sidebar, the phone
// picker, prev/next links, page metadata and the prerender script all read this.

export interface DocPage { slug: string; title: string; nav?: string; description: string }
export interface DocGroup { label: string; pages: DocPage[] }

export const DOCS_GROUPS: DocGroup[] = [
  {
    label: "Getting started",
    pages: [
      { slug: "", title: "Welcome to Vektor", nav: "Welcome", description: "What Vektor is, what it does on Strike Finance, and where to go next." },
      { slug: "how-it-works", title: "How it works", description: "The path from a wallet signature to a grid that refills itself on Strike's order book." },
      { slug: "quick-start", title: "Quick start", description: "See every engine work in about two minutes, with no wallet and no sign-up." },
    ],
  },
  {
    label: "Using the app",
    pages: [
      { slug: "grid-studio", title: "Grid Studio", description: "Design, deploy and run a grid of limit orders that pays the builder fee on every fill." },
      { slug: "backtest", title: "Backtest and smart range", nav: "Backtest & smart range", description: "Replay a grid over real mainnet candles before you deploy it, and size a range from volatility." },
      { slug: "funding-harvester", title: "Funding Harvester", description: "Rank markets by hourly funding and open a hedge that collects it without price exposure." },
      { slug: "aegis-shield", title: "Aegis Shield", description: "Watch distance to liquidation on every position and act before Strike's engine does." },
      { slug: "regime-guard", title: "Regime guard", description: "Widen or pause grids automatically when market conditions turn extreme." },
      { slug: "l3-radar", title: "L3 radar", description: "Spot spoofed walls and icebergs on Strike's order-level feed." },
      { slug: "deposits", title: "Deposits and sign-in", nav: "Deposits & sign-in", description: "Connect a Cardano, Solana or Ethereum wallet, or sign in with API keys, and fund your account in the app." },
      { slug: "proof", title: "Proof page", description: "Let anyone re-check your fills and builder revenue against Strike's public API." },
    ],
  },
  {
    label: "For owners and power users",
    pages: [
      { slug: "user-guide", title: "User guide", description: "Set up from scratch and learn what every status, log line and button means." },
      { slug: "faq", title: "FAQ", description: "Answers to the problems people actually hit while running Vektor on mainnet." },
    ],
  },
  {
    label: "Tech",
    pages: [
      { slug: "architecture", title: "Architecture", description: "Pure engines, one adapter seam, two backends: how the code is organised." },
      { slug: "strike-api", title: "Strike API and endpoints", nav: "Strike API & endpoints", description: "Every Strike endpoint and stream Vektor uses, and which of them honour the builder fee." },
      { slug: "worker-cli", title: "Worker, CLI and agent skill", nav: "Worker, CLI & skill", description: "Run the same engines headless, from a terminal, or from an AI agent." },
      { slug: "self-hosting", title: "Environment and self-hosting", nav: "Environment & hosting", description: "Environment variables, build, and deploying the static site and the relay." },
    ],
  },
  {
    label: "Trust",
    pages: [
      { slug: "real-vs-simulated", title: "Real vs simulated", description: "Exactly what has run on mainnet with real money, and what has only run in the simulator." },
      { slug: "security", title: "Security model and limits", description: "Where keys live, what they can do, and the known limits." },
    ],
  },
];

export const DOCS_FLAT: DocPage[] = DOCS_GROUPS.flatMap((g) => g.pages);

export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");
export const docEntry = (slug: string): DocPage | undefined => DOCS_FLAT.find((p) => p.slug === slug);
export const docGroupOf = (slug: string): DocGroup | undefined => DOCS_GROUPS.find((g) => g.pages.some((p) => p.slug === slug));
export function docNeighbours(slug: string): { prev?: DocPage; next?: DocPage } {
  const i = DOCS_FLAT.findIndex((p) => p.slug === slug);
  if (i < 0) return {};
  return { prev: DOCS_FLAT[i - 1], next: DOCS_FLAT[i + 1] };
}

/** "/docs/quick-start/" → "quick-start"; "/docs" → "". */
export function slugFromPath(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(/^\/docs\/?/, "").replace(/\.html$/, "").replace(/^index$/, "");
}
