import type { DocContent } from "../DocsFrame";
import { welcome, howItWorks, quickStart } from "./getting-started";
import { gridStudio, backtest, fundingHarvester, aegisShield, regimeGuard, l3Radar, deposits, proof } from "./using";
import { userGuide, faq } from "./owners";
import { architecture, strikeApi, workerCli, selfHosting } from "./tech";
import { realVsSimulated, security } from "./trust";

export const DOCS_CONTENT: Record<string, DocContent> = {
  "": welcome, "how-it-works": howItWorks, "quick-start": quickStart,
  "grid-studio": gridStudio, backtest, "funding-harvester": fundingHarvester, "aegis-shield": aegisShield,
  "regime-guard": regimeGuard, "l3-radar": l3Radar, deposits, proof,
  "user-guide": userGuide, faq,
  architecture, "strike-api": strikeApi, "worker-cli": workerCli, "self-hosting": selfHosting,
  "real-vs-simulated": realVsSimulated, security,
};
