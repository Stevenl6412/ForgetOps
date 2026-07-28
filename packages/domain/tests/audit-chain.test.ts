import { describe, expect, it } from "vitest";
import {
  auditEventHash,
  buildChain,
  verifyChain,
} from "../src/privacy-request/index.js";

function event(action: string) {
  return {
    id: `event_${action}`,
    tenantId: "tenant_1",
    environmentId: "env_1",
    sequence: action === "created" ? "1" : "2",
    requestId: "req_1",
    actorType: "system" as const,
    actorId: "forgetops-domain",
    action,
    metadata: { status: action },
    createdAt: "2026-07-24T00:00:00.000Z",
  };
}

describe("audit hash chain", () => {
  it("detects a modified event payload", () => {
    const chain = buildChain([event("created"), event("planning")]);
    expect(verifyChain(chain)).toEqual({ valid: true });
    chain[0]!.metadata.status = "executing";
    expect(verifyChain(chain)).toEqual({
      valid: false,
      brokenAt: "event_created",
    });
  });

  it("uses the domain-separated known vector", () => {
    expect(
      auditEventHash(null, {
        id: "01900000-0000-7000-8000-000000000001",
        tenantId: "tenant_hash_vector",
        environmentId: "env_hash_vector",
        sequence: "1",
        requestId: "req_hash_vector",
        actorType: "system",
        actorId: "forgetops-domain",
        action: "PrivacyRequestCreated",
        metadata: {
          requestId: "req_hash_vector",
          environmentId: "env_hash_vector",
          type: "delete",
          source: "admin",
          policyVersion: 1,
        },
        createdAt: "2026-07-23T08:00:00.000Z",
      }),
    ).toBe("4c77a2f81002ee10cfe5fb906b6bcea81c084ce591f9dfc95b41b987e513e26f");
  });
});
