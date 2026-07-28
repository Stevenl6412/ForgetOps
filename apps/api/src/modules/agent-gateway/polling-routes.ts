import { randomUUID } from "node:crypto";
import { AgentMessageSchema, type AgentMessage } from "@forgetops/contracts";
import type { FastifyInstance } from "fastify";
import type { AgentJobRecord, JobRepository } from "./job-repository.js";
import {
  AgentGatewayAuthError,
  AgentMessageAuthenticator,
  Ed25519MessageSigner,
} from "./message-signer.js";

const MAX_POLL_WAIT_MS = 45_000;

interface JobParams {
  jobId: string;
}

export type AgentGatewayErrorCode =
  "INVALID_AGENT_MESSAGE" | "JOB_LEASE_EXPIRED";

export class AgentGatewayError extends Error {
  constructor(
    readonly code: AgentGatewayErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}

export interface AgentPollingDependencies {
  repository: JobRepository;
  authenticator: AgentMessageAuthenticator;
  controlSigner: Ed25519MessageSigner;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export function registerAgentPollingRoutes(
  app: FastifyInstance,
  dependencies: AgentPollingDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  app.post<{ Body: unknown }>("/v1/agent-jobs/poll", async (request, reply) => {
    const message = parseMessage(request.body, "agent.poll");
    const waitMs = parsePollPayload(message.payload);
    const agent = await dependencies.authenticator.authenticate(message);
    await claimPollingTransport(
      dependencies.repository,
      agent,
      message.messageId,
      now(),
    );
    let job = await dependencies.repository.poll({
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      environmentId: agent.environmentId,
      now: now().toISOString(),
    });
    if (!job && waitMs > 0) {
      await wait(waitMs);
      ensurePollingTransport(
        await dependencies.repository.isTransportActive({
          tenantId: agent.tenantId,
          agentId: agent.agentId,
          environmentId: agent.environmentId,
          transport: "polling",
          sessionId: message.messageId,
          now: now().toISOString(),
        }),
      );
      job = await dependencies.repository.poll({
        tenantId: agent.tenantId,
        agentId: agent.agentId,
        environmentId: agent.environmentId,
        now: now().toISOString(),
      });
    }
    if (!job) return reply.code(204).send();
    const response = await signedResponse(
      dependencies,
      agent.tenantId,
      agent.agentId,
      agent.environmentId,
      "job.available",
      jobPayload(job),
      now(),
    );
    return reply.send({ message: response });
  });

  app.post<{ Params: JobParams; Body: unknown }>(
    "/v1/agent-jobs/:jobId/lease",
    async (request, reply) => {
      const message = parseMessage(request.body, "job.lease");
      requirePayloadJobId(message.payload, request.params.jobId);
      const agent = await dependencies.authenticator.authenticate(message);
      await claimPollingTransport(
        dependencies.repository,
        agent,
        message.messageId,
        now(),
      );
      const job = await dependencies.repository.lease({
        tenantId: agent.tenantId,
        jobId: request.params.jobId,
        agentId: agent.agentId,
        environmentId: agent.environmentId,
        now: now().toISOString(),
      });
      if (!job) throw leaseExpired();
      const response = await signedResponse(
        dependencies,
        agent.tenantId,
        agent.agentId,
        agent.environmentId,
        "job.leased",
        jobPayload(job),
        now(),
      );
      return reply.send({ message: response });
    },
  );

  app.post<{ Params: JobParams; Body: unknown }>(
    "/v1/agent-jobs/:jobId/heartbeat",
    async (request, reply) => {
      const message = parseMessage(request.body, "job.heartbeat");
      requirePayloadJobId(message.payload, request.params.jobId);
      const agent = await dependencies.authenticator.authenticate(message);
      await claimPollingTransport(
        dependencies.repository,
        agent,
        message.messageId,
        now(),
      );
      const job = await dependencies.repository.heartbeat({
        tenantId: agent.tenantId,
        jobId: request.params.jobId,
        agentId: agent.agentId,
        environmentId: agent.environmentId,
        now: now().toISOString(),
      });
      if (!job) throw leaseExpired();
      const response = await signedResponse(
        dependencies,
        agent.tenantId,
        agent.agentId,
        agent.environmentId,
        "job.lease_extended",
        jobPayload(job),
        now(),
      );
      return reply.send({ message: response });
    },
  );
}

export async function signedJobAvailable(
  dependencies: Pick<AgentPollingDependencies, "repository" | "controlSigner">,
  job: AgentJobRecord,
  agentId: string,
  sentAt: Date,
): Promise<AgentMessage> {
  return signedResponse(
    dependencies,
    job.tenantId,
    agentId,
    job.environmentId,
    "job.available",
    jobPayload(job),
    sentAt,
  );
}

function parseMessage(body: unknown, expectedType: string): AgentMessage {
  const parsed = AgentMessageSchema.safeParse(body);
  if (!parsed.success || parsed.data.messageType !== expectedType) {
    throw new AgentGatewayError(
      "INVALID_AGENT_MESSAGE",
      "The signed agent message is invalid for this endpoint",
      400,
    );
  }
  return parsed.data;
}

function parsePollPayload(payload: unknown): number {
  if (!isObject(payload)) return invalidMessage();
  const waitMs = payload.waitMs;
  if (
    typeof waitMs !== "number" ||
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > MAX_POLL_WAIT_MS
  ) {
    return invalidMessage();
  }
  return waitMs;
}

function requirePayloadJobId(payload: unknown, jobId: string): void {
  if (!isObject(payload) || payload.jobId !== jobId) invalidMessage();
}

function invalidMessage(): never {
  throw new AgentGatewayError(
    "INVALID_AGENT_MESSAGE",
    "The signed agent message payload is invalid",
    400,
  );
}

function leaseExpired(): AgentGatewayError {
  return new AgentGatewayError(
    "JOB_LEASE_EXPIRED",
    "The job is unavailable or its lease has expired",
    409,
  );
}

async function signedResponse(
  dependencies: Pick<AgentPollingDependencies, "repository" | "controlSigner">,
  tenantId: string,
  agentId: string,
  environmentId: string,
  messageType: string,
  payload: unknown,
  sentAt: Date,
): Promise<AgentMessage> {
  const sequence = await dependencies.repository.nextControlSequence(
    tenantId,
    agentId,
  );
  return dependencies.controlSigner.sign({
    type: "forgetops.agent-message",
    protocolVersion: "1.0",
    messageType,
    messageId: `msg_${randomUUID()}`,
    keyId: dependencies.controlSigner.keyId,
    environmentId,
    agentId,
    direction: "control_to_agent",
    sequence,
    sentAt: sentAt.toISOString(),
    payload,
  });
}

function jobPayload(job: AgentJobRecord) {
  return {
    jobId: job.id,
    requestId: job.requestId,
    environmentId: job.environmentId,
    kind: job.kind,
    planVersion: job.planVersion,
    payloadCiphertext: job.payloadCiphertext,
    authorization: job.authorization,
    availableAt: job.availableAt,
    expiresAt: job.expiresAt,
    attempt: job.attempt,
    leaseExpiresAt: job.leaseExpiresAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function claimPollingTransport(
  repository: JobRepository,
  agent: { tenantId: string; agentId: string; environmentId: string },
  sessionId: string,
  now: Date,
): Promise<void> {
  await repository.claimTransport({
    tenantId: agent.tenantId,
    agentId: agent.agentId,
    environmentId: agent.environmentId,
    transport: "polling",
    sessionId,
    now: now.toISOString(),
  });
  ensurePollingTransport(
    await repository.isTransportActive({
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      environmentId: agent.environmentId,
      transport: "polling",
      sessionId,
      now: now.toISOString(),
    }),
  );
}

function ensurePollingTransport(active: boolean): void {
  if (!active) {
    throw new AgentGatewayAuthError(
      "AUTH_REPLAY_DETECTED",
      "The agent transport session is no longer active",
      409,
    );
  }
}
