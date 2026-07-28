import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  agentMessageSigningBytes,
  AgentMessageSchema,
  canonicalUnsignedBytes,
  ExecutionAuthorizationClaimsSchema,
  ExecutionLeaseClaimsSchema,
  PrivacyRequestStatusSchema,
} from "../src";

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8").then(
    JSON.parse,
  );

describe("shared contracts", () => {
  it("accepts the locked request states", () => {
    expect(PrivacyRequestStatusSchema.parse("awaiting_approval")).toBe(
      "awaiting_approval",
    );
    expect(PrivacyRequestStatusSchema.parse("needs_review")).toBe(
      "needs_review",
    );
  });

  it("rejects an authorization without a plan fingerprint", () => {
    const result = ExecutionAuthorizationClaimsSchema.safeParse({
      issuer: "forgetops-control-plane",
    });
    expect(result.success).toBe(false);
  });

  it("requires every agent message to include a signature", () => {
    const result = AgentMessageSchema.safeParse({ protocolVersion: "1.0" });
    expect(result.success).toBe(false);
  });

  it("rejects an execution lease longer than 90 seconds", async () => {
    const lease = await fixture("execution-lease.json");
    const result = ExecutionLeaseClaimsSchema.safeParse({
      ...lease,
      expiresAt: "2026-07-21T10:02:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an agent sequence outside the unsigned 64-bit range", async () => {
    const message = await fixture("agent-job-plan.json");
    const result = AgentMessageSchema.safeParse({
      ...message,
      sequence: "18446744073709551616",
    });
    expect(result.success).toBe(false);
  });

  it("loads the sanitized planning job fixture with camelCase fields", async () => {
    const message = AgentMessageSchema.parse(
      await fixture("agent-job-plan.json"),
    );
    const payload = message.payload as {
      jobId: string;
      kind: string;
      requestId: string;
      planVersion: number;
      planProjection: {
        planFingerprint: string;
        steps: Array<{ action: string }>;
      };
    };

    expect(message.protocolVersion).toBe("1.0");
    expect(message.type).toBe("forgetops.agent-message");
    expect(message.direction).toBe("control_to_agent");
    expect(message.messageType).toBe("job.available");
    expect(payload.kind).toBe("plan");
    expect(payload.planVersion).toBe(3);
    expect(payload.planProjection.planFingerprint).toBe(
      "sha256:plan-v3-sanitized",
    );
    expect(payload.planProjection.steps[0]?.action).toBe("delete");
  });

  it("loads the execution authorization fixture with camelCase fields", async () => {
    const authorization = ExecutionAuthorizationClaimsSchema.parse(
      await fixture("execution-authorization.json"),
    );

    expect(authorization.environmentId).toBe("env_01demo");
    expect(authorization.attemptId).toBe("att_01demo");
    expect(authorization.authorizationKind).toBe("initial");
    expect(authorization.planVersion).toBe(3);
    expect(authorization.planFingerprint).toBe("sha256:plan-v3-sanitized");
  });

  it("loads a bounded execution lease fixture", async () => {
    const lease = ExecutionLeaseClaimsSchema.parse(
      await fixture("execution-lease.json"),
    );

    expect(lease.attemptId).toBe("att_01demo");
    expect(lease.allowedStepIds).toEqual(["step_01documents"]);
  });

  it("matches canonical bytes and verifies a Rust-compatible signature", async () => {
    const signedFixture = (await fixture("signed-agent-message.json")) as {
      publicKey: string;
      canonicalBytes: string;
      message: unknown;
    };
    const message = AgentMessageSchema.parse(signedFixture.message);

    expect(
      Buffer.from(canonicalUnsignedBytes(message)).toString("base64url"),
    ).toBe(signedFixture.canonicalBytes);
    expect(verifyFixtureSignature(message, signedFixture.publicKey)).toBe(true);
  });

  it("produces the control fixture signature from the locked TypeScript seed", async () => {
    const signedFixture = (await fixture("signed-control-message.json")) as {
      publicKey: string;
      canonicalBytes: string;
      message: unknown;
    };
    const message = AgentMessageSchema.parse(signedFixture.message);
    const seed = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

    expect(
      Buffer.from(canonicalUnsignedBytes(message)).toString("base64url"),
    ).toBe(signedFixture.canonicalBytes);
    expect(signFixture(message, seed)).toBe(message.signature);
  });
});

function verifyFixtureSignature(
  message: ReturnType<typeof AgentMessageSchema.parse>,
  publicKey: string,
): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, "base64url")]),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    agentMessageSigningBytes(message),
    key,
    Buffer.from(message.signature, "base64url"),
  );
}

function signFixture(
  message: ReturnType<typeof AgentMessageSchema.parse>,
  seed: Uint8Array,
): string {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, agentMessageSigningBytes(message), key).toString(
    "base64url",
  );
}
