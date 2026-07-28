import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import canonicalize from "canonicalize";
import {
  ExecutionAuthorizationClaimsSchema,
  type ExecutionAuthorizationClaims,
} from "@forgetops/contracts";
import {
  assertAuthorizationPolicy,
  type AuthorizationPolicyInput,
  type AuthorizationPolicyState,
} from "./authorization-policy.js";

const ED25519_SEED_BYTES = 32;
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const SIGNING_CONTEXT = "forgetops.execution-authorization.v1";

export interface AuthorizationSignerOptions {
  keyId: string;
  issuer?: "forgetops-control-plane";
  now?: () => Date;
  maxTtlMs?: number;
}

export interface AuthorizationStateStore {
  getAuthorizationState(
    requestId: string,
  ): Promise<AuthorizationPolicyState | null> | AuthorizationPolicyState | null;
}

export interface AuthorizeInput {
  requestId: string;
  actorId: string;
  expectedRequestVersion: number;
  requestedStepIds: readonly string[];
  authorizationKind?: "initial" | "retry";
  ttlMs?: number;
}

export interface SignedAuthorization {
  claims: ExecutionAuthorizationClaims;
  signature: string;
}

export class AuthorizationSigner {
  readonly keyId: string;
  private readonly now: () => Date;
  private readonly maxTtlMs: number;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly stateStore: AuthorizationStateStore,
    options: AuthorizationSignerOptions,
  ) {
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError(
        "Authorization signer requires an Ed25519 private key",
      );
    }
    if (!options.keyId)
      throw new TypeError("Authorization signer requires a key ID");
    this.keyId = options.keyId;
    this.now = options.now ?? (() => new Date());
    this.maxTtlMs = options.maxTtlMs ?? 30 * 60 * 1000;
    if (this.maxTtlMs <= 0 || this.maxTtlMs > 30 * 60 * 1000) {
      throw new RangeError("AUTHORIZATION_TTL_INVALID");
    }
  }

  static fromSeed(
    seed: Uint8Array,
    stateStore: AuthorizationStateStore,
    options: AuthorizationSignerOptions,
  ): AuthorizationSigner {
    if (seed.byteLength !== ED25519_SEED_BYTES) {
      throw new TypeError("Ed25519 seed must be exactly 32 bytes");
    }
    return new AuthorizationSigner(
      createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
        format: "der",
        type: "pkcs8",
      }),
      stateStore,
      options,
    );
  }

  async authorize(input: AuthorizeInput): Promise<SignedAuthorization> {
    const state = await this.stateStore.getAuthorizationState(input.requestId);
    if (!state) throw new Error("REQUEST_NOT_FOUND");
    const authorizationKind = input.authorizationKind ?? "initial";
    const policyInput: AuthorizationPolicyInput = {
      state,
      actorId: input.actorId,
      expectedRequestVersion: input.expectedRequestVersion,
      requestedStepIds: input.requestedStepIds,
      authorizationKind,
    };
    assertAuthorizationPolicy(policyInput);
    const now = this.now();
    const ttlMs = input.ttlMs ?? this.maxTtlMs;
    if (ttlMs <= 0 || ttlMs > this.maxTtlMs) {
      throw new RangeError("AUTHORIZATION_TTL_INVALID");
    }
    const expiresAt = new Date(now.getTime() + ttlMs);
    const approvalEvidenceHash =
      state.approval?.evidenceHash ?? "sha256:unapproved";
    const claims = ExecutionAuthorizationClaimsSchema.parse({
      type: "forgetops.execution-authorization",
      version: 1,
      keyId: this.keyId,
      issuer: "forgetops-control-plane",
      audience: "forgetops-agent",
      environmentId: state.request.environmentId,
      agentId: state.agent.id,
      requestId: state.request.id,
      attemptId: randomBytes(16).toString("hex"),
      authorizationKind,
      planId: state.plan.id,
      planVersion: state.plan.version,
      planFingerprint: state.plan.fingerprint,
      policyVersion: state.request.policyVersion,
      connectorConfigurationFingerprint:
        state.plan.connectorConfigurationFingerprint,
      allowedStepIds: [...input.requestedStepIds],
      approvalEvidenceHash,
      issuedAt: now.toISOString(),
      notBefore: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: randomBytes(24).toString("base64url"),
    });
    return {
      claims,
      signature: signDomainSeparatedJcs(
        SIGNING_CONTEXT,
        claims,
        this.privateKey,
      ),
    };
  }

  publicKey(): string {
    const x = this.privateKey.export({ format: "jwk" }).x;
    if (!x) throw new TypeError("Authorization signer key has no public key");
    return x;
  }
}

export function planFingerprint(plan: unknown): string {
  const serialized = canonicalize(plan);
  if (serialized === undefined) throw new TypeError("PLAN_NOT_CANONICAL");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function signDomainSeparatedJcs(
  context: string,
  claims: unknown,
  privateKey: KeyObject,
): string {
  const serialized = canonicalize(claims);
  if (serialized === undefined) throw new TypeError("CLAIMS_NOT_CANONICAL");
  const material = Buffer.concat([
    Buffer.from(context, "utf8"),
    Buffer.from([0]),
    Buffer.from(serialized, "utf8"),
  ]);
  return sign(null, material, privateKey).toString("base64url");
}

export function verifyDomainSeparatedJcs(
  context: string,
  claims: unknown,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const serialized = canonicalize(claims);
    if (serialized === undefined) return false;
    const material = Buffer.concat([
      Buffer.from(context, "utf8"),
      Buffer.from([0]),
      Buffer.from(serialized, "utf8"),
    ]);
    const keyBytes = Buffer.from(publicKey, "base64url");
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        keyBytes,
      ]),
      format: "der",
      type: "spki",
    });
    return verify(null, material, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export const AUTHORIZATION_SIGNING_CONTEXT = SIGNING_CONTEXT;
