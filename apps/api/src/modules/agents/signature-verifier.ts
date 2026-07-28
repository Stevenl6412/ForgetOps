import { createHash, createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** Fields signed by a freshly initialized agent. Keep this list append-only. */
export interface PairingProofFields {
  pairingToken: string;
  environmentId: string;
  publicSigningKey: string;
  publicEncryptionKey: string;
  signingKeyId: string;
  encryptionKeyId: string;
  subjectHmacKeyVersion: number;
  version: string;
  protocolVersion: string;
  instanceFingerprint: string;
}

/**
 * Build the canonical proof body. The token is included so a proof cannot be
 * replayed with another issued token or environment.
 */
export function createPairingProofPayload(fields: PairingProofFields): string {
  const payload = canonicalize({
    environmentId: fields.environmentId,
    instanceFingerprint: fields.instanceFingerprint,
    pairingToken: fields.pairingToken,
    protocolVersion: fields.protocolVersion,
    publicEncryptionKey: fields.publicEncryptionKey,
    publicSigningKey: fields.publicSigningKey,
    encryptionKeyId: fields.encryptionKeyId,
    signingKeyId: fields.signingKeyId,
    subjectHmacKeyVersion: fields.subjectHmacKeyVersion,
    version: fields.version,
  });
  if (payload === undefined) {
    throw new TypeError("Pairing proof payload must be canonical JSON");
  }
  return payload;
}

export function keyIdForPublicKey(
  purpose: "ed25519" | "x25519",
  publicKey: string,
): string {
  const keyBytes = decodeAgentKey(publicKey);
  return `${purpose}:sha256:${createHash("sha256").update(keyBytes).digest("hex")}`;
}

export interface VerifyAgentProofInput {
  publicSigningKey: string;
  proof: string;
  payload: string | Uint8Array;
}

/** Verify an Ed25519 signature over the canonical registration payload. */
export function verifyAgentProof(input: VerifyAgentProofInput): boolean {
  try {
    const keyBytes = decodeKey(input.publicSigningKey);
    const signature = decodeBase64Url(input.proof);
    if (signature.length !== SIGNATURE_BYTES) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      typeof input.payload === "string"
        ? Buffer.from(input.payload)
        : Buffer.from(input.payload),
      key,
      signature,
    );
  } catch {
    return false;
  }
}

export function decodeAgentKey(value: string): Buffer {
  const bytes = decodeKey(value);
  if (bytes.length !== KEY_BYTES) {
    throw new Error("Agent public keys must be exactly 32 bytes");
  }
  return bytes;
}

export function sha256Token(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function decodeKey(value: string): Buffer {
  return decodeBase64Url(value);
}

function decodeBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    throw new Error("Invalid base64url value");
  }
  return bytes;
}
