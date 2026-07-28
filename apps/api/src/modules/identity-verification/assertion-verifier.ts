import { createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";

const ASSERTION_CONTEXT = "forgetops.subject-assertion.v1";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const SubjectAssertionSchema = z
  .object({
    type: z.literal("forgetops.subject-assertion"),
    version: z.literal(1),
    issuer: z.string().min(1),
    audience: z.literal("forgetops-privacy-portal"),
    keyId: z.string().min(1),
    assertionId: z.string().min(16),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    requestType: z.enum(["delete", "export"]),
    challengeId: z.string().min(16),
    subjectEnvelope: z.string().min(32),
    authenticationMethod: z.literal("clerk_reauthentication"),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    nonce: z.string().min(16),
  })
  .strict();

export type SubjectAssertion = z.infer<typeof SubjectAssertionSchema>;

export interface AssertionKeyResolver {
  resolve(input: {
    projectId: string;
    keyId: string;
  }):
    | Promise<{ issuer: string; publicKey: string } | null>
    | { issuer: string; publicKey: string }
    | null;
}

export interface AssertionReplayStore {
  consume(input: {
    assertionId: string;
    nonce: string;
    expiresAt: string;
  }): Promise<boolean> | boolean;
}

export class SubjectAssertionError extends Error {
  constructor(
    readonly code:
      | "ASSERTION_INVALID"
      | "ASSERTION_SIGNATURE_INVALID"
      | "ASSERTION_REPLAYED"
      | "ASSERTION_EXPIRED"
      | "ASSERTION_CONTEXT_MISMATCH",
  ) {
    super(code);
    this.name = "SubjectAssertionError";
  }
}

export class SubjectAssertionVerifier {
  constructor(
    private readonly keys: AssertionKeyResolver,
    private readonly replay: AssertionReplayStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(input: {
    claims: unknown;
    signature: string;
    expected: {
      projectId: string;
      environmentId: string;
      requestType: "delete" | "export";
      challengeId: string;
      subjectEnvelope: string;
    };
  }): Promise<SubjectAssertion> {
    const parsed = SubjectAssertionSchema.safeParse(input.claims);
    if (!parsed.success) throw new SubjectAssertionError("ASSERTION_INVALID");
    const claims = parsed.data;
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    const now = this.now().getTime();
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 5 * 60 * 1000 ||
      now < issuedAt ||
      now >= expiresAt
    ) {
      throw new SubjectAssertionError("ASSERTION_EXPIRED");
    }
    if (
      claims.projectId !== input.expected.projectId ||
      claims.environmentId !== input.expected.environmentId ||
      claims.requestType !== input.expected.requestType ||
      claims.challengeId !== input.expected.challengeId ||
      claims.subjectEnvelope !== input.expected.subjectEnvelope
    ) {
      throw new SubjectAssertionError("ASSERTION_CONTEXT_MISMATCH");
    }
    const key = await this.keys.resolve({
      projectId: claims.projectId,
      keyId: claims.keyId,
    });
    if (
      !key ||
      key.issuer !== claims.issuer ||
      !verifyAssertion(claims, input.signature, key.publicKey)
    ) {
      throw new SubjectAssertionError("ASSERTION_SIGNATURE_INVALID");
    }
    if (
      !(await this.replay.consume({
        assertionId: claims.assertionId,
        nonce: claims.nonce,
        expiresAt: claims.expiresAt,
      }))
    ) {
      throw new SubjectAssertionError("ASSERTION_REPLAYED");
    }
    return claims;
  }
}

export function verifyAssertion(
  claims: SubjectAssertion,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const serialized = canonicalize(claims);
    if (serialized === undefined) return false;
    const material = Buffer.concat([
      Buffer.from(ASSERTION_CONTEXT),
      Buffer.from([0]),
      Buffer.from(serialized),
    ]);
    const keyBytes = Buffer.from(publicKey, "base64url");
    const signatureBytes = Buffer.from(signature, "base64url");
    if (
      keyBytes.length !== 32 ||
      signatureBytes.length !== 64 ||
      keyBytes.toString("base64url") !== publicKey ||
      signatureBytes.toString("base64url") !== signature
    ) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verify(null, material, key, signatureBytes);
  } catch {
    return false;
  }
}

export const SUBJECT_ASSERTION_SIGNING_CONTEXT = ASSERTION_CONTEXT;
