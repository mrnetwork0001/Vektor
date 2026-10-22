import { describe, it, expect } from "vitest";
import { lovelaceFromCborValue, getSpotBalance } from "../spotBalance";

describe("spot balance", () => {
  it("decodes CIP-30 Value CBOR (plain uint and [coin, multiasset])", () => {
    expect(lovelaceFromCborValue("1a05f5e100")).toBe(100_000_000); // uint32 → 100 ADA
    expect(lovelaceFromCborValue("821a05f5e100a0")).toBe(100_000_000); // [coin, {}]
    expect(lovelaceFromCborValue("1b00000002540be400")).toBe(10_000_000_000); // uint64
    expect(lovelaceFromCborValue("05")).toBe(5);
  });
  it("reads ETH via the injected provider", async () => {
    const api = { request: async ({ method }: any) => (method === "eth_getBalance" ? "0x" + (2n * 10n ** 18n).toString(16) : null) };
    const b = await getSpotBalance({ chain: "ethereum", walletId: "rabby", address: "0xabc", api });
    expect(b).toMatchObject({ asset: "ETH", qty: 2 });
  });
});
