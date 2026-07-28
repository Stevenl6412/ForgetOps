import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileNonceStore,
  MemoryNonceStore,
  createForgetOpsAdapter,
  randomAdapterNonce,
  signAdapterRequest,
  type ResourceDefinition,
} from "../src/index.js";

const NOW = new Date("2026-07-24T08:00:00.000Z");
const SECRET = new TextEncoder().encode("s".repeat(32));
const resource: ResourceDefinition = {
  name: "documents",
  capabilities: ["discover", "export", "delete", "verify"],
  async discover() {
    return { estimatedCount: 1, proposedAction: "delete", risk: "medium" };
  },
  async export({ writer }) {
    await writer.json("documents/records.json", [{ id: "record_1" }]);
    return { exportedCount: 1 };
  },
  async erase({ operationKey }) {
    return {
      operationKey,
      affectedCount: 1,
      outcome: "deleted",
    };
  },
  async verify() {
    return { satisfied: true, remainingCount: 0 };
  },
};

describe("createForgetOpsAdapter", () => {
  it("rejects an unsigned erase request", async () => {
    const adapter = createTestAdapter();
    const response = await adapter.inject({
      method: "POST",
      url: "/forgetops/v1/erase",
      payload: validErasePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it("persists a consumed nonce across adapter restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgetops-adapter-"));
    const nonceFile = join(directory, "nonces.jsonl");
    const payload = validErasePayload();
    const headers = signedHeaders("/forgetops/v1/erase", payload);
    const erase = vi.fn(resource.erase);
    const configuredResource = { ...resource, erase };

    const first = createForgetOpsAdapter({
      resources: [configuredResource],
      secret: SECRET,
      nonceStore: new FileNonceStore(nonceFile),
      now: () => NOW,
    });
    expect(
      (
        await first.inject({
          method: "POST",
          url: "/forgetops/v1/erase",
          payload,
          headers,
        })
      ).statusCode,
    ).toBe(200);

    const restarted = createForgetOpsAdapter({
      resources: [configuredResource],
      secret: SECRET,
      nonceStore: new FileNonceStore(nonceFile),
      now: () => NOW,
    });
    expect(
      (
        await restarted.inject({
          method: "POST",
          url: "/forgetops/v1/erase",
          payload,
          headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(erase).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "expired timestamp",
      signPath: "/forgetops/v1/erase",
      timestamp: "2026-07-24T07:58:59.999Z",
    },
    {
      name: "path substitution",
      signPath: "/forgetops/v1/health",
      timestamp: NOW.toISOString(),
    },
    {
      name: "method substitution",
      signPath: "/forgetops/v1/erase",
      signMethod: "GET",
      timestamp: NOW.toISOString(),
    },
  ])("rejects $name", async ({ signPath, signMethod, timestamp }) => {
    const adapter = createTestAdapter();
    const payload = validErasePayload();
    const response = await adapter.inject({
      method: "POST",
      url: "/forgetops/v1/erase",
      payload,
      headers: signedHeaders(signPath, payload, {
        timestamp,
        method: signMethod,
      }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a request body above the configured bound", async () => {
    const adapter = createTestAdapter({ maxPayloadBytes: 16 });
    const response = await adapter.inject({
      method: "POST",
      url: "/forgetops/v1/discover",
      payload: { subject: { userId: "x".repeat(100) } },
    });
    expect(response.statusCode).toBe(413);
  });

  it("returns exports as bounded NDJSON frames", async () => {
    const adapter = createTestAdapter({ maxFrameBytes: 1024 });
    const payload = {
      subject: { userId: "user_target" },
      selection: { resources: ["documents"] },
    };
    const response = await adapter.inject({
      method: "POST",
      url: "/forgetops/v1/export",
      payload,
      headers: signedHeaders("/forgetops/v1/export", payload),
    });
    const frames = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; path?: string });
    expect(response.statusCode).toBe(200);
    expect(frames).toEqual([
      expect.objectContaining({
        type: "data",
        path: "documents/records.json",
      }),
      { type: "complete", exportedCount: 1 },
    ]);
  });
});

function createTestAdapter(
  limits: { maxPayloadBytes?: number; maxFrameBytes?: number } = {},
) {
  return createForgetOpsAdapter({
    resources: [resource],
    secret: SECRET,
    nonceStore: new MemoryNonceStore(),
    now: () => NOW,
    ...limits,
  });
}

function validErasePayload() {
  return {
    subject: { userId: "user_target" },
    resource: "documents",
    plan: { operationKey: "op_1", action: "delete" as const },
    context: {
      requestId: "req_1",
      attemptId: "attempt_1",
      stepId: "step_1",
      idempotencyKey: "req_1:step_1",
      dryRun: false,
    },
  };
}

function signedHeaders(
  path: string,
  payload: unknown,
  overrides: { timestamp?: string; nonce?: string; method?: string } = {},
): Record<string, string> {
  const timestamp = overrides.timestamp ?? NOW.toISOString();
  const nonce = overrides.nonce ?? randomAdapterNonce();
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return {
    "x-forgetops-timestamp": timestamp,
    "x-forgetops-nonce": nonce,
    "x-forgetops-signature": signAdapterRequest({
      secret: SECRET,
      method: overrides.method ?? "POST",
      normalizedPath: path,
      timestamp,
      nonce,
      contentType: "application/json",
      body,
    }),
  };
}
