# Vektor Autopilot

Multi-tenant server that keeps each user's grids, counter orders and shield running after they close the browser.

## How it works
1. In the terminal (Live), the user ticks **Keep running when I close this tab (Autopilot)** and deploys.
2. The browser enrolls once: it sends this session's Strike API-wallet key pair plus an Ed25519 signature over `vektor-autopilot:enroll:<ts>:<publicKey>`. The server verifies the signature, checks the key against Strike (`GET /v2/account`), and stores the private key encrypted with AES-256-GCM under `VEKTOR_MASTER_KEY`.
3. Every later call is signed with the same key (`X-Vektor-Key`, `X-Vektor-Ts`, `X-Vektor-Sig` over `vektor-autopilot:<METHOD>:<PATH>:<ts>:<sha256(body)>`), must be under 120 s old, and can be used once.
4. Per tenant the server runs: user stream, grid counters with trade-id dedupe, reconcile/backfill/adopt on boot, watchdog, shield (2 s), regime guard, optional auto-shift. One shared mark-price stream and regime poller serve all tenants.

## Endpoints
| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public |
| POST | `/v1/enroll` | enroll signature |
| DELETE | `/v1/enroll` | signed - stops grids, wipes the key |
| GET | `/v1/status` | signed |
| POST | `/v1/grids` | signed - body: GridConfig minus markPrice, plus `autoShift`, `regimeGuard` |
| DELETE | `/v1/grids/:symbol` | signed |
| POST | `/v1/panic` | signed |

## Run
```bash
VEKTOR_MASTER_KEY=$(openssl rand -hex 32) VEKTOR_ALLOW_ORIGIN=https://your-app.vercel.app npm run autopilot
# pm2
VEKTOR_MASTER_KEY=... VEKTOR_ALLOW_ORIGIN=https://your-app.vercel.app pm2 start "npx tsx server/index.ts" --name vektor-autopilot --cwd /opt/vektor
```
Keep `VEKTOR_MASTER_KEY` safe and stable: losing it makes stored keys unreadable (users just re-enroll).

nginx (new site, HTTPS via certbot):
```nginx
server {
  server_name autopilot.example.com;
  location / { proxy_pass http://127.0.0.1:8920; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
}
```
Then set `VITE_AUTOPILOT_URL=https://autopilot.example.com` in Vercel.

## Security notes
- Keys are Strike API wallets: they can place and cancel orders, never withdraw.
- Stored encrypted at rest; never logged. Revoke by **Disable Autopilot** (wipes it) or a new Builder Connect (Strike revokes the old wallet).
- Binds to 127.0.0.1 by default; expose only through the reverse proxy. Set `VEKTOR_ALLOW_ORIGIN` to your app's origin.
- Tested: signature/replay checks, encryption round-trip, tenant store, engine deploy → fill → counter → dedupe → stop with a fake client. Not yet run against mainnet with a real enrolled tenant.
