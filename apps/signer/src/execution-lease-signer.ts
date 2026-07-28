import { randomBytes, type KeyObject } from "node:crypto";
import { createPrivateKey } from "node:crypto";
import {
  ExecutionAuthorizationClaimsSchema,
  ExecutionLeaseClaimsSchema,
  type ExecutionAuthorizationClaims,
  type ExecutionLeaseClaims,
} from "@forgetops/contracts";
import {
  assertExecutionLeasePolicy,
  assertLeaseClaimsBound,
  type AuthorizationPolicyState,
} from "./authorization-policy.js";
import {
  signDomainSeparatedJcs,
  verifyDomainSeparatedJcs,
} from "./authorization-signer.js";

const LEASE_CONTEXT = "forgetops.execution-lease.v1";
const MAX_LEASE_TTL_MS = 90_000;
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export interface ExecutionLeaseSignerOptions {
  keyId: string;
  now?: () => Date;
}

export interface ExecutionLeaseInput {
  authorization: ExecutionAuthorizationClaims;
  state: AuthorizationPolicyState;
  requestedStepIds: readonly string[];
  ttlMs?: number;
}

export interface SignedExecutionLease {
  claims: ExecutionLeaseClaims;
  signature: string;
}

export class ExecutionLeaseSigner {
  private readonly now: () => Date;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly options: ExecutionLeaseSignerOptions,
  ) {
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError(
        "Execution lease signer requires an Ed25519 private key",
      );
    }
    if (!options.keyId)
      throw new TypeError("Execution lease signer requires a key ID");
    this.now = options.now ?? (() => new Date());
  }

  static fromSeed(
    seed: Uint8Array,
    options: ExecutionLeaseSignerOptions,
  ): ExecutionLeaseSigner {
    if (seed.byteLength !== 32) {
      throw new TypeError("Ed25519 seed must be exactly 32 bytes");
    }
    return new ExecutionLeaseSigner(
      createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
        format: "der",
        type: "pkcs8",
      }),
      options,
    );
  }

  async issue(input: ExecutionLeaseInput): Promise<SignedExecutionLease> {
    const now = this.now();
    assertExecutionLeasePolicy({
      authorization: input.authorization,
      state: input.state,
      requestedStepIds: input.requestedStepIds,
      now,
    });
    const ttlMs = input.ttlMs ?? MAX_LEASE_TTL_MS;
    if (ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
      throw new RangeError("EXECUTION_LEASE_TTL_INVALID");
    }
    const claims = ExecutionLeaseClaimsSchema.parse({
      type: "forgetops.execution-lease",
      version: 1,
      keyId: this.options.keyId,
      environmentId: input.authorization.environmentId,
      agentId: input.authorization.agentId,
      requestId: input.authorization.requestId,
      attemptId: input.authorization.attemptId,
      allowedStepIds: [...input.requestedStepIds],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      leaseId: randomBytes(16).toString("hex"),
    });
    assertLeaseClaimsBound(claims, input.authorization);
    return {
      claims,
      signature: signDomainSeparatedJcs(LEASE_CONTEXT, claims, this.privateKey),
    };
  }
}

export function verifyExecutionLease(
  claims: ExecutionLeaseClaims,
  signature: string,
  publicKey: string,
): boolean {
  const parsed = ExecutionLeaseClaimsSchema.safeParse(claims);
  return (
    parsed.success &&
    verifyDomainSeparatedJcs(LEASE_CONTEXT, parsed.data, signature, publicKey)
  );
}

export const EXECUTION_LEASE_SIGNING_CONTEXT = LEASE_CONTEXT;
