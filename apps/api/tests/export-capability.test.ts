import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ExportCapabilityError,
  ExportCapabilityService,
} from "../src/modules/exports/export-capability-service.js";

describe("export capability delivery", () => {
  it("relays only agent-sealed key-envelope metadata", () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const service = new ExportCapabilityService(() => now);
    const encryptedArchiveKey = "opaque-agent-sealed-envelope";
    const capability = service.createCapability({
      requestId: "req_export",
      objectKey: "exports/req_export.bin",
      downloadUrl: "https://storage.example/download",
      encryptedArchiveKey,
      archiveSizeBytes: 128,
      browserKeyId: "browser_1",
      keyWrapVersion: 1,
      expiresAt: new Date("2026-07-24T01:00:00.000Z"),
    });

    expect(capability).toEqual({
      requestId: "req_export",
      objectKeyHash:
        "sha256:9a26a7bbfe0e6f311a0e596700486f9825cb79e813631454ae85415b86d35bbb",
      downloadUrl: "https://storage.example/download",
      expiresAt: "2026-07-24T01:00:00.000Z",
      encryptedArchiveKey,
      archiveSizeBytes: 128,
      browserKeyId: "browser_1",
      keyWrapVersion: 1,
    });
    expect(service.get("req_export")).toEqual(capability);
    expect("wrapForBrowser" in service).toBe(false);

    type CreateCapabilityInput = Parameters<
      ExportCapabilityService["createCapability"]
    >[0];
    type AcceptsRawArchiveKey = "archiveKey" extends keyof CreateCapabilityInput
      ? true
      : false;
    type AcceptsBrowserPublicKey =
      "browserPublicKey" extends keyof CreateCapabilityInput ? true : false;
    expectTypeOf<AcceptsRawArchiveKey>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsBrowserPublicKey>().toEqualTypeOf<false>();
  });

  it("rejects expired capabilities", () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const service = new ExportCapabilityService(() => now);
    service.createCapability({
      requestId: "req_expired",
      objectKey: "exports/req_expired.bin",
      downloadUrl: "https://storage.example/download",
      encryptedArchiveKey: "opaque-agent-sealed-envelope",
      archiveSizeBytes: 1,
      browserKeyId: "browser_1",
      keyWrapVersion: 1,
      expiresAt: new Date("2026-07-24T00:01:00.000Z"),
    });
    now = new Date("2026-07-24T00:02:00.000Z");
    expect(() => service.get("req_expired")).toThrowError(
      new ExportCapabilityError("EXPORT_CAPABILITY_EXPIRED"),
    );
  });

  it("isolates stored capability state from caller mutation", () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const service = new ExportCapabilityService(() => now);
    const capability = service.createCapability({
      requestId: "req_mutation",
      objectKey: "exports/req_mutation.bin",
      downloadUrl: "https://storage.example/download",
      encryptedArchiveKey: "opaque-agent-sealed-envelope",
      archiveSizeBytes: 128,
      browserKeyId: "browser_1",
      keyWrapVersion: 1,
      expiresAt: new Date("2026-07-24T00:01:00.000Z"),
    });

    capability.encryptedArchiveKey = "attacker-controlled-envelope";
    capability.browserKeyId = "attacker-controlled-key";
    capability.expiresAt = "2099-01-01T00:00:00.000Z";

    now = new Date("2026-07-24T00:02:00.000Z");
    expect(() => service.get("req_mutation")).toThrowError(
      new ExportCapabilityError("EXPORT_CAPABILITY_EXPIRED"),
    );
  });
});
