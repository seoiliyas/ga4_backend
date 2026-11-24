// ── GCS-backed KV shim: mimics Cloudflare KVNamespace on Cloud Run ────────────

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '@google-cloud/storage';

const mem = new Map<string, { value: string; expiresAt: number }>();

export function resolveLocalContainerPath(): string | null {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/container-minified.json'),
    path.resolve(process.cwd(), '../data/container-minified.json'),
    path.resolve(process.cwd(), 'data/container-minified.json'),
    '/app/data/container-minified.json',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class GcsKv {
  private bucketName: string;
  private storage: Storage;
  private localContainerFallbackPath: string | null;

  constructor(
    storage: Storage,
    bucketName: string,
    localContainerFallbackPath: string | null = resolveLocalContainerPath(),
  ) {
    this.storage = storage;
    this.bucketName = bucketName;
    this.localContainerFallbackPath = localContainerFallbackPath;
  }

  private keyToFile(key: string): string {
    if (key === 'container') return 'container.json';
    if (key === 'gemini_gtm_context_cache') return 'gemini-cache-name.txt';
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `kv/${safeKey}`;
  }

  private async loadLocalFallback(): Promise<string | null> {
    if (!this.localContainerFallbackPath || !existsSync(this.localContainerFallbackPath)) {
      return null;
    }
    try {
      const value = await readFile(this.localContainerFallbackPath, 'utf-8');
      console.warn(
        `[kv] Using bundled container fallback from ${this.localContainerFallbackPath}`,
      );
      return value;
    } catch (err) {
      console.error('[kv] Failed reading local container fallback:', err);
      return null;
    }
  }

  async get(key: string, opts?: { cacheTtl?: number }): Promise<string | null> {
    const m = mem.get(key);
    if (m && Date.now() < m.expiresAt) return m.value;
    if (m) mem.delete(key);

    let value: string | null = null;
    try {
      const file = this.storage.bucket(this.bucketName).file(this.keyToFile(key));
      const [exists] = await file.exists();
      if (exists) {
        const [buf] = await file.download();
        value = buf.toString('utf-8');
      }
    } catch (e) {
      console.error(`[kv] get ${key} failed`, e);
    }

    if (value === null && key === 'container') {
      value = await this.loadLocalFallback();
    }

    if (value !== null && opts?.cacheTtl && opts.cacheTtl > 0) {
      mem.set(key, { value, expiresAt: Date.now() + opts.cacheTtl * 1000 });
    }
    return value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl && opts.expirationTtl > 0) {
      mem.set(key, { value, expiresAt: Date.now() + opts.expirationTtl * 1000 });
    } else {
      mem.delete(key);
    }

    // ga4_property:* is legacy — skip persisting
    if (key.startsWith('ga4_property:')) return;

    try {
      const file = this.storage.bucket(this.bucketName).file(this.keyToFile(key));
      await file.save(value, { contentType: 'application/json', resumable: false });
    } catch (e) {
      console.error(`[kv] put ${key} failed`, e);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    mem.delete(key);
    if (key.startsWith('ga4_property:')) return;
    try {
      await this.storage
        .bucket(this.bucketName)
        .file(this.keyToFile(key))
        .delete({ ignoreNotFound: true });
    } catch {
      /* ignore */
    }
  }
}
