import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExportCapabilityError,
  ExportCapabilityService,
} from "../src/modules/exports/export-capability-service.js";

describe("export capability delivery", () => {
  it("stores only an encrypted archive key and wraps it for a browser key", () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const service = new ExportCapabilityService(
      new Uint8Array(32).fill(4),
      () => now,
    );
    const capability = service.createCapability({
      requestId: "req_export",
      objectKey: "exports/req_export.bin",
      downloadUrl: "https://storage.example/download",
      archiveKey: new Uint8Array(32).fill(9),
      archiveSizeBytes: 128,
      expiresAt: new Date("2026-07-24T01:00:00.000Z"),
    });
    expect(capability.encryptedArchiveKey).not.toContain(
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
    );

    const browser = generateKeyPairSync("x25519");
    const browserPublicKey = browser.publicKey.export({ format: "jwk" }).x;
    expect(browserPublicKey).toBeTruthy();
    const envelope = service.wrapForBrowser({
      requestId: "req_export",
      browserKeyId: "browser_1",
      browserPublicKey: browserPublicKey!,
    });
    expect(envelope.ciphertext).not.toContain(
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
    );
    expect(envelope.browserKeyId).toBe("browser_1");
  });

  it("rejects expired capabilities", () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const service = new ExportCapabilityService(
      new Uint8Array(32).fill(4),
      () => now,
    );
    service.createCapability({
      requestId: "req_expired",
      objectKey: "exports/req_expired.bin",
      downloadUrl: "https://storage.example/download",
      archiveKey: new Uint8Array(32).fill(9),
      archiveSizeBytes: 1,
      expiresAt: new Date("2026-07-24T00:01:00.000Z"),
    });
    now = new Date("2026-07-24T00:02:00.000Z");
    expect(() => service.get("req_expired")).toThrowError(
      new ExportCapabilityError("EXPORT_CAPABILITY_EXPIRED"),
    );
  });
});
