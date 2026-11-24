// ── GCS-backed R2 shim: mimics Cloudflare R2Bucket used in worker/routes/files.ts ──

import { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';

export interface R2GetResult {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  httpEtag?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class GcsR2 {
  constructor(private storage: Storage, private bucketName: string) {}

  async put(
    key: string,
    data: ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<void> {
    const buf =
      data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);

    await this.storage.bucket(this.bucketName).file(key).save(buf, {
      contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream',
      metadata: opts?.customMetadata ? { metadata: opts.customMetadata } : undefined,
      resumable: false,
    });
  }

  async get(key: string): Promise<R2GetResult | null> {
    try {
      const file = this.storage.bucket(this.bucketName).file(key);
      const [meta] = await file.getMetadata();

      // Stream file downloads instead of buffering entire blobs into Node RAM
      const webStream = Readable.toWeb(file.createReadStream()) as unknown as ReadableStream;

      return {
        body: webStream,
        httpMetadata: { contentType: (meta.contentType as string) ?? 'application/octet-stream' },
        httpEtag: meta.etag as string | undefined,
        async arrayBuffer() {
          const [buf] = await file.download();
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        },
      };
    } catch (e: any) {
      if (e?.code === 404) return null;
      console.error(`[r2] get ${key} failed`, e);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.storage.bucket(this.bucketName).file(key).delete({ ignoreNotFound: true });
    } catch {
      /* ignore */
    }
  }
}
