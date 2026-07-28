import Fastify, { type FastifyInstance } from "fastify";
import type { AuthContextProvider } from "./auth-context.js";
import type { JobRepository } from "./modules/agent-gateway/job-repository.js";
import {
  AgentGatewayAuthError,
  AgentMessageAuthenticator,
  type Ed25519MessageSigner,
} from "./modules/agent-gateway/message-signer.js";
import {
  AgentGatewayError,
  registerAgentPollingRoutes,
} from "./modules/agent-gateway/polling-routes.js";
import { registerAgentGatewayWebSocket } from "./modules/agent-gateway/websocket.js";
import {
  EnvironmentConflictError,
  HierarchyNotFoundError,
  ProjectLimitError,
  type HierarchyStore,
} from "./hierarchy-store.js";
import { TenantHierarchyUseCases } from "@forgetops/application/tenant-hierarchy";
import { registerEnvironmentRoutes } from "./modules/environments/routes.js";
import {
  PairingError,
  PairingService,
} from "./modules/agents/pairing-service.js";
import { registerAgentRoutes } from "./modules/agents/routes.js";
import { registerProjectRoutes } from "./modules/projects/routes.js";
import { registerTenantRoutes } from "./modules/tenants/routes.js";

export interface AppOptions {
  authProvider: AuthContextProvider;
  store: HierarchyStore;
  pairingService?: PairingService;
  agentGateway?: {
    repository: JobRepository;
    controlSigner: Ed25519MessageSigner;
    now?: () => Date;
    wait?: (milliseconds: number) => Promise<void>;
    scanIntervalMs?: number;
    heartbeatIntervalMs?: number;
    idleTimeoutMs?: number;
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const dependencies = {
    authProvider: options.authProvider,
    hierarchy: new TenantHierarchyUseCases(options.store),
  };
  const agentGateway = options.agentGateway;
  const agentAuthenticator = agentGateway
    ? new AgentMessageAuthenticator(agentGateway.repository, {
        now: agentGateway.now,
      })
    : undefined;

  if (agentGateway && agentAuthenticator) {
    registerAgentGatewayWebSocket(app, {
      repository: agentGateway.repository,
      authenticator: agentAuthenticator,
      controlSigner: agentGateway.controlSigner,
      now: agentGateway.now,
      scanIntervalMs: agentGateway.scanIntervalMs,
      heartbeatIntervalMs: agentGateway.heartbeatIntervalMs,
      idleTimeoutMs: agentGateway.idleTimeoutMs,
    });
    registerAgentPollingRoutes(app, {
      repository: agentGateway.repository,
      authenticator: agentAuthenticator,
      controlSigner: agentGateway.controlSigner,
      now: agentGateway.now,
      wait: agentGateway.wait,
    });
  }

  registerTenantRoutes(app, dependencies);
  registerProjectRoutes(app, dependencies);
  registerEnvironmentRoutes(app, dependencies);
  if (options.pairingService) {
    registerAgentRoutes(app, {
      authProvider: options.authProvider,
      pairingService: options.pairingService,
    });
  }
  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof AgentGatewayAuthError ||
      error instanceof AgentGatewayError
    ) {
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.message));
    }
    if (error instanceof PairingError) {
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.message));
    }
    if (error instanceof ProjectLimitError) {
      return reply.code(422).send(errorResponse(error.code, error.message));
    }
    if (error instanceof EnvironmentConflictError) {
      return reply.code(409).send(errorResponse(error.code, error.message));
    }
    if (error instanceof HierarchyNotFoundError) {
      return reply
        .code(404)
        .send(errorResponse(error.code, "Resource not found"));
    }
    if (isValidationError(error)) {
      return reply
        .code(400)
        .send(errorResponse("VALIDATION_ERROR", error.message));
    }
    throw error;
  });

  return app;
}

export const createApp = buildApp;

function errorResponse(code: string, message: string) {
  return { error: { code, message } };
}

function isValidationError(
  error: unknown,
): error is { validation: unknown; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    "message" in error &&
    typeof error.message === "string"
  );
}
