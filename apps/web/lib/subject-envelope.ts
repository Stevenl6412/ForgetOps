const SUBJECT_ENVELOPE_VERSION = 1 as const;
const SUBJECT_ENVELOPE_ALGORITHM = "X25519-HKDF-SHA256-AES-256-GCM" as const;
const HKDF_INFO = new TextEncoder().encode("forgetops.subject-envelope.v1");

export interface SubjectIdentity {
  applicationUserId?: string;
  email?: string;
}

export interface SubjectEnvelope {
  version: typeof SUBJECT_ENVELOPE_VERSION;
  algorithm: typeof SUBJECT_ENVELOPE_ALGORITHM;
  requestId: string;
  environmentId: string;
  encryptionKeyId: string;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface SubjectEncryptionOptions {
  environmentId: string;
  requestId: string;
  publicKey: string;
  encryptionKeyId: string;
  crypto?: Crypto;
}

export async function encryptSubject(
  subject: SubjectIdentity,
  options: SubjectEncryptionOptions,
): Promise<SubjectEnvelope> {
  validateSubject(subject);
  validateScope(options);
  const cryptoProvider = options.crypto ?? globalThis.crypto;
  if (!cryptoProvider?.subtle) {
    throw new Error("SUBJECT_ENVELOPE_CRYPTO_UNAVAILABLE");
  }

  const recipientPublicKeyBytes = decodeBase64Url(options.publicKey);
  if (recipientPublicKeyBytes.length !== 32) {
    throw new Error("SUBJECT_ENVELOPE_PUBLIC_KEY_INVALID");
  }
  const expectedKeyId = await keyId(cryptoProvider, recipientPublicKeyBytes);
  if (expectedKeyId !== options.encryptionKeyId) {
    throw new Error("SUBJECT_ENVELOPE_KEY_ID_MISMATCH");
  }

  const recipientPublicKey = await cryptoProvider.subtle.importKey(
    "raw",
    asArrayBuffer(recipientPublicKeyBytes),
    { name: "X25519" } as AlgorithmIdentifier,
    false,
    [],
  );
  const ephemeralKeys = (await cryptoProvider.subtle.generateKey(
    { name: "X25519" } as AlgorithmIdentifier,
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const sharedSecret = await cryptoProvider.subtle.deriveBits(
    {
      name: "X25519",
      public: recipientPublicKey,
    } as AlgorithmIdentifier,
    ephemeralKeys.privateKey,
    256,
  );

  const salt = new Uint8Array(32);
  const iv = new Uint8Array(12);
  cryptoProvider.getRandomValues(salt);
  cryptoProvider.getRandomValues(iv);
  const hkdfKey = await cryptoProvider.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const encryptionKey = await cryptoProvider.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(HKDF_INFO),
    } as HkdfParams,
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const envelopeMetadata = {
    encryptionKeyId: options.encryptionKeyId,
    environmentId: options.environmentId,
    requestId: options.requestId,
  };
  const ciphertext = await cryptoProvider.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(
        new TextEncoder().encode(JSON.stringify(envelopeMetadata)),
      ),
      tagLength: 128,
    },
    encryptionKey,
    asArrayBuffer(new TextEncoder().encode(JSON.stringify(subject))),
  );
  const ephemeralPublicKey = new Uint8Array(
    await cryptoProvider.subtle.exportKey("raw", ephemeralKeys.publicKey),
  );

  return {
    version: SUBJECT_ENVELOPE_VERSION,
    algorithm: SUBJECT_ENVELOPE_ALGORITHM,
    requestId: options.requestId,
    environmentId: options.environmentId,
    encryptionKeyId: options.encryptionKeyId,
    ephemeralPublicKey: encodeBase64Url(ephemeralPublicKey),
    salt: encodeBase64Url(salt),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

function validateSubject(subject: SubjectIdentity): void {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    throw new Error("SUBJECT_IDENTIFIER_INVALID");
  }
  if (
    Object.keys(subject).some(
      (key) => key !== "applicationUserId" && key !== "email",
    )
  ) {
    throw new Error("SUBJECT_IDENTIFIER_INVALID");
  }
  if (
    subject.applicationUserId !== undefined &&
    typeof subject.applicationUserId !== "string"
  ) {
    throw new Error("SUBJECT_IDENTIFIER_INVALID");
  }
  if (subject.email !== undefined && typeof subject.email !== "string") {
    throw new Error("SUBJECT_IDENTIFIER_INVALID");
  }
  if (
    (!subject.applicationUserId || !subject.applicationUserId.trim()) &&
    (!subject.email || !subject.email.trim())
  ) {
    throw new Error("SUBJECT_IDENTIFIER_REQUIRED");
  }
}

function validateScope(options: SubjectEncryptionOptions): void {
  if (
    typeof options.environmentId !== "string" ||
    typeof options.requestId !== "string" ||
    !options.environmentId.trim() ||
    !options.requestId.trim()
  ) {
    throw new Error("SUBJECT_ENVELOPE_SCOPE_REQUIRED");
  }
  if (
    typeof options.encryptionKeyId !== "string" ||
    !/^x25519:sha256:[0-9a-f]{64}$/.test(options.encryptionKeyId)
  ) {
    throw new Error("SUBJECT_ENVELOPE_KEY_ID_REQUIRED");
  }
  if (typeof options.publicKey !== "string") {
    throw new Error("SUBJECT_ENVELOPE_PUBLIC_KEY_INVALID");
  }
}

async function keyId(
  cryptoProvider: Crypto,
  publicKey: Uint8Array,
): Promise<string> {
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", asArrayBuffer(publicKey)),
  );
  return `x25519:sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("SUBJECT_ENVELOPE_BASE64_INVALID");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
