import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@forgetops/contracts";
import WebSocket, { type RawData } from "ws";
import { buildApp } from "../src/app.js";
import { InMemoryHierarchyStore } from "../src/hierarchy-store.js";
import { canonicalJson } from "../src/modules/agent-gateway/canonical-json.js";
import type {
  AgentJobRecord,
  ClaimAgentMessageInput,
  EnqueueAgentJobInput,
  GatewayAgentIdentity,
  JobRepository,
  AgentTransportInput,
} from "../src/modules/agent-gateway/job-repository.js";
import {
  Ed25519MessageSigner,
  verifyAgentMessage,
} from "../src/modules/agent-gateway/message-signer.js";

interface SignedFixture {
  publicKey: string;
  message: AgentMessage;
}

const NOW = new Date("2026-07-23T08:00:00.000Z");
const agentSigner = Ed25519MessageSigner.fromSeed(
  Buffer.alloc(32, 5),
  "agent-key-gateway",
);
const controlSigner = Ed25519MessageSigner.fromSeed(
  Buffer.alloc(32, 6),
  "control-key-gateway",
);

describe("signed agent messages", () => {
  it("canonicalizes equivalent objects identically", () => {
    expect(canonicalJson({ z: [3, { b: false, a: 1 }], a: "value" })).toBe(
      '{"a":"value","z":[3,{"a":1,"b":false}]}',
    );
  });

  it("verifies the committed Rust-compatible signature fixture", async () => {
    const fixture = await readFixture("signed-agent-message.json");

    expect(verifyAgentMessage(fixture.message, fixture.publicKey)).toBe(true);
    expect(
      verifyAgentMessage(
        {
          ...fixture.message,
          payload: { ...asObject(fixture.message.payload), waitMs: 1 },
        },
        fixture.publicKey,
      ),
    ).toBe(false);
  });
});

describe("agent gateway transports", () => {
  it("rejects an agent message with the wrong direction or key ID", async () => {
    const repository = new FakeJobRepository(agentSigner.publicKey());
    const app = testApp(repository);

    const wrongDirection = agentSigner.sign({
      type: "forgetops.agent-message",
      protocolVersion: "1.0",
      messageType: "agent.poll",
      messageId: "msg_wrong_direction",
      keyId: agentSigner.keyId,
      environmentId: "env_gateway",
      agentId: "agt_gateway",
      direction: "control_to_agent",
      sequence: "1",
      sentAt: NOW.toISOString(),
      payload: { waitMs: 0 },
    });
    const directionResponse = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/poll",
      payload: wrongDirection,
    });
    expect(directionResponse.statusCode).toBe(401);

    const wrongKeyId = {
      ...signedRequest("agent.poll", "msg_wrong_key", "1", { waitMs: 0 }),
      keyId: "ed25519:sha256:wrong",
    };
    const keyResponse = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/poll",
      payload: wrongKeyId,
    });
    expect(keyResponse.statusCode).toBe(401);
  });

  it("authenticates polling, leasing, and heartbeat messages", async () => {
    const repository = new FakeJobRepository(agentSigner.publicKey());
    const app = testApp(repository);

    const poll = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/poll",
      payload: signedRequest("agent.poll", "msg_poll", "1", { waitMs: 0 }),
    });
    expect(poll.statusCode).toBe(200);
    const available = poll.json().message as AgentMessage;
    expect(available.messageType).toBe("job.available");
    expect(available.payload).toMatchObject({ jobId: "job_gateway" });
    expect(verifyAgentMessage(available, controlSigner.publicKey())).toBe(true);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/poll",
      payload: signedRequest("agent.poll", "msg_poll", "1", { waitMs: 0 }),
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "AUTH_REPLAY_DETECTED" },
    });

    const lease = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/job_gateway/lease",
      payload: signedRequest("job.lease", "msg_lease", "2", {
        jobId: "job_gateway",
      }),
    });
    expect(lease.statusCode).toBe(200);
    expect(lease.json().message.messageType).toBe("job.leased");

    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/agent-jobs/job_gateway/heartbeat",
      payload: signedRequest("job.heartbeat", "msg_heartbeat", "3", {
        jobId: "job_gateway",
      }),
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json().message.messageType).toBe("job.lease_extended");
  });

  it("uses a one-use challenge before WebSocket job delivery", async () => {
    const repository = new FakeJobRepository(agentSigner.publicKey());
    const app = testApp(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/agent-stream`,
    );

    try {
      const challenge = await nextJson(socket);
      expect(challenge).toMatchObject({
        messageType: "connection.challenge",
      });
      socket.send(
        JSON.stringify(
          signedRequest("agent.hello", "msg_hello", "1", {
            challenge: challenge.challenge,
          }),
        ),
      );

      const delivered = (await nextJson(socket)) as {
        message: AgentMessage;
      };
      expect(delivered.message.messageType).toBe("job.available");
      expect(
        verifyAgentMessage(delivered.message, controlSigner.publicKey()),
      ).toBe(true);
    } finally {
      socket.close();
      await app.close();
    }
  }, 15_000);

  it("invalidates the previous transport when polling takes over", async () => {
    const repository = new FakeJobRepository(agentSigner.publicKey());
    const websocketSession = {
      tenantId: "tenant_gateway",
      agentId: "agt_gateway",
      environmentId: "env_gateway",
      transport: "websocket" as const,
      sessionId: "ws-session",
      now: NOW.toISOString(),
    };
    const pollingSession = {
      ...websocketSession,
      transport: "polling" as const,
      sessionId: "poll-session",
    };

    await repository.claimTransport(websocketSession);
    expect(await repository.isTransportActive(websocketSession)).toBe(true);
    await repository.claimTransport(pollingSession);
    expect(await repository.isTransportActive(websocketSession)).toBe(false);
    expect(await repository.isTransportActive(pollingSession)).toBe(true);
  });
});

async function readFixture(name: string): Promise<SignedFixture> {
  const path = fileURLToPath(
    new URL(`../../../packages/contracts/fixtures/${name}`, import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8")) as SignedFixture;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("fixture payload must be an object");
  }
  return value as Record<string, unknown>;
}

function signedRequest(
  messageType: string,
  messageId: string,
  sequence: string,
  payload: unknown,
): AgentMessage {
  return agentSigner.sign({
    type: "forgetops.agent-message",
    protocolVersion: "1.0",
    messageType,
    messageId,
    keyId: agentSigner.keyId,
    environmentId: "env_gateway",
    agentId: "agt_gateway",
    direction: "agent_to_control",
    sequence,
    sentAt: NOW.toISOString(),
    payload,
  });
}

function testApp(repository: JobRepository) {
  return buildApp({
    authProvider: async () => null,
    store: new InMemoryHierarchyStore(),
    agentGateway: {
      repository,
      controlSigner,
      now: () => NOW,
      scanIntervalMs: 60_000,
    },
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket message timed out")),
      5_000,
    );
    socket.once("message", (data: RawData) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

class FakeJobRepository implements JobRepository {
  private lastAgentSequence = 0n;
  private controlSequence = 0n;
  private readonly messageIds = new Set<string>();
  private transportSession:
    { transport: "websocket" | "polling"; sessionId: string } | undefined;
  private job = fakeJob();

  constructor(private readonly publicSigningKey: string) {}

  async findAgentIdentity(
    agentId: string,
  ): Promise<GatewayAgentIdentity | null> {
    if (agentId !== "agt_gateway") return null;
    return {
      agentId,
      tenantId: "tenant_gateway",
      environmentId: "env_gateway",
      publicSigningKey: this.publicSigningKey,
      signingKeyId: agentSigner.keyId,
      protocolVersion: "1.0",
      status: "online",
    };
  }

  async claimAgentMessage(input: ClaimAgentMessageInput) {
    const sequence = BigInt(input.sequence);
    if (
      this.messageIds.has(input.messageId) ||
      sequence <= this.lastAgentSequence
    ) {
      return "replay" as const;
    }
    this.messageIds.add(input.messageId);
    this.lastAgentSequence = sequence;
    return "accepted" as const;
  }

  async claimTransport(input: AgentTransportInput): Promise<string | null> {
    const previous = this.transportSession?.sessionId ?? null;
    this.transportSession = {
      transport: input.transport,
      sessionId: input.sessionId,
    };
    return previous;
  }

  async isTransportActive(input: AgentTransportInput): Promise<boolean> {
    return (
      this.transportSession?.transport === input.transport &&
      this.transportSession.sessionId === input.sessionId
    );
  }

  async releaseTransport(input: AgentTransportInput): Promise<void> {
    if (await this.isTransportActive(input)) this.transportSession = undefined;
  }

  async enqueue(_input: EnqueueAgentJobInput): Promise<AgentJobRecord> {
    return this.job;
  }

  async poll(): Promise<AgentJobRecord | null> {
    return this.job;
  }

  async lease(): Promise<AgentJobRecord | null> {
    this.job = {
      ...this.job,
      leasedByAgentId: "agt_gateway",
      leaseExpiresAt: "2026-07-23T08:01:00.000Z",
      attempt: 1,
    };
    return this.job;
  }

  async heartbeat(): Promise<AgentJobRecord | null> {
    this.job = {
      ...this.job,
      leaseExpiresAt: "2026-07-23T08:01:20.000Z",
    };
    return this.job;
  }

  async nextControlSequence(
    _tenantId: string,
    _agentId: string,
  ): Promise<string> {
    this.controlSequence += 1n;
    return this.controlSequence.toString();
  }
}

function fakeJob(): AgentJobRecord {
  return {
    id: "job_gateway",
    tenantId: "tenant_gateway",
    requestId: "req_gateway",
    environmentId: "env_gateway",
    kind: "plan",
    planVersion: 1,
    payloadCiphertext: null,
    authorization: null,
    availableAt: NOW.toISOString(),
    expiresAt: "2026-07-23T09:00:00.000Z",
    leasedByAgentId: null,
    leaseExpiresAt: null,
    attempt: 0,
    completedAt: null,
    createdAt: NOW.toISOString(),
  };
}
