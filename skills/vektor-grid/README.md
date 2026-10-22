# vektor-grid skill

Teaches an AI coding agent (Claude Code, Cursor, Codex, Copilot, …) to plan, backtest, deploy, monitor and stop Vektor grids on Strike Finance through the CLI and the worker's status endpoint. Same layout as the official `strike-finance-skills`.

## Install

The skill is a single `SKILL.md`; copy or symlink the folder into your agent's skills directory and run the agent from the Vektor repo root (the CLI is invoked as `npx tsx cli/vektor.ts`).

| Agent | Destination |
|---|---|
| Claude Code (project) | `.claude/skills/vektor-grid/SKILL.md` |
| Claude Code (global) | `~/.claude/skills/vektor-grid/SKILL.md` |
| Cursor | `.cursor/rules/vektor-grid.md` (paste the body) |
| Codex | `.codex/skills/vektor-grid/SKILL.md` |
| Copilot | `.github/copilot-instructions.md` (append the body) |

```bash
mkdir -p .claude/skills && ln -s "$(pwd)/skills/vektor-grid" .claude/skills/vektor-grid
```

Then ask the agent things like *"size a 3% grid on ADA-USD, backtest it over 7 days, and deploy it if net is positive"* — it will call the CLI with `--json` and reason over the results.

## Requirements

- Node 22+ (`npx tsx` is a dev dependency of the repo).
- Public commands need nothing. `deploy` and `fills` need `STRIKE_API_PUBLIC_KEY` / `STRIKE_API_PRIVATE_KEY` (https://app.strikefinance.org/api-keys) and a builder code registered on mainnet (https://app.strikefinance.org/builder-codes). `status` / `stop` / `panic` need `npm run worker` running.
