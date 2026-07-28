import { createHash } from "node:crypto";

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

export class ExportCapabilityError extends Error {
  constructor(
    readonly code:
      | "EXPORT_CAPABILITY_NOT_FOUND"
      | "EXPORT_CAPABILITY_EXPIRED"
      | "EXPORT_KEY_INVALID",
  ) {
    super(code);
    this.name = "ExportCapabilityError";
  }
}

export class ExportCapabilityService {
  private readonly capabilities = new Map<string, ExportCapabilityProjection>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  createCapability(input: {
    requestId: string;
    objectKey: string;
    downloadUrl: string;
    encryptedArchiveKey: string;
    archiveSizeBytes: number;
    browserKeyId: string;
    keyWrapVersion: 1;
    expiresAt: Date;
  }): ExportCapabilityProjection {
    if (
      input.encryptedArchiveKey.length === 0 ||
      input.browserKeyId.length === 0 ||
      input.keyWrapVersion !== 1 ||
      input.expiresAt <= this.now()
    ) {
      throw new ExportCapabilityError("EXPORT_KEY_INVALID");
    }
    const projection: ExportCapabilityProjection = {
      requestId: input.requestId,
      objectKeyHash: `sha256:${createHash("sha256").update(input.objectKey).digest("hex")}`,
      downloadUrl: input.downloadUrl,
      expiresAt: input.expiresAt.toISOString(),
      encryptedArchiveKey: input.encryptedArchiveKey,
      archiveSizeBytes: input.archiveSizeBytes,
      browserKeyId: input.browserKeyId,
      keyWrapVersion: input.keyWrapVersion,
    };
    this.capabilities.set(input.requestId, projection);
    return projection;
  }

  get(requestId: string): ExportCapabilityProjection {
    const capability = this.requireActive(requestId);
    return { ...capability };
  }

  private requireActive(requestId: string): ExportCapabilityProjection {
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
