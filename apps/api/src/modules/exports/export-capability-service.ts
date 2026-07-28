import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export interface ExportCapabilityProjection {
  requestId: string;
  objectKeyHash: string;
  downloadUrl: string;
  expiresAt: string;
  encryptedArchiveKey: string;
  archiveSizeBytes: number;
  browserKeyId: string | null;
  keyWrapVersion: 1;
}

export interface BrowserKeyEnvelope {
  version: 1;
  requestId: string;
  browserKeyId: string;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  expiresAt: string;
}

export class ExportCapabilityError extends Error {
  constructor(
    readonly code:
      | "EXPORT_CAPABILITY_NOT_FOUND"
      | "EXPORT_CAPABILITY_EXPIRED"
      | "EXPORT_KEY_INVALID"
      | "BROWSER_KEY_INVALID",
  ) {
    super(code);
    this.name = "ExportCapabilityError";
  }
}

export class ExportCapabilityService {
  private readonly capabilities = new Map<
    string,
    ExportCapabilityProjection & { encryptedKeyBytes: Buffer }
  >();

  constructor(
    private readonly localKey: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (localKey.byteLength !== 32) {
      throw new TypeError("Export capability local key must be 32 bytes");
    }
  }

  createCapability(input: {
    requestId: string;
    objectKey: string;
    downloadUrl: string;
    archiveKey: Uint8Array;
    archiveSizeBytes: number;
    expiresAt: Date;
  }): ExportCapabilityProjection {
    if (input.archiveKey.byteLength !== 32 || input.expiresAt <= this.now()) {
      throw new ExportCapabilityError("EXPORT_KEY_INVALID");
    }
    const encryptedKeyBytes = encryptLocal(
      this.localKey,
      Buffer.from(input.archiveKey),
    );
    const projection: ExportCapabilityProjection = {
      requestId: input.requestId,
      objectKeyHash: `sha256:${createHash("sha256").update(input.objectKey).digest("hex")}`,
      downloadUrl: input.downloadUrl,
      expiresAt: input.expiresAt.toISOString(),
      encryptedArchiveKey: encryptedKeyBytes.toString("base64url"),
      archiveSizeBytes: input.archiveSizeBytes,
      browserKeyId: null,
      keyWrapVersion: 1,
    };
    this.capabilities.set(input.requestId, {
      ...projection,
      encryptedKeyBytes,
    });
    return projection;
  }

  get(requestId: string): ExportCapabilityProjection {
    const capability = this.requireActive(requestId);
    return {
      requestId: capability.requestId,
      objectKeyHash: capability.objectKeyHash,
      downloadUrl: capability.downloadUrl,
      expiresAt: capability.expiresAt,
      encryptedArchiveKey: capability.encryptedArchiveKey,
      archiveSizeBytes: capability.archiveSizeBytes,
      browserKeyId: capability.browserKeyId,
      keyWrapVersion: 1,
    };
  }

  wrapForBrowser(input: {
    requestId: string;
    browserKeyId: string;
    browserPublicKey: string;
  }): BrowserKeyEnvelope {
    const capability = this.requireActive(input.requestId);
    const archiveKey = decryptLocal(
      this.localKey,
      capability.encryptedKeyBytes,
    );
    const recipient = rawX25519PublicKey(input.browserPublicKey);
    const ephemeral = generateKeyPairSync("x25519");
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: recipient,
    });
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(shared).digest(),
      nonce,
    );
    cipher.setAAD(
      Buffer.from(`forgetops.export-key-wrap.v1\0${input.requestId}`),
    );
    const ciphertext = Buffer.concat([
      cipher.update(archiveKey),
      cipher.final(),
    ]);
    const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
    const ephemeralPublicKey = ephemeral.publicKey.export({
      format: "jwk",
    }).x;
    if (!ephemeralPublicKey) {
      throw new ExportCapabilityError("BROWSER_KEY_INVALID");
    }
    capability.browserKeyId = input.browserKeyId;
    return {
      version: 1,
      requestId: input.requestId,
      browserKeyId: input.browserKeyId,
      ephemeralPublicKey,
      nonce: nonce.toString("base64url"),
      ciphertext: sealed.toString("base64url"),
      expiresAt: capability.expiresAt,
    };
  }

  private requireActive(
    requestId: string,
  ): ExportCapabilityProjection & { encryptedKeyBytes: Buffer } {
    const capability = this.capabilities.get(requestId);
    if (!capability) {
      throw new ExportCapabilityError("EXPORT_CAPABILITY_NOT_FOUND");
    }
    if (Date.parse(capability.expiresAt) <= this.now().getTime()) {
      throw new ExportCapabilityError("EXPORT_CAPABILITY_EXPIRED");
    }
    return capability;
  }
}

function encryptLocal(key: Uint8Array, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptLocal(key: Uint8Array, encoded: Buffer): Buffer {
  if (encoded.length < 28)
    throw new ExportCapabilityError("EXPORT_KEY_INVALID");
  const nonce = encoded.subarray(0, 12);
  const tag = encoded.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encoded.subarray(28)),
    decipher.final(),
  ]);
}

function rawX25519PublicKey(value: string): KeyObject {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
      throw new Error("non-canonical key");
    }
    return createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        bytes,
      ]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new ExportCapabilityError("BROWSER_KEY_INVALID");
  }
}
