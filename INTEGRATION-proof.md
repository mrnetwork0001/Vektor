# Wiring the proof page

Page: `/proof.html?account=<account_id>&bps=10` (or `?address=<wallet>&chain=ethereum`; add `&net=testnet` for testnet).

## App header link (src/components/quant/VektorHeader.tsx)

Inside `.vk-telemetry`, before the PANIC button - the account id comes from `connectedInfo.accountId` in App, so pass it as a prop (`accountId?: string`):

```tsx
<a className="btn" href={`/proof.html?account=${encodeURIComponent(accountId ?? "")}&bps=${v.fees.builderFeeBps}`} target="_blank" rel="noopener" title="Public, verifiable proof of this account's Vektor activity">Proof ↗</a>
```

and in App.tsx: `<VektorHeader … accountId={connectedInfo?.accountId} />`.

## Landing page (index.html)

Add to the features grid or FAQ:

```html
<div class="card"><div class="ic g">✓</div><h3>Verifiable, not claimed</h3><p>Every fill Vektor makes is tagged. The <a href="/proof.html">public proof page</a> re-reads them from Strike's history API in <em>your</em> browser and prints the curl commands so you can check the numbers yourself.</p></div>
```

## README

```md
## Verify it yourself
`/proof.html?account=<strike account_id>` re-reads the account's fills, funding and positions from Strike's **public** history selectors (`account_id` / `blockchain_address`, no auth) in the viewer's browser, attributes them by Vektor's client-ID prefixes, and prints the exact curl commands used.
```
