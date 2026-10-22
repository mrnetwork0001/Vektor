/**
 * Tenant registry: one record per enrolled API wallet, private key encrypted
 * with AES-256-GCM under VEKTOR_MASTER_KEY. Per-tenant engine state lives in
 * separate files next to it. All writes are atomic (temp file + rename).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Sealed { iv: string; tag: string; data: string }
export interface TenantRecord {
  publicKey: string;
  accountId: string;
  builderCode?: string;
  feeShareBps?: number; // approval cap the user signed at Builder Connect (Strike enforces it too)
  key: Sealed; // encrypted private key
  createdAt: number;
}

export function parseMasterKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("VEKTOR_MASTER_KEY must be 64 hex chars (32 bytes). Generate one with: openssl rand -hex 32");
  return Buffer.from(hex, "hex");
}

export function seal(master: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", master, iv);
  const data = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex") };
}

export function unseal(master: Buffer, s: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", master, Buffer.from(s.iv, "hex"));
  d.setAuthTag(Buffer.from(s.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(s.data, "hex")), d.final()]).toString("utf8");
}

export function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export class TenantStore {
  private tenants = new Map<string, TenantRecord>();
  constructor(public path: string, private master: Buffer) {
    if (existsSync(path)) {
      const rows: TenantRecord[] = JSON.parse(readFileSync(path, "utf8"));
      for (const r of rows) this.tenants.set(r.publicKey, r);
    }
  }
  get size() { return this.tenants.size; }
  list(): TenantRecord[] { return [...this.tenants.values()]; }
  get(pub: string): TenantRecord | undefined { return this.tenants.get(pub); }
  privateKey(pub: string): string { const r = this.tenants.get(pub); if (!r) throw new Error("unknown tenant"); return unseal(this.master, r.key); }
  upsert(rec: Omit<TenantRecord, "key" | "createdAt"> & { privateKey: string }) {
    const { privateKey, ...rest } = rec;
    const prev = this.tenants.get(rec.publicKey);
    this.tenants.set(rec.publicKey, { ...rest, key: seal(this.master, privateKey), createdAt: prev?.createdAt ?? Date.now() });
    this.save();
  }
  remove(pub: string) {
    this.tenants.delete(pub);
    this.save();
    const st = this.statePath(pub);
    if (existsSync(st)) unlinkSync(st);
  }
  statePath(pub: string) { return join(dirname(this.path), `state-${pub.slice(0, 16)}.json`); }
  private save() { atomicWrite(this.path, JSON.stringify(this.list(), null, 1)); }
}
