/**
 * Minimal CBOR tooling to add a CIP-30 witness set to an unsigned Cardano
 * transaction without touching the transaction body bytes (the body hash is
 * what the wallet signed, so the body must stay byte-identical).
 *
 * A Cardano transaction is CBOR `[body, witness_set, is_valid, auxiliary_data]`.
 * We locate the byte range of each top-level element, decode only the witness
 * set maps (ours and the wallet's), merge them (vkey witnesses under key 0 are
 * concatenated, Conway `tag 258` set wrappers preserved), re-encode just that
 * element and splice it back.
 */

export type CborValue =
  | number | bigint | string | boolean | null | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | { tag: number; value: CborValue };

const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));
const bytesToHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// ── Decoder (returns value + bytes consumed) ──
function readLen(b: Uint8Array, i: number): { val: number | bigint; next: number; indef: boolean } {
  const info = b[i] & 0x1f;
  if (info < 24) return { val: info, next: i + 1, indef: false };
  if (info === 24) return { val: b[i + 1], next: i + 2, indef: false };
  if (info === 25) return { val: (b[i + 1] << 8) | b[i + 2], next: i + 3, indef: false };
  if (info === 26) return { val: ((b[i + 1] << 24) >>> 0) + (b[i + 2] << 16) + (b[i + 3] << 8) + b[i + 4], next: i + 5, indef: false };
  if (info === 27) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(b[i + 1 + k]); return { val: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, next: i + 9, indef: false }; }
  if (info === 31) return { val: -1, next: i + 1, indef: true };
  throw new Error(`unsupported CBOR additional info ${info}`);
}

export function decode(b: Uint8Array, i = 0): { value: CborValue; next: number } {
  const major = b[i] >> 5;
  const { val, next, indef } = readLen(b, i);
  switch (major) {
    case 0: return { value: val, next };
    case 1: return { value: typeof val === "bigint" ? -1n - val : -1 - (val as number), next };
    case 2: {
      if (indef) { const parts: Uint8Array[] = []; let p = next; while (b[p] !== 0xff) { const r = decode(b, p); parts.push(r.value as Uint8Array); p = r.next; } const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return { value: out, next: p + 1 }; }
      const n = Number(val); return { value: b.slice(next, next + n), next: next + n };
    }
    case 3: {
      if (indef) { let s = ""; let p = next; while (b[p] !== 0xff) { const r = decode(b, p); s += r.value as string; p = r.next; } return { value: s, next: p + 1 }; }
      const n = Number(val); return { value: new TextDecoder().decode(b.slice(next, next + n)), next: next + n };
    }
    case 4: {
      const arr: CborValue[] = []; let p = next;
      if (indef) { while (b[p] !== 0xff) { const r = decode(b, p); arr.push(r.value); p = r.next; } return { value: arr, next: p + 1 }; }
      for (let k = 0; k < Number(val); k++) { const r = decode(b, p); arr.push(r.value); p = r.next; }
      return { value: arr, next: p };
    }
    case 5: {
      const m = new Map<CborValue, CborValue>(); let p = next;
      const one = () => { const k = decode(b, p); const v = decode(b, k.next); m.set(k.value, v.value); p = v.next; };
      if (indef) { while (b[p] !== 0xff) one(); return { value: m, next: p + 1 }; }
      for (let k = 0; k < Number(val); k++) one();
      return { value: m, next: p };
    }
    case 6: { const r = decode(b, next); return { value: { tag: Number(val), value: r.value }, next: r.next }; }
    case 7: {
      const info = b[i] & 0x1f;
      if (info === 20) return { value: false, next: i + 1 };
      if (info === 21) return { value: true, next: i + 1 };
      if (info === 22) return { value: null, next: i + 1 };
      if (info === 23) return { value: undefined, next: i + 1 };
      throw new Error(`unsupported simple/float ${info}`);
    }
  }
  throw new Error("bad CBOR");
}

// ── Encoder (definite lengths) ──
function encHead(major: number, n: number | bigint): number[] {
  const m = major << 5;
  if (typeof n === "bigint" || n > 0xffffffff) { const v = BigInt(n); const out = [m | 27]; for (let k = 7; k >= 0; k--) out.push(Number((v >> BigInt(k * 8)) & 0xffn)); return out; }
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
export function encode(v: CborValue): Uint8Array {
  const out: number[] = [];
  const push = (x: Uint8Array | number[]) => { for (const y of x) out.push(y); };
  const go = (x: CborValue) => {
    if (x === false) return out.push(0xf4);
    if (x === true) return out.push(0xf5);
    if (x === null) return out.push(0xf6);
    if (x === undefined) return out.push(0xf7);
    if (typeof x === "number" || typeof x === "bigint") { const neg = x < 0; const mag = neg ? (typeof x === "bigint" ? -1n - x : -1 - x) : x; return push(encHead(neg ? 1 : 0, mag)); }
    if (typeof x === "string") { const s = new TextEncoder().encode(x); push(encHead(3, s.length)); return push(s); }
    if (x instanceof Uint8Array) { push(encHead(2, x.length)); return push(x); }
    if (Array.isArray(x)) { push(encHead(4, x.length)); for (const y of x) go(y); return; }
    if (x instanceof Map) { push(encHead(5, x.size)); for (const [k, y] of x) { go(k); go(y); } return; }
    if (typeof x === "object" && "tag" in x) { push(encHead(6, x.tag)); return go(x.value); }
    throw new Error("unsupported value");
  };
  go(v);
  return Uint8Array.from(out);
}

/** Byte ranges of the 4 top-level elements of a transaction array. */
function txElements(b: Uint8Array): { start: number; ranges: [number, number][]; end: number; indef: boolean } {
  if (b[0] >> 5 !== 4) throw new Error("transaction is not a CBOR array");
  const { val, next, indef } = readLen(b, 0);
  const ranges: [number, number][] = []; let p = next;
  const count = indef ? Infinity : Number(val);
  for (let k = 0; k < count; k++) { if (indef && b[p] === 0xff) break; const r = decode(b, p); ranges.push([p, r.next]); p = r.next; }
  return { start: next, ranges, end: indef ? p + 1 : p, indef };
}

const asList = (v: CborValue | undefined): { items: CborValue[]; tag?: number } => {
  if (!v) return { items: [] };
  if (typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Uint8Array) && "tag" in v) return { items: (v.value as CborValue[]) ?? [], tag: v.tag };
  return { items: (v as CborValue[]) ?? [] };
};

/** Merge two witness sets: list-valued keys (0 vkey, 1 native, 3 plutus, …) are concatenated and de-duplicated; others prefer the wallet's. */
export function mergeWitnessSets(base: Map<CborValue, CborValue>, extra: Map<CborValue, CborValue>): Map<CborValue, CborValue> {
  const out = new Map<CborValue, CborValue>(base);
  for (const [k, v] of extra) {
    const cur = out.get(k);
    const a = asList(cur), b = asList(v);
    if (Array.isArray(a.items) && Array.isArray(b.items) && (cur === undefined || Array.isArray(cur) || (typeof cur === "object" && cur !== null && "tag" in (cur as object)))) {
      const seen = new Set(a.items.map((x) => bytesToHex(encode(x))));
      const merged = [...a.items, ...b.items.filter((x) => !seen.has(bytesToHex(encode(x))))];
      const tag = a.tag ?? b.tag;
      out.set(k, tag !== undefined ? { tag, value: merged } : merged);
    } else out.set(k, v);
  }
  return out;
}

/** Add the wallet's CIP-30 witness set (hex) to an unsigned transaction (hex); body bytes untouched. */
export function addWitnessSet(unsignedTxHex: string, witnessSetHex: string): string {
  const tx = hexToBytes(unsignedTxHex);
  const { ranges, end, indef } = txElements(tx);
  if (ranges.length < 2) throw new Error("transaction has no witness set element");
  const ours = decode(tx, ranges[1][0]).value as Map<CborValue, CborValue>;
  const theirs = decode(hexToBytes(witnessSetHex)).value as Map<CborValue, CborValue>;
  if (!(ours instanceof Map) || !(theirs instanceof Map)) throw new Error("witness set is not a CBOR map");
  const merged = encode(mergeWitnessSets(ours, theirs));
  const [ws, we] = ranges[1];
  const head = tx.slice(0, ws), tail = tx.slice(we, indef ? end : end);
  const out = new Uint8Array(head.length + merged.length + tail.length);
  out.set(head, 0); out.set(merged, head.length); out.set(tail, head.length + merged.length);
  return bytesToHex(out);
}
