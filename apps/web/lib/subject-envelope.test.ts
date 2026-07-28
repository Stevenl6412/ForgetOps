import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encryptSubject } from "./subject-envelope.js";

describe("encryptSubject", () => {
  it("does not include the plaintext identifier in the serialized envelope", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/contracts/fixtures/subject-identities.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      canonicalizationVersion: number;
      cases: { identity: { applicationUserId?: string; email?: string } }[];
    };
    const keys = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("raw", keys.publicKey),
    ).toString("base64url");
    const encryptionKeyId = `x25519:sha256:${createHash("sha256")
      .update(Buffer.from(publicKey, "base64url"))
      .digest("hex")}`;

    const envelope = await encryptSubject(fixture.cases[0]!.identity, {
      environmentId: "env_subject",
      requestId: "req_subject",
      publicKey,
      encryptionKeyId,
      crypto: webcrypto as unknown as Crypto,
    });

    expect(JSON.stringify(envelope)).not.toContain("Canary@Example.COM");
    expect(JSON.stringify(envelope)).not.toContain("Customer-42");
    expect(fixture.canonicalizationVersion).toBe(1);
    expect(envelope).toMatchObject({
      version: 1,
      environmentId: "env_subject",
      requestId: "req_subject",
      encryptionKeyId,
    });
  });

  it("rejects malformed raw identifiers at the browser trust boundary", async () => {
    await expect(
      encryptSubject({ email: 42 } as unknown as { email: string }, {
        environmentId: "env_subject",
        requestId: "req_subject",
        publicKey: "not-used",
        encryptionKeyId: "not-used",
        crypto: webcrypto as unknown as Crypto,
      }),
    ).rejects.toThrow("SUBJECT_IDENTIFIER_INVALID");
  });
});
