import { randomBytes } from "node:crypto";
import websocket from "@fastify/websocket";
import { AgentMessageSchema } from "@forgetops/contracts";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { JobRepository } from "./job-repository.js";
import {
  AgentGatewayAuthError,
  AgentMessageAuthenticator,
  Ed25519MessageSigner,
} from "./message-signer.js";
import { signedJobAvailable } from "./polling-routes.js";

const CHALLENGE_TTL_MS = 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

export interface AgentWebSocketDependencies {
  repository: JobRepository;
  authenticator: AgentMessageAuthenticator;
  controlSigner: Ed25519MessageSigner;
  now?: () => Date;
  scanIntervalMs?: number;
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
}

export function registerAgentGatewayWebSocket(
  app: FastifyInstance,
  dependencies: AgentWebSocketDependencies,
): void {
  app.register(async (gateway) => {
    await gateway.register(websocket, {
      options: { maxPayload: 64 * 1024 },
    });
    gateway.get(
      "/v1/agent-stream",
      { websocket: true },
      (socket: WebSocket) => {
        const now = dependencies.now ?? (() => new Date());
        const challenge = randomBytes(32).toString("base64url");
        const challengeExpiresAt = now().getTime() + CHALLENGE_TTL_MS;
        let lastActivityAt = now().getTime();
        let authenticated:
          | {
              tenantId: string;
              agentId: string;
              environmentId: string;
              sessionId: string;
            }
          | undefined;
        let helloProcessing = false;
        let challengeConsumed = false;
        let scanTimer: NodeJS.Timeout | undefined;

        const heartbeatTimer = setInterval(() => {
          if (
            now().getTime() - lastActivityAt >
            (dependencies.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
          ) {
            socket.close(1001, "agent connection idle");
            return;
          }
          if (socket.readyState === 1) socket.ping();
        }, dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref();

        socket.on("pong", () => {
          lastActivityAt = now().getTime();
        });
        socket.on("close", () => {
          clearInterval(heartbeatTimer);
          if (scanTimer) clearInterval(scanTimer);
          if (authenticated) {
            void dependencies.repository
              .releaseTransport({
                tenantId: authenticated.tenantId,
                agentId: authenticated.agentId,
                environmentId: authenticated.environmentId,
                transport: "websocket",
                sessionId: authenticated.sessionId,
                now: now().toISOString(),
              })
              .catch(() => undefined);
          }
        });
        socket.on("message", (raw: RawData) => {
          lastActivityAt = now().getTime();
          if (helloProcessing || authenticated) {
            socket.close(1008, "unexpected agent message");
            return;
          }
          helloProcessing = true;
          void authenticateHello(raw)
            .catch((error: unknown) => {
              const reason =
                error instanceof AgentGatewayAuthError
                  ? error.code
                  : "INVALID_AGENT_MESSAGE";
              socket.close(1008, reason);
            })
            .finally(() => {
              helloProcessing = false;
            });
        });

        socket.send(
          JSON.stringify({
            protocolVersion: "1.0",
            messageType: "connection.challenge",
            challenge,
            expiresAt: new Date(challengeExpiresAt).toISOString(),
          }),
        );

        async function authenticateHello(raw: RawData): Promise<void> {
          if (challengeConsumed || now().getTime() > challengeExpiresAt) {
            throw new Error("Connection challenge expired");
          }
          const parsedJson: unknown = JSON.parse(raw.toString());
          const parsed = AgentMessageSchema.safeParse(parsedJson);
          if (
            !parsed.success ||
            parsed.data.messageType !== "agent.hello" ||
            !isObject(parsed.data.payload) ||
            parsed.data.payload.challenge !== challenge
          ) {
            throw new Error("Invalid agent hello");
          }
          const agent = await dependencies.authenticator.authenticate(
            parsed.data,
          );
          challengeConsumed = true;
          authenticated = {
            tenantId: agent.tenantId,
            agentId: agent.agentId,
            environmentId: agent.environmentId,
            sessionId: challenge,
          };
          const transport = {
            tenantId: agent.tenantId,
            agentId: agent.agentId,
            environmentId: agent.environmentId,
            transport: "websocket" as const,
            sessionId: challenge,
            now: now().toISOString(),
          };
          await dependencies.repository.claimTransport(transport);
          if (!(await dependencies.repository.isTransportActive(transport))) {
            throw new AgentGatewayAuthError(
              "AUTH_REPLAY_DETECTED",
              "The agent transport session is no longer active",
              409,
            );
          }
          await sendAvailableJob(socket, authenticated, dependencies, now());

          scanTimer = setInterval(() => {
            if (!authenticated || socket.readyState !== 1) return;
            void sendAvailableJob(
              socket,
              authenticated,
              dependencies,
              now(),
            ).catch(() => socket.close(1011, "job delivery failed"));
          }, dependencies.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
          scanTimer.unref();
        }
      },
    );
  });
}

async function sendAvailableJob(
  socket: WebSocket,
  agent: {
    tenantId: string;
    agentId: string;
    environmentId: string;
    sessionId: string;
  },
  dependencies: AgentWebSocketDependencies,
  now: Date,
): Promise<void> {
  const active = await dependencies.repository.isTransportActive({
    tenantId: agent.tenantId,
    agentId: agent.agentId,
    environmentId: agent.environmentId,
    transport: "websocket",
    sessionId: agent.sessionId,
    now: now.toISOString(),
  });
  if (!active) {
    socket.close(1001, "agent transport handed off");
    return;
  }
  const job = await dependencies.repository.poll({
    tenantId: agent.tenantId,
    agentId: agent.agentId,
    environmentId: agent.environmentId,
    now: now.toISOString(),
  });
  if (!job || socket.readyState !== 1) return;
  const message = await signedJobAvailable(
    dependencies,
    job,
    agent.agentId,
    now,
  );
  socket.send(JSON.stringify({ message }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
