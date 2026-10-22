import { describe, it, expect } from "vitest";
import { addWitnessSet, decode, encode, mergeWitnessSets, type CborValue } from "../cardanoTx";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("cardano witness merge", () => {
  it("round-trips CBOR values", () => {
    const v: CborValue = new Map<CborValue, CborValue>([[0, [[bytes(32, 1), bytes(64, 2)]]], [1, { tag: 258, value: [bytes(3, 9)] }], [5, "x"], [7, -5], [8, true]]);
    const d = decode(encode(v)).value;
    expect(hex(encode(d))).toBe(hex(encode(v)));
  });

  it("splices the wallet witness set in without changing the body bytes", () => {
    const body = new Map<CborValue, CborValue>([[0, [[bytes(32, 7), 0]]], [2, 170000]]);
    const unsigned = encode([body, new Map(), true, null]);
    const walletWs = encode(new Map<CborValue, CborValue>([[0, [[bytes(32, 0xaa), bytes(64, 0xbb)]]]]));
    const signed = addWitnessSet(hex(unsigned), hex(walletWs));
    const tx = decode(Uint8Array.from(signed.match(/.{2}/g)!.map((h) => parseInt(h, 16)))).value as CborValue[];
    expect(tx).toHaveLength(4);
    // body identical bytes
    expect(hex(encode(tx[0]))).toBe(hex(encode(body)));
    const ws = tx[1] as Map<CborValue, CborValue>;
    expect((ws.get(0) as CborValue[]).length).toBe(1);
    expect(tx[2]).toBe(true);
  });

  it("merges vkey witnesses with existing ones and keeps Conway set tags, de-duplicating", () => {
    const w1: CborValue = [bytes(32, 1), bytes(64, 1)];
    const w2: CborValue = [bytes(32, 2), bytes(64, 2)];
    const ours = new Map<CborValue, CborValue>([[0, { tag: 258, value: [w1] }]]);
    const theirs = new Map<CborValue, CborValue>([[0, [w1, w2]], [3, [bytes(4, 5)]]]);
    const m = mergeWitnessSets(ours, theirs);
    const k0 = m.get(0) as { tag: number; value: CborValue[] };
    expect(k0.tag).toBe(258);
    expect(k0.value).toHaveLength(2);
    expect(m.get(3)).toEqual([bytes(4, 5)]);
  });

  it("handles indefinite-length transaction arrays", () => {
    const body = encode(new Map<CborValue, CborValue>([[2, 1]]));
    const ws = encode(new Map());
    const unsigned = new Uint8Array([0x9f, ...body, ...ws, 0xf5, 0xf6, 0xff]); // indefinite array
    const signed = addWitnessSet(hex(unsigned), hex(encode(new Map<CborValue, CborValue>([[0, [[bytes(32, 3), bytes(64, 3)]]]]))));
    const tx = decode(Uint8Array.from(signed.match(/.{2}/g)!.map((h) => parseInt(h, 16)))).value as CborValue[];
    expect(tx).toHaveLength(4);
    expect(((tx[1] as Map<CborValue, CborValue>).get(0) as CborValue[]).length).toBe(1);
  });
});
