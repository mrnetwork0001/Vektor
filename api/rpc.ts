// Vercel serverless function: same-origin JSON-RPC relay for Solana / Ethereum.
// Browsers get 403 from the public RPCs when the request carries an Origin header;
// this function forwards the body server-side with no browser headers.
const TARGETS: Record<string, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
};

export default async function handler(req: any, res: any) {
  const chain = String(req.query?.chain ?? "");
  const target = TARGETS[chain];
  if (!target) { res.status(404).json({ error: "unknown chain" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const text = await r.text();
    res.status(r.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? "relay failed" });
  }
}
