import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import canonicalize from "canonicalize";

const SIGNATURE_DOMAIN = "forgetops.adapter-request.v1";
export const ADAPTER_ACCEPTANCE_WINDOW_MS = 60_000;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export interface AdapterSignatureInput {
  secret: Uint8Array;
  method: string;
  normalizedPath: string;
  timestamp: string;
  nonce: string;
  contentType: string;
  body: Uint8Array;
}

export interface NonceStore {
  consume(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

export function signAdapterRequest(input: AdapterSignatureInput): string {
  return createHmac("sha256", input.secret)
    .update(signatureMaterial(input))
    .digest("base64url");
}

export function verifyAdapterSignature(
  input: AdapterSignatureInput & { signature: string; nowMs?: number },
): boolean {
  if (
    input.secret.byteLength < 32 ||
    input.method !== input.method.toUpperCase() ||
    !input.normalizedPath.startsWith("/") ||
    !RFC3339_UTC.test(input.timestamp) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)
  ) {
    return false;
  }
  const timestampMs = Date.parse(input.timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs((input.nowMs ?? Date.now()) - timestampMs) >
      ADAPTER_ACCEPTANCE_WINDOW_MS
  ) {
    return false;
  }
  const received = decodeBase64Url(input.signature);
  const expected = createHmac("sha256", input.secret)
    .update(signatureMaterial(input))
    .digest();
  return (
    received?.byteLength === expected.byteLength &&
    timingSafeEqual(expected, received)
  );
}

export class MemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();

  async consume(
    nonce: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    for (const [value, expiry] of this.nonces) {
      if (expiry < nowMs) this.nonces.delete(value);
    }
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }
}

export class FileNonceStore implements NonceStore {
  private loaded = false;
  private readonly nonces = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  consume(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const operation = this.queue.then(() =>
      this.consumeExclusive(nonce, expiresAtMs, nowMs),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async consumeExclusive(
    nonce: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    await this.load();
    for (const [value, expiry] of this.nonces) {
      if (expiry < nowMs) this.nonces.delete(value);
    }
    if (this.nonces.has(nonce)) return false;

    await mkdir(dirname(this.filePath), { recursive: true });
    const file = await open(this.filePath, "a", 0o600);
    try {
      await file.appendFile(`${JSON.stringify({ nonce, expiresAtMs })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let contents = "";
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of contents.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as unknown;
      if (
        !record ||
        typeof record !== "object" ||
        typeof (record as { nonce?: unknown }).nonce !== "string" ||
        !Number.isFinite((record as { expiresAtMs?: unknown }).expiresAtMs)
      ) {
        throw new Error("ADAPTER_NONCE_STORE_CORRUPT");
      }
      this.nonces.set(
        (record as { nonce: string }).nonce,
        (record as { expiresAtMs: number }).expiresAtMs,
      );
    }
    this.loaded = true;
  }
}

function signatureMaterial(input: AdapterSignatureInput): Buffer {
  const canonicalEnvelope = canonicalize({
    bodyDigest: `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
    contentType: input.contentType,
    method: input.method,
    nonce: input.nonce,
    path: input.normalizedPath,
    timestamp: input.timestamp,
    type: "forgetops.adapter-request",
    version: 1,
  });
  if (canonicalEnvelope === undefined) {
    throw new Error("ADAPTER_SIGNATURE_CANONICALIZATION_FAILED");
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE_DOMAIN, "utf8"),
    Buffer.from([0]),
    Buffer.from(canonicalEnvelope, "utf8"),
  ]);
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}
