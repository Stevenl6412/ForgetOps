import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  agentMessageSigningBytes,
  type AgentMessage,
  type UnsignedAgentMessage,
} from "@forgetops/contracts";
import type {
  AgentAuthenticationStore,
  GatewayAgentIdentity,
} from "./job-repository.js";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const MESSAGE_FRESHNESS_MS = 5 * 60 * 1000;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type AgentGatewayAuthErrorCode =
  | "AUTH_SIGNATURE_INVALID"
  | "AUTH_AGENT_REVOKED"
  | "AUTH_ENVIRONMENT_MISMATCH"
  | "AUTH_REPLAY_DETECTED"
  | "PROTOCOL_VERSION_UNSUPPORTED";

export class AgentGatewayAuthError extends Error {
  constructor(
    readonly code: AgentGatewayAuthErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentGatewayAuthError";
  }
}

export class AgentMessageAuthenticator {
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentAuthenticationStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async authenticate(message: AgentMessage): Promise<GatewayAgentIdentity> {
    if (message.protocolVersion !== "1.0") {
      throw authError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "The agent protocol version is unsupported",
        400,
      );
    }
    const receivedAt = this.now();
    const sentAt = Date.parse(message.sentAt);
    if (
      !Number.isFinite(sentAt) ||
      Math.abs(receivedAt.getTime() - sentAt) > MESSAGE_FRESHNESS_MS
    ) {
      throw authError(
        "AUTH_SIGNATURE_INVALID",
        "The signed agent message is stale or invalid",
        401,
      );
    }
    const sequence = parseSequence(message.sequence);
    const agent = await this.store.findAgentIdentity(message.agentId);
    if (
      !agent ||
      message.keyId !== agent.signingKeyId ||
      message.direction !== "agent_to_control" ||
      !verifyAgentMessage(message, agent.publicSigningKey)
    ) {
      throw authError(
        "AUTH_SIGNATURE_INVALID",
        "The agent message signature is invalid",
        401,
      );
    }
    if (agent.protocolVersion !== message.protocolVersion) {
      throw authError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "The agent protocol version is unsupported",
        400,
      );
    }
    if (agent.environmentId !== message.environmentId) {
      throw authError(
        "AUTH_ENVIRONMENT_MISMATCH",
        "The agent is not bound to this environment",
        401,
      );
    }
    if (agent.status === "revoked") {
      throw authError(
        "AUTH_AGENT_REVOKED",
        "The agent identity has been revoked",
        401,
      );
    }

    const claim = await this.store.claimAgentMessage({
      tenantId: agent.tenantId,
      agentId: message.agentId,
      environmentId: message.environmentId,
      messageId: message.messageId,
      sequence: sequence.toString(),
      receivedAt: receivedAt.toISOString(),
    });
    if (claim === "accepted") return agent;
    if (claim === "environment_mismatch") {
      throw authError(
        "AUTH_ENVIRONMENT_MISMATCH",
        "The agent is not bound to this environment",
        401,
      );
    }
    if (claim === "revoked") {
      throw authError(
        "AUTH_AGENT_REVOKED",
        "The agent identity has been revoked",
        401,
      );
    }
    if (claim === "replay") {
      throw authError(
        "AUTH_REPLAY_DETECTED",
        "The agent message was already processed",
        409,
      );
    }
    throw authError(
      "AUTH_SIGNATURE_INVALID",
      "The agent message signature is invalid",
      401,
    );
  }
}

export class Ed25519MessageSigner {
  constructor(
    private readonly privateKey: KeyObject,
    readonly keyId: string,
  ) {
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("Message signer requires an Ed25519 private key");
    }
    if (!keyId) throw new TypeError("Message signer requires a key ID");
  }

  static fromSeed(
    seed: Uint8Array,
    keyId = "forgetops-control-message-key-1",
  ): Ed25519MessageSigner {
    if (seed.byteLength !== ED25519_KEY_BYTES) {
      throw new TypeError("Ed25519 seed must be exactly 32 bytes");
    }
    return new Ed25519MessageSigner(
      createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
        format: "der",
        type: "pkcs8",
      }),
      keyId,
    );
  }

  sign(message: UnsignedAgentMessage): AgentMessage {
    if (message.keyId !== this.keyId) {
      throw new TypeError("Agent message key ID does not match signer key");
    }
    const signature = sign(
      null,
      agentMessageSigningBytes(message),
      this.privateKey,
    );
    return { ...message, signature: signature.toString("base64url") };
  }

  publicKey(): string {
    const publicKey = this.privateKey.export({ format: "jwk" }).x;
    if (!publicKey) {
      throw new TypeError("Ed25519 private key does not expose a public key");
    }
    return publicKey;
  }
}

export function verifyAgentMessage(
  message: AgentMessage,
  publicKey: string,
): boolean {
  try {
    const keyBytes = decodeCanonicalBase64Url(publicKey);
    const signature = decodeCanonicalBase64Url(message.signature);
    if (
      keyBytes.byteLength !== ED25519_KEY_BYTES ||
      signature.byteLength !== ED25519_SIGNATURE_BYTES
    ) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verify(null, agentMessageSigningBytes(message), key, signature);
  } catch {
    return false;
  }
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid base64url value");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError("Non-canonical base64url value");
  }
  return decoded;
}

function parseSequence(value: string): bigint {
  if (!/^[1-9]\d{0,19}$/.test(value)) {
    throw authError(
      "AUTH_REPLAY_DETECTED",
      "The agent message sequence is invalid",
      409,
    );
  }
  const sequence = BigInt(value);
  if (sequence > MAX_U64) {
    throw authError(
      "AUTH_REPLAY_DETECTED",
      "The agent message sequence is invalid",
      409,
    );
  }
  return sequence;
}

function authError(
  code: AgentGatewayAuthErrorCode,
  message: string,
  statusCode: number,
): AgentGatewayAuthError {
  return new AgentGatewayAuthError(code, message, statusCode);
}
