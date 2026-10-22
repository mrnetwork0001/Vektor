# CLI integration notes (apply by hand)

`cli/vektor.ts` and `skills/vektor-grid/` are self-contained. Suggested `package.json` additions:

```json
"scripts": {
  "cli": "tsx cli/vektor.ts"
},
"bin": {
  "vektor": "cli/vektor.ts"
}
```

With `"bin"` in place, `npm link` (or `npx vektor` after publishing) exposes the command as `vektor plan ADA-USD ...`; the file already has a `#!/usr/bin/env -S npx tsx` shebang (`chmod +x cli/vektor.ts` for the link to execute directly).

Optional README line under "Headless 24/7": `npm run cli -- status` / see `skills/vektor-grid/SKILL.md` for the agent workflow.

Files added: `cli/lib.ts` (pure parsing + formatting, tested), `cli/vektor.ts` (commands), `cli/__tests__/cli.test.ts`, `skills/vektor-grid/SKILL.md`, `skills/vektor-grid/README.md`.

`tsconfig.json` only includes `src/`, so `npm run build`'s `tsc` does not type-check `cli/` or `worker/`. Both run fine under `tsx` (verified), but to *type-check* them you need Node's type definitions, which the repo does not have: `npm i -D @types/node`, then add `"cli"` and `"worker"` to `"include"` (or run `npx tsc --noEmit --types node cli/vektor.ts worker/index.ts`). Without `@types/node`, `node:fs`, `process` and `Buffer` are unresolved in both the CLI and the pre-existing `worker/strikeClient.ts`. I did not add the dependency per the "no extra deps" rule.
