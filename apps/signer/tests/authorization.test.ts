import { describe, expect, it } from "vitest";
import {
  AuthorizationPolicyError,
  AuthorizationSigner,
  ExecutionLeaseSigner,
  verifyDomainSeparatedJcs,
} from "../src/index.js";

const now = new Date("2026-07-24T00:00:00.000Z");

function state(overrides: Record<string, unknown> = {}) {
  return {
    request: {
      id: "req_1",
      environmentId: "env_1",
      version: 7,
      policyVersion: 1,
      status: "awaiting_approval",
      ...((overrides.request as object | undefined) ?? {}),
    },
    plan: {
      id: "plan_1",
      version: 2,
      fingerprint: "sha256:plan",
      connectorConfigurationFingerprint: "sha256:connector",
      stepIds: ["step_1", "step_2"],
      requiresApproval: true,
      ...((overrides.plan as object | undefined) ?? {}),
    },
    approval: {
      evidenceHash: "sha256:evidence",
      decidedBy: "reviewer_1",
      decidedAt: now.toISOString(),
      requestVersion: 7,
      planVersion: 2,
      planFingerprint: "sha256:plan",
      ...((overrides.approval as object | undefined) ?? {}),
    },
    agent: {
      id: "agent_1",
      environmentId: "env_1",
      status: "online" as const,
      ...((overrides.agent as object | undefined) ?? {}),
    },
    executionPaused: false,
    ...overrides,
  };
}

describe("isolated authorization signer", () => {
  it("rejects stale request versions and signs exact step scope", async () => {
    const signer = AuthorizationSigner.fromSeed(
      new Uint8Array(32).fill(7),
      { getAuthorizationState: () => state() },
      { keyId: "ed25519:auth", now: () => now },
    );

    await expect(
      signer.authorize({
        requestId: "req_1",
        actorId: "admin_1",
        expectedRequestVersion: 6,
        requestedStepIds: ["step_1"],
      }),
    ).rejects.toMatchObject({ code: "REQUEST_VERSION_MISMATCH" });

    const signed = await signer.authorize({
      requestId: "req_1",
      actorId: "admin_1",
      expectedRequestVersion: 7,
      requestedStepIds: ["step_1"],
      ttlMs: 60_000,
    });
    expect(signed.claims.allowedStepIds).toEqual(["step_1"]);
    expect(
      verifyDomainSeparatedJcs(
        "forgetops.execution-authorization.v1",
        signed.claims,
        signed.signature,
        signer.publicKey(),
      ),
    ).toBe(true);
  });

  it("enforces approval separation and global pause", async () => {
    const paused = AuthorizationSigner.fromSeed(
      new Uint8Array(32).fill(8),
      { getAuthorizationState: () => state({ executionPaused: true }) },
      { keyId: "ed25519:auth", now: () => now },
    );
    await expect(
      paused.authorize({
        requestId: "req_1",
        actorId: "admin_1",
        expectedRequestVersion: 7,
        requestedStepIds: ["step_1"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationPolicyError);

    const signer = AuthorizationSigner.fromSeed(
      new Uint8Array(32).fill(9),
      { getAuthorizationState: () => state() },
      { keyId: "ed25519:auth", now: () => now },
    );
    await expect(
      signer.authorize({
        requestId: "req_1",
        actorId: "reviewer_1",
        expectedRequestVersion: 7,
        requestedStepIds: ["step_1"],
      }),
    ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTY_VIOLATION" });
  });

  it("caps execution leases at ninety seconds and binds scope", async () => {
    const authorizationSigner = AuthorizationSigner.fromSeed(
      new Uint8Array(32).fill(10),
      { getAuthorizationState: () => state() },
      { keyId: "ed25519:auth", now: () => now },
    );
    const authorization = await authorizationSigner.authorize({
      requestId: "req_1",
      actorId: "admin_1",
      expectedRequestVersion: 7,
      requestedStepIds: ["step_1"],
    });
    const leaseSigner = ExecutionLeaseSigner.fromSeed(
      new Uint8Array(32).fill(10),
      {
        keyId: "ed25519:lease",
        now: () => now,
      },
    );
    await expect(
      leaseSigner.issue({
        authorization: authorization.claims,
        state: state(),
        requestedStepIds: ["step_1"],
        ttlMs: 90_001,
      }),
    ).rejects.toThrow("EXECUTION_LEASE_TTL_INVALID");
  });
});
