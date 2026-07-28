import { describe, expect, it, vi, type Mocked } from "vitest";
import {
  SubjectEnvelopeService,
  type SubjectBindingResult,
  type SubjectEnvelopeRepository,
} from "../src/modules/privacy-requests/subject-envelope-service.js";

describe("SubjectEnvelopeService", () => {
  it("rejects an unversioned subject hash before persistence", async () => {
    const repository = fakeRepository();
    const service = new SubjectEnvelopeService(repository);

    await expect(
      service.bindSubject({
        tenantId: "tenant_a",
        environmentId: "env_a",
        requestId: "req_a",
        agentId: "agent_a",
        subjectHash: "hmac:subject",
        subjectHashKeyVersion: 1,
        canonicalizationVersion: 1,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "SUBJECT_HASH_INVALID" });
    expect(repository.bindSubject).not.toHaveBeenCalled();
  });

  it("passes typed aliases without treating them as implicit primary identities", async () => {
    const repository = fakeRepository();
    const service = new SubjectEnvelopeService(repository);
    const binding: SubjectBindingResult = {
      requestId: "req_a",
      environmentId: "env_a",
      subjectHash:
        "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      subjectHashKeyVersion: 1,
      canonicalizationVersion: 1,
      duplicateOfRequestId: null,
      outcome: "bound",
    };
    repository.bindSubject.mockResolvedValue(binding);

    await expect(
      service.bindSubject({
        tenantId: "tenant_a",
        environmentId: "env_a",
        requestId: "req_a",
        agentId: "agent_a",
        subjectHash: binding.subjectHash,
        subjectHashKeyVersion: 1,
        canonicalizationVersion: 1,
        expectedVersion: 1,
        aliases: [
          {
            identifierKind: "email",
            subjectHash:
              "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            subjectHashKeyVersion: 1,
            canonicalizationVersion: 1,
          },
        ],
      }),
    ).resolves.toEqual(binding);
    expect(repository.bindSubject).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: [expect.objectContaining({ identifierKind: "email" })],
      }),
    );
  });

  it("rejects an expired envelope before persistence", async () => {
    const repository = fakeRepository();
    const service = new SubjectEnvelopeService(repository, {
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    await expect(
      service.storeEnvelope({
        tenantId: "tenant_a",
        environmentId: "env_a",
        requestId: "req_a",
        encryptionKeyId:
          "x25519:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ciphertext: "opaque-envelope",
        expiresAt: "2026-07-23T23:59:59.000Z",
      }),
    ).rejects.toMatchObject({ code: "SUBJECT_ENVELOPE_EXPIRED" });
    expect(repository.storeEnvelope).not.toHaveBeenCalled();
  });

  it("rejects opaque payloads that are not the versioned envelope format", async () => {
    const repository = fakeRepository();
    const service = new SubjectEnvelopeService(repository, {
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    await expect(
      service.storeEnvelope({
        tenantId: "tenant_a",
        environmentId: "env_a",
        requestId: "req_a",
        encryptionKeyId:
          "x25519:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ciphertext: "opaque-envelope",
        expiresAt: "2026-07-24T00:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SUBJECT_ENVELOPE_FORMAT_INVALID" });
    expect(repository.storeEnvelope).not.toHaveBeenCalled();
  });
});

function fakeRepository(): Mocked<SubjectEnvelopeRepository> {
  return {
    storeEnvelope: vi.fn(),
    bindSubject: vi.fn(),
  };
}
