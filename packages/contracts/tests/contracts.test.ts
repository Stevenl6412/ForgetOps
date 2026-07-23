import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AgentMessageSchema,
  ExecutionAuthorizationClaimsSchema,
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
    expect(authorization.planVersion).toBe(3);
    expect(authorization.planFingerprint).toBe("sha256:plan-v3-sanitized");
  });
});
