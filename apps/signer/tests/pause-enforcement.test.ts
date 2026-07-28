import { describe, expect, it } from "vitest";
import { AuthorizationSigner } from "../src/authorization-signer.js";

describe("signer pause enforcement", () => {
  it("refuses authorization while execution is paused", async () => {
    const signer = AuthorizationSigner.fromSeed(
      new Uint8Array(32).fill(1),
      {
        getAuthorizationState: () => ({
          request: {
            id: "req_1",
            environmentId: "env_1",
            version: 1,
            policyVersion: 1,
            status: "planning",
          },
          plan: {
            id: "plan_1",
            version: 1,
            fingerprint: "sha256:plan",
            connectorConfigurationFingerprint: "sha256:connector",
            stepIds: ["step_1"],
            requiresApproval: false,
          },
          approval: null,
          agent: {
            id: "agent_1",
            environmentId: "env_1",
            status: "online",
          },
          executionPaused: true,
        }),
      },
      { keyId: "auth_key" },
    );
    await expect(
      signer.authorize({
        requestId: "req_1",
        actorId: "admin_1",
        expectedRequestVersion: 1,
        requestedStepIds: ["step_1"],
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_GLOBALLY_PAUSED" });
  });
});
